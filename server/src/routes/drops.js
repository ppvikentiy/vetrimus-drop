import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { HttpError, asyncHandler } from '../errors.js';
import { abortMultipart, completeMultipart, listParts, startMultipart, uploadPart, uploadStream } from '../s3.js';
import { UUID_RE, hashPassword, randomToken, safeEqual, sha256Hex } from '../security.js';
import { destroyDrop } from '../cleanup.js';
import { attachPairing, publishPairing } from './pair.js';

const { maxFiles, maxFileSize, maxDownloads, maxPasswordLength } = config.limits;
const PENDING_TTL = '6 hours';
const MAX_THUMB_BYTES = 40 * 1024;
const THUMB_PREFIX = 'data:image/jpeg;base64,';
const MULTIPART_MIN = 5 * 1024 * 1024;
const MAX_CHUNK = 32 * 1024 * 1024;

export const dropsRouter = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много раздач. Попробуйте позже.' },
});

function sanitizeName(name) {
  const clean = name
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .trim()
    .slice(0, 200);
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

// Thumbnails are small JPEGs rendered by the uploader's browser, so recipients can preview
// files without the server ever exposing full content outside the download limit.
function parseThumb(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.startsWith(THUMB_PREFIX)) throw new HttpError(400, 'Некорректное превью');
  const buf = Buffer.from(value.slice(THUMB_PREFIX.length), 'base64');
  if (buf.length < 3 || buf.length > MAX_THUMB_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new HttpError(400, 'Некорректное превью');
  }
  return buf;
}

// End-to-end encrypted drops add ~16 bytes per MiB of ciphertext overhead; allow a small margin.
const MAX_CIPHERTEXT_SIZE = maxFileSize + 1024 * 1024;
const MAX_META_BYTES = 2 * 1024 * 1024; // encrypted names + thumbnails for up to 10 files

function validateCreate(body) {
  const { files, expiry, maxDownloads: downloads, password, enc } = body ?? {};
  const encrypted = enc === true;

  if (!Array.isArray(files) || files.length < 1 || files.length > maxFiles) {
    throw new HttpError(400, `Можно загрузить от 1 до ${maxFiles} файлов`);
  }
  const limit = encrypted ? MAX_CIPHERTEXT_SIZE : maxFileSize;
  for (const f of files) {
    if (!encrypted && (typeof f?.name !== 'string' || f.name.length === 0)) {
      throw new HttpError(400, 'Некорректное имя файла');
    }
    if (!Number.isSafeInteger(f?.size) || f.size < 0) {
      throw new HttpError(400, 'Некорректный размер файла');
    }
    if (f.size > limit) {
      throw new HttpError(400, encrypted ? 'Файл больше 500 МБ' : `Файл «${f.name}» больше 500 МБ`);
    }
  }
  if (!Object.hasOwn(config.expiryDays, expiry)) {
    throw new HttpError(400, 'Некорректный срок хранения');
  }
  if (!Number.isInteger(downloads) || downloads < 1 || downloads > maxDownloads) {
    throw new HttpError(400, `Число скачиваний должно быть от 1 до ${maxDownloads}`);
  }
  if (password != null && password !== '') {
    if (typeof password !== 'string' || password.length > maxPasswordLength) {
      throw new HttpError(400, 'Некорректный пароль');
    }
  }

  let metaCt = null;
  if (encrypted) {
    if (typeof body.meta !== 'string') throw new HttpError(400, 'Отсутствует зашифрованное описание');
    metaCt = Buffer.from(body.meta, 'base64');
    if (metaCt.length < 16 || metaCt.length > MAX_META_BYTES) throw new HttpError(400, 'Некорректное зашифрованное описание');
  }

  return {
    enc: encrypted,
    metaCt,
    // Encrypted drops hold no plaintext name or thumbnail; the server only sees ciphertext sizes.
    files: files.map((f, i) =>
      encrypted ? { name: `file-${i}`, size: f.size, thumb: null } : { name: sanitizeName(f.name), size: f.size, thumb: parseThumb(f.thumb) },
    ),
    expiryDays: config.expiryDays[expiry],
    maxDownloads: downloads,
    password: password || null,
  };
}

