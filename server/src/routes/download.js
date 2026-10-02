import express, { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import mime from 'mime-types';
import rateLimit from 'express-rate-limit';
import { query, withTransaction } from '../db.js';
import { HttpError, asyncHandler } from '../errors.js';
import { getObjectStream } from '../s3.js';
import { TOKEN_RE, sha256Hex, signAccess, verifyAccess, verifyPassword } from '../security.js';

export const downloadRouter = Router();

const NOT_FOUND = 'Раздача не найдена, истекла или лимит скачиваний исчерпан';
const SESSION_TTL = '24 hours';
const LIMIT_REACHED = Symbol('limit');

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте через 15 минут.' },
});

async function findDrop(token, { requireDownloadsLeft }) {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await query(
    `SELECT * FROM drops
     WHERE token_hash = $1 AND status = 'ready' AND expires_at > now()
       ${requireDownloadsLeft ? 'AND download_count < max_downloads' : ''}`,
    [sha256Hex(token)],
  );
  return rows[0] ?? null;
}

async function listFiles(dropId) {
  const { rows } = await query(
    'SELECT id, name, size, s3_key, thumb IS NOT NULL AS has_thumb FROM files WHERE drop_id = $1 ORDER BY position',
    [dropId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, size: Number(r.size), s3Key: r.s3_key, hasThumb: r.has_thumb }));
}

async function dropInfo(drop) {
  const files = await listFiles(drop.id);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const common = { totalSize, expiresAt: drop.expires_at, downloadsLeft: drop.max_downloads - drop.download_count };
  if (drop.enc) {
    // Names, types and thumbnails live inside the encrypted metadata block; the client decrypts it.
    return { enc: true, meta: drop.meta_ct ? drop.meta_ct.toString('base64') : null, files: files.map(({ size }) => ({ size })), ...common };
  }
  return { enc: false, files: files.map(({ name, size, hasThumb }) => ({ name, size, thumb: hasThumb })), ...common };
}

downloadRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const drop = await findDrop(token, { requireDownloadsLeft: true });
    if (!drop) throw new HttpError(404, NOT_FOUND);
    if (drop.password_hash) return res.json({ requiresPassword: true });
    res.json({ requiresPassword: false, accessKey: signAccess(token), ...(await dropInfo(drop)) });
  }),
);

downloadRouter.post(
  '/:token/unlock',
  unlockLimiter,
  express.json({ limit: '4kb' }),
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const drop = await findDrop(token, { requireDownloadsLeft: true });
    if (!drop) throw new HttpError(404, NOT_FOUND);

    if (drop.password_hash) {
      const password = req.body?.password;
      if (typeof password !== 'string' || !(await verifyPassword(password, drop.password_hash))) {
        throw new HttpError(401, 'Неверный пароль');
      }
    }
    res.json({ accessKey: signAccess(token), ...(await dropInfo(drop)) });
  }),
);

// A session is one access key (issued per page view). Its first request consumes a download;
// later requests (resumes, other files, the browser re-requesting the download) are free for SESSION_TTL.
// Not bound to the client IP: mobile networks switch IPv4/IPv6 and addresses between requests.
async function openSession(req, drop) {
  const sessionHash = sha256Hex(req.query.key);
  try {
    return await withTransaction(async (db) => {
      const inserted = await db.query(
        'INSERT INTO download_sessions (drop_id, session_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [drop.id, sessionHash],
      );
      if (inserted.rowCount === 1) {
        const { rowCount } = await db.query(
          `UPDATE drops SET download_count = download_count + 1, last_download_at = now()
           WHERE id = $1 AND expires_at > now() AND download_count < max_downloads`,
          [drop.id],
        );
        if (rowCount === 0) throw LIMIT_REACHED;
        return { sessionHash, isNew: true };
      }
      const { rows } = await db.query(
        `SELECT 1 FROM download_sessions
         WHERE drop_id = $1 AND session_hash = $2 AND created_at > now() - interval '${SESSION_TTL}'`,
        [drop.id, sessionHash],
      );
      if (!rows[0]) throw LIMIT_REACHED;
      await db.query('UPDATE drops SET last_download_at = now() WHERE id = $1', [drop.id]);
      return { sessionHash, isNew: false };
    });
  } catch (err) {
    if (err === LIMIT_REACHED) return null;
    throw err;
  }
}

async function revertSession(drop, session) {
  if (!session.isNew) return;
  await withTransaction(async (db) => {
    await db.query('DELETE FROM download_sessions WHERE drop_id = $1 AND session_hash = $2', [
      drop.id,
      session.sessionHash,
    ]);
    await db.query('UPDATE drops SET download_count = download_count - 1 WHERE id = $1 AND download_count > 0', [
      drop.id,
    ]);
  });
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function uniqueNames(names) {
  const used = new Set();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 1; used.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

// Returns null (serve whole file), 'unsatisfiable', or { start, end }. Multi-range requests are served whole.
function parseRange(header, size) {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

function appendAndWait(archive, res, stream, name) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
      stream.off('error', onError);
      res.off('close', onClose);
    };
    const onEntry = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => onError(new Error('Client disconnected'));
    archive.on('entry', onEntry);
    archive.on('error', onError);
    stream.on('error', onError);
    res.on('close', onClose);
    archive.append(stream, { name });
  });
}

