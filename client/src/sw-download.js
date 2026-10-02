// SPDX-License-Identifier: Apache-2.0
// Streaming decryption of downloads inside the service worker: ciphertext is fetched from the server
// (with Range, segment by segment), decrypted in constant memory, and handed to the browser as an
// ordinary download. Several files are zipped on the fly. The key never leaves the device.
import { deriveFileKey, keyFromString, decryptSegment, CIPHER_SEGMENT_SIZE } from './crypto/vde.js';
import { downloadZip } from 'client-zip';

const plans = new Map(); // id -> plan, consumed once

// filename*=UTF-8'' per RFC 5987, plus an ASCII fallback.
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function registerDownloadMessages(self) {
  self.addEventListener('message', (event) => {
    const d = event.data;
    if (d?.type !== 'vde-prepare') return;
    plans.set(d.id, d.plan);
    // Expire the plan if the download never starts.
    setTimeout(() => plans.delete(d.id), 60000);
    event.ports?.[0]?.postMessage({ ok: true });
  });
}

const PREFIX = '/vde-dl/';
export const isDownloadRequest = (url) => url.pathname.startsWith(PREFIX);

async function fileKey(master, index) {
  return deriveFileKey(master, index);
}

// A ReadableStream of one file's plaintext, decrypted segment by segment from ranged fetches.
function decryptedStream(plan, master, file, fetchImpl = fetch) {
  const base = `/api/d/${plan.token}/files/${file.index}?key=${encodeURIComponent(plan.accessKey)}`;
  const segs = Math.max(1, Math.ceil(file.cipherSize / CIPHER_SEGMENT_SIZE));
  let key;
  let s = 0;
  return new ReadableStream({
    async start() {
      key = await fileKey(master, file.index);
    },
    async pull(controller) {
      try {
        const cs = s * CIPHER_SEGMENT_SIZE;
        const ce = Math.min(cs + CIPHER_SEGMENT_SIZE, file.cipherSize);
        const res = await fetchImpl(base, { headers: { Range: `bytes=${cs}-${ce - 1}` } });
        if (res.status !== 206 && res.status !== 200) throw new Error(`fetch ${res.status}`);
        const ct = new Uint8Array(await res.arrayBuffer());
        controller.enqueue(await decryptSegment(key, s, ct, s === segs - 1));
        if (++s >= segs) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export { decryptedStream };

export async function respondDownload(url) {
  const id = url.pathname.slice(PREFIX.length);
  const plan = plans.get(id);
  if (!plan) return new Response('Срок ссылки на скачивание истёк. Обновите страницу.', { status: 404 });
  plans.delete(id); // one-shot: a fresh id is minted per click
  const master = keyFromString(plan.master);
  if (!master) return new Response('bad key', { status: 400 });

  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  if (plan.files.length === 1 && !plan.zipName) {
    const file = plan.files[0];
    return new Response(decryptedStream(plan, master, file), {
      headers: {
        ...headers,
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.name),
        'Content-Length': String(file.plainSize),
      },
    });
  }

  // Several files: a store-only ZIP, sizes known so the browser can show a total.
  const entries = plan.files.map((file) => ({
    name: file.name,
    input: decryptedStream(plan, master, file),
    size: file.plainSize,
    lastModified: plan.lastModified ? new Date(plan.lastModified) : undefined,
  }));
  const zip = downloadZip(entries);
  return new Response(zip.body, {
    headers: {
      ...headers,
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(plan.zipName || 'files.zip'),
      ...(zip.headers.get('Content-Length') ? { 'Content-Length': zip.headers.get('Content-Length') } : {}),
    },
  });
}