dropsRouter.post(
  '/',
  createLimiter,
  express.json({ limit: '3mb' }),
  asyncHandler(async (req, res) => {
    const input = validateCreate(req.body);
    const pairCode = req.body.pairCode ?? null;
    // A drop sent to a computer by code is opened there without a password prompt.
    if (pairCode && input.password) throw new HttpError(400, 'При отправке на компьютер пароль не используется');
    const dropId = randomUUID();
    const uploadSecret = randomToken();
    const passwordHash = input.password ? await hashPassword(input.password) : null;

    const files = input.files.map((f, position) => {
      const id = randomUUID();
      return { id, position, ...f, s3Key: `drops/${dropId}/${id}` };
    });

    await withTransaction(async (db) => {
      await db.query(
        `INSERT INTO drops (id, upload_secret_hash, password_hash, expiry_days, max_downloads, expires_at, enc, meta_ct)
         VALUES ($1, $2, $3, $4, $5, now() + interval '${PENDING_TTL}', $6, $7)`,
        [dropId, sha256Hex(uploadSecret), passwordHash, input.expiryDays, input.maxDownloads, input.enc, input.metaCt],
      );
      if (pairCode) await attachPairing(db, pairCode, dropId);
      for (const f of files) {
        await db.query(
          'INSERT INTO files (id, drop_id, position, name, size, s3_key, thumb) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [f.id, dropId, f.position, f.name, f.size, f.s3Key, f.thumb],
        );
      }
    });

    res.status(201).json({
      dropId,
      uploadSecret,
      files: files.map(({ id, name, size }) => ({ id, name, size })),
    });
  }),
);