const isDisconnect = (err) => err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.message === 'Client disconnected';

async function streamWithRollback(res, drop, session, send) {
  try {
    await send();
  } catch (err) {
    if (!res.headersSent) {
      await revertSession(drop, session);
      throw err;
    }
    if (!isDisconnect(err)) console.error('[download] stream failed:', err);
    res.destroy();
  }
}

async function serveFile(req, res, drop, file) {
  const etag = `"${file.id}"`;
  const lastModified = new Date(drop.created_at).toUTCString();
  // Encrypted drops: the server does not know the real name or type. It serves opaque ciphertext;
  // the client decrypts it and gives it a name. The browser never downloads this directly.
  res.set({
    'Content-Type': drop.enc ? 'application/octet-stream' : mime.lookup(file.name) || 'application/octet-stream',
    'Content-Disposition': drop.enc ? 'attachment' : contentDisposition(file.name),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': lastModified,
    'Cache-Control': 'private, no-store',
  });

  if (req.method === 'HEAD') {
    res.set('Content-Length', String(file.size));
    return res.end();
  }

  const ifRange = req.get('if-range');
  const range = ifRange && ifRange !== etag && ifRange !== lastModified ? null : parseRange(req.get('range'), file.size);
  if (range === 'unsatisfiable') {
    return res.status(416).set('Content-Range', `bytes */${file.size}`).end();
  }

  const session = await openSession(req, drop);
  if (!session) return res.redirect(303, `/${encodeURIComponent(req.params.token)}`);

  await streamWithRollback(res, drop, session, async () => {
    const body = await getObjectStream(file.s3Key, range);
    if (range) {
      res.status(206).set({
        'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
        'Content-Length': String(range.end - range.start + 1),
      });
    } else {
      res.set('Content-Length', String(file.size));
    }
    await pipeline(body, res);
  });
}

async function serveZip(req, res, drop, files) {
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(`vetrimus-drop-${req.params.token.slice(0, 8)}.zip`),
    'Accept-Ranges': 'none',
    'Cache-Control': 'private, no-store',
  });
  if (req.method === 'HEAD') return res.end();

  const session = await openSession(req, drop);
  if (!session) return res.redirect(303, `/${encodeURIComponent(req.params.token)}`);

  await streamWithRollback(res, drop, session, async () => {
    const archive = archiver('zip', { store: true });
    const names = uniqueNames(files.map((f) => f.name));
    const first = await getObjectStream(files[0].s3Key);
    const piping = pipeline(archive, res);
    try {
      for (let i = 0; i < files.length; i++) {
        const body = i === 0 ? first : await getObjectStream(files[i].s3Key);
        await appendAndWait(archive, res, body, names[i]);
      }
      await archive.finalize();
      await piping;
    } catch (err) {
      archive.abort();
      piping.catch(() => {});
      throw err;
    }
  });
}

async function loadForDownload(req, res) {
  const { token } = req.params;
  const drop = await findDrop(token, { requireDownloadsLeft: false });
  if (!drop || !verifyAccess(token, req.query.key)) {
    res.redirect(303, `/${encodeURIComponent(token)}`);
    return null;
  }
  return { drop, files: await listFiles(drop.id) };
}

downloadRouter.get(
  '/:token/download',
  asyncHandler(async (req, res) => {
    const loaded = await loadForDownload(req, res);
    if (!loaded) return;
    const { drop, files } = loaded;
    // Encrypted drops are decrypted (and, for several files, zipped) in the recipient's browser;
    // the client fetches ciphertext via /files/:index instead of this endpoint.
    if (drop.enc) throw new HttpError(409, 'Зашифрованная раздача скачивается в браузере');
    if (files.length === 1) await serveFile(req, res, drop, files[0]);
    else await serveZip(req, res, drop, files);
  }),
);

downloadRouter.get(
  '/:token/files/:index',
  asyncHandler(async (req, res) => {
    const loaded = await loadForDownload(req, res);
    if (!loaded) return;
    const index = Number(req.params.index);
    const file = Number.isInteger(index) ? loaded.files[index] : undefined;
    if (!file) throw new HttpError(404, 'Файл не найден');
    await serveFile(req, res, loaded.drop, file);
  }),
);

downloadRouter.get(
  '/:token/thumbs/:index',
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const drop = await findDrop(token, { requireDownloadsLeft: false });
    const index = Number(req.params.index);
    if (!drop || drop.enc || !verifyAccess(token, req.query.key) || !Number.isInteger(index)) {
      throw new HttpError(404, 'Не найдено');
    }
    const { rows } = await query('SELECT thumb FROM files WHERE drop_id = $1 AND position = $2 AND thumb IS NOT NULL', [
      drop.id,
      index,
    ]);
    if (!rows[0]) throw new HttpError(404, 'Не найдено');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }).send(rows[0].thumb);
  }),
);
