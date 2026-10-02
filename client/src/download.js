// Decrypted downloads on the recipient's side. The fast path streams through the service worker so a
// 500 MB file never sits in memory; the fallback (no controlling service worker, e.g. a first visit
// or a browser that won't stream a SW response) decrypts into a Blob in the page.
import { deriveFileKey, decryptSegment, keyFromString, CIPHER_SEGMENT_SIZE } from './crypto/vde.js';

const randomId = () => crypto.getRandomValues(new Uint32Array(4)).join('-');

function clickDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function viaServiceWorker(plan) {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker.controller;
    const id = randomId();
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (e.data?.ok) {
        clickDownload(`/vde-dl/${id}`);
        resolve();
      } else reject(new Error('prepare failed'));
    };
    sw.postMessage({ type: 'vde-prepare', id, plan }, [channel.port2]);
  });
}

async function decryptToBlob(plan, master, file, onProgress) {
  const key = await deriveFileKey(master, file.index);
  const segs = Math.max(1, Math.ceil(file.cipherSize / CIPHER_SEGMENT_SIZE));
  const base = `/api/d/${plan.token}/files/${file.index}?key=${encodeURIComponent(plan.accessKey)}`;
  const parts = [];
  let done = 0;
  for (let s = 0; s < segs; s++) {
    const cs = s * CIPHER_SEGMENT_SIZE;
    const ce = Math.min(cs + CIPHER_SEGMENT_SIZE, file.cipherSize);
    const res = await fetch(base, { headers: { Range: `bytes=${cs}-${ce - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`Ошибка загрузки (${res.status})`);
    const ct = new Uint8Array(await res.arrayBuffer());
    parts.push(await decryptSegment(key, s, ct, s === segs - 1));
    done += ce - cs;
    onProgress?.(done / file.cipherSize);
  }
  return new Blob(parts, { type: file.type || 'application/octet-stream' });
}

async function fallbackDownload(plan, onProgress) {
  const master = keyFromString(plan.master);
  if (plan.files.length === 1 && !plan.zipName) {
    const file = plan.files[0];
    const blob = await decryptToBlob(plan, master, file, onProgress);
    const url = URL.createObjectURL(blob);
    clickDownload(url, file.name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const { downloadZip } = await import('client-zip');
  const entries = [];
  for (const file of plan.files) {
    const blob = await decryptToBlob(plan, master, file, onProgress);
    entries.push({ name: file.name, input: blob, lastModified: plan.lastModified ? new Date(plan.lastModified) : undefined });
  }
  const blob = await downloadZip(entries).blob();
  const url = URL.createObjectURL(blob);
  clickDownload(url, plan.zipName || 'files.zip');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Downloads and decrypts a drop (one file, or all files as a ZIP).
 * @returns {Promise<{streamed:boolean}>}
 */
export async function downloadEncrypted(plan, { onProgress } = {}) {
  if (navigator.serviceWorker?.controller) {
    try {
      await viaServiceWorker(plan);
      return { streamed: true };
    } catch {
      // service worker could not take it: fall back to in-memory decryption
    }
  }
  await fallbackDownload(plan, onProgress);
  return { streamed: false };
}