async function loadPendingDrop(req) {
  const { dropId } = req.params;
  const secret = req.get('x-upload-secret');
  if (!UUID_RE.test(dropId) || !secret) throw new HttpError(404, 'Раздача не найдена');

  const { rows } = await query(
    `SELECT id, upload_secret_hash FROM drops
     WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
    [dropId],
  );
  const drop = rows[0];
  if (!drop || !safeEqual(drop.upload_secret_hash, sha256Hex(secret))) {
    throw new HttpError(404, 'Раздача не найдена');
  }
  return drop;
}

async function loadPendingFile(req) {
  const drop = await loadPendingDrop(req);
  const { fileId } = req.params;
  if (!UUID_RE.test(fileId)) throw new HttpError(404, 'Файл не найден');
  const { rows } = await query(
    'SELECT id, size, s3_key, uploaded, uploaded_bytes, s3_upload_id FROM files WHERE id = $1 AND drop_id = $2',
    [fileId, drop.id],
  );
  const file = rows[0];
  if (!file) throw new HttpError(404, 'Файл не найден');
  return { drop, file };
}

// Where this file's byte stream currently stands and whether chunking is required for the next write.
dropsRouter.get(
  '/:dropId/files/:fileId/status',
  asyncHandler(async (req, res) => {
    const { file } = await loadPendingFile(req);
    res.json({
      size: Number(file.size),
      uploadedBytes: Number(file.uploaded_bytes),
      uploaded: file.uploaded,
      minChunk: MULTIPART_MIN,
      maxChunk: MAX_CHUNK,
    });
  }),
);

// Chunks arrive as PUT with Content-Range. The client guarantees start == uploadedBytes, and chunks
// of at least MULTIPART_MIN (except the final one) so S3 multipart will accept them.
dropsRouter.put(
  '/:dropId/files/:fileId',
  asyncHandler(async (req, res) => {
    const { file } = await loadPendingFile(req);
    const size = Number(file.size);
    const length = Number(req.get('content-length'));
    if (!Number.isInteger(length) || length < 0) throw new HttpError(400, 'Отсутствует Content-Length');

    // A repeat of a file we already have (retry of a background upload) is a success.
    // Drain the body so the connection is not left hanging.
    if (file.uploaded) {
      req.resume();
      return res.json({ uploadedBytes: size, uploaded: true });
    }

    const uploaded = Number(file.uploaded_bytes);
    const rangeHeader = req.get('content-range');
    let start;
    let end;
    if (rangeHeader) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rangeHeader);
      if (!match) throw new HttpError(400, 'Некорректный Content-Range');
      start = Number(match[1]);
      end = Number(match[2]);
      if (Number(match[3]) !== size) throw new HttpError(400, 'Размер файла не совпадает с заявленным');
      if (end - start + 1 !== length) throw new HttpError(400, 'Content-Range не совпадает с Content-Length');
    } else {
      if (length !== size) throw new HttpError(400, 'Размер файла не совпадает с заявленным');
      start = 0;
      end = size - 1;
    }

    if (end >= size) throw new HttpError(400, 'Диапазон выходит за размер файла');
    const isFinal = end + 1 === size;
    const wholeFile = start === 0 && isFinal;
    // Partial chunks are buffered in memory for one S3 part, so they stay capped.
    // A whole-file body is streamed and may be as large as the drop allows.
    if (!wholeFile && length > MAX_CHUNK) throw new HttpError(400, 'Кусок слишком большой');
    // S3 rejects parts smaller than 5 MiB (except the final one). The server refuses them up front
    // so the client doesn't waste bytes.
    if (!isFinal && length < MULTIPART_MIN) {
      throw new HttpError(400, `Кусок должен быть не меньше ${MULTIPART_MIN} байт (кроме последнего)`);
    }

    if (wholeFile) {
      if (file.s3_upload_id) {
        await abortMultipart(file.s3_key, file.s3_upload_id).catch(() => {});
        await query('UPDATE files SET s3_upload_id = NULL, uploaded_bytes = 0 WHERE id = $1', [file.id]);
      }
      await uploadStream(file.s3_key, req, size);
      await query('UPDATE files SET uploaded = true, uploaded_bytes = $2, s3_upload_id = NULL WHERE id = $1', [file.id, size]);
      return res.json({ uploadedBytes: size, uploaded: true });
    }

    if (start !== uploaded) {
      return res.status(409).json({ error: 'Смещение не совпадает', uploadedBytes: uploaded });
    }

    let uploadId = file.s3_upload_id;
    if (!uploadId) {
      uploadId = await startMultipart(file.s3_key);
      await query('UPDATE files SET s3_upload_id = $2 WHERE id = $1', [file.id, uploadId]);
    }

    const existingParts = await listParts(file.s3_key, uploadId);
    const partNumber = existingParts.length + 1;
    if (partNumber > 10000) throw new HttpError(400, 'Слишком много кусков');

    try {
      await uploadPart(file.s3_key, uploadId, partNumber, req, length);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'Ошибка при загрузке куска');
    }

    const newUploaded = start + length;
    const uploadedNow = isFinal;
    await query('UPDATE files SET uploaded_bytes = $2, uploaded = $3 WHERE id = $1', [file.id, newUploaded, uploadedNow]);
    res.json({ uploadedBytes: newUploaded, uploaded: uploadedNow });
  }),
);

dropsRouter.post(
  '/:dropId/finalize',
  asyncHandler(async (req, res) => {
    const drop = await loadPendingDrop(req);

    const { rows: pending } = await query(
      'SELECT count(*)::int AS missing FROM files WHERE drop_id = $1 AND NOT uploaded',
      [drop.id],
    );
    if (pending[0].missing > 0) throw new HttpError(400, 'Не все файлы загружены');

    // Finish any in-progress S3 multipart uploads before publishing.
    const { rows: multipart } = await query(
      'SELECT s3_key, s3_upload_id FROM files WHERE drop_id = $1 AND s3_upload_id IS NOT NULL',
      [drop.id],
    );
    for (const f of multipart) {
      const parts = await listParts(f.s3_key, f.s3_upload_id);
      if (parts.length === 0) {
        await abortMultipart(f.s3_key, f.s3_upload_id).catch(() => {});
        throw new HttpError(400, 'Нет загруженных кусков');
      }
      await completeMultipart(f.s3_key, f.s3_upload_id, parts);
    }
    if (multipart.length > 0) {
      await query('UPDATE files SET s3_upload_id = NULL WHERE drop_id = $1', [drop.id]);
    }

    // Only the hash is stored: the plaintext token exists solely in this response and the share link.
    const token = randomToken();
    const { rows } = await query(
      `UPDATE drops
       SET status = 'ready', token_hash = $2, expires_at = now() + make_interval(days => expiry_days)
       WHERE id = $1 AND status = 'pending'
       RETURNING expires_at, max_downloads`,
      [drop.id, sha256Hex(token)],
    );
    if (!rows[0]) throw new HttpError(409, 'Раздача уже опубликована');

    await publishPairing(drop.id, token);
    res.json({ token, expiresAt: rows[0].expires_at, maxDownloads: rows[0].max_downloads });
  }),
);

// The uploader deletes a pending or published drop with the same secret used to upload it.
// Objects go first; if storage refuses, the row stays so the request can be retried.
dropsRouter.delete(
  '/:dropId',
  asyncHandler(async (req, res) => {
    const { dropId } = req.params;
    const secret = req.get('x-upload-secret');
    if (!UUID_RE.test(dropId) || !secret) throw new HttpError(404, 'Раздача не найдена');

    const { rows } = await query('SELECT id, upload_secret_hash FROM drops WHERE id = $1', [dropId]);
    const drop = rows[0];
    if (!drop || !safeEqual(drop.upload_secret_hash, sha256Hex(secret))) {
      throw new HttpError(404, 'Раздача не найдена');
    }
    await destroyDrop(drop.id, { strict: true });
    res.status(204).end();
  }),
);
