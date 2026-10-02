async function request(method, url, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Нет соединения с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка сервера (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const createDrop = (payload) => request('POST', '/api/drops', { body: payload });

export const finalizeDrop = (dropId, secret) =>
  request('POST', `/api/drops/${dropId}/finalize`, { headers: { 'X-Upload-Secret': secret } });

// The first caller publishes the drop. A parallel caller (the page and the service worker)
// gets 409 and reads the token the winner stored in IndexedDB.
export async function claimFinalize(dropId, secret) {
  try {
    return await finalizeDrop(dropId, secret);
  } catch (err) {
    if (err.status !== 409) throw err;
    const { waitForReady } = await import('./uploadStore.js');
    const saved = await waitForReady(dropId);
    if (saved?.token) {
      return { token: saved.token, expiresAt: saved.expiresAt, maxDownloads: saved.maxDownloads };
    }
    throw new Error('Ссылка создана, но не сохранилась в браузере. Откройте страницу загрузки ещё раз.');
  }
}

// 404 means the drop is already gone — the sender's goal is met either way.
export async function deleteDrop(dropId, secret) {
  let res;
  try {
    res = await fetch(`/api/drops/${dropId}`, { method: 'DELETE', headers: { 'X-Upload-Secret': secret } });
  } catch {
    throw new Error('Нет соединения с сервером');
  }
  if (res.status === 204 || res.status === 404) return;
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.error || `Ошибка сервера (${res.status})`);
  err.status = res.status;
  throw err;
}

export const getUploadStatus = (dropId, fileId, secret) =>
  request('GET', `/api/drops/${dropId}/files/${fileId}/status`, { headers: { 'X-Upload-Secret': secret } });

// Thin wrapper around XHR so progress and abort both work. The server validates offsets.
function putChunk({ dropId, fileId, secret, blob, start, end, totalSize, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/drops/${dropId}/files/${fileId}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Secret', secret);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    xhr.upload.onprogress = (e) => onProgress?.(start + e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          return resolve(JSON.parse(xhr.responseText));
        } catch {
          return resolve({ uploadedBytes: end + 1 });
        }
      }
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON response body
      }
      const err = new Error(payload.error || `Ошибка загрузки (${xhr.status})`);
      err.status = xhr.status;
      err.uploadedBytes = payload.uploadedBytes;
      reject(err);
    };
    xhr.onerror = () => reject(Object.assign(new Error('Сетевая ошибка при загрузке'), { network: true }));
    xhr.onabort = () => reject(Object.assign(new Error('Загрузка прервана'), { aborted: true }));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

const CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function uploadFile({ dropId, fileId, secret, file, onProgress, signal }) {
  const total = file.size;
  // Ask the server first so we resume from the right offset after a reconnect or page reload.
  let uploadedBytes = 0;
  try {
    const status = await getUploadStatus(dropId, fileId, secret);
    uploadedBytes = status.uploadedBytes || 0;
    if (status.uploaded) {
      onProgress?.(total);
      return;
    }
  } catch {
    // first write to a brand-new file: status may be unavailable mid-flight; start from zero
  }
  onProgress?.(uploadedBytes);

  // Small files go in one PUT without Content-Range (keeps the server's simple-upload path).
  if (total <= MIN_CHUNK && uploadedBytes === 0) {
    let attempt = 0;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', `/api/drops/${dropId}/files/${fileId}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Upload-Secret', secret);
          xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error('fail'), { status: xhr.status, retriable: xhr.status >= 500 }));
          xhr.onerror = () => reject(Object.assign(new Error('net'), { network: true }));
          xhr.onabort = () => reject(Object.assign(new Error('abort'), { aborted: true }));
          signal?.addEventListener('abort', () => xhr.abort(), { once: true });
          xhr.send(file);
        });
        onProgress?.(total);
        return;
      } catch (err) {
        if (err.aborted || !(err.network || err.retriable) || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(30000, 1000 * 2 ** attempt++));
      }
    }
  }

  while (uploadedBytes < total) {
    const start = uploadedBytes;
    const end = Math.min(start + CHUNK_SIZE, total) - 1;
    const blob = file.slice(start, end + 1);
    let attempt = 0;
    for (;;) {
      try {
        const result = await putChunk({ dropId, fileId, secret, blob, start, end, totalSize: total, onProgress, signal });
        uploadedBytes = result.uploadedBytes;
        break;
      } catch (err) {
        if (err.aborted) throw err;
        if (err.status === 409 && typeof err.uploadedBytes === 'number') {
          // The server already has data past our starting point (duplicate PUT, resume from there).
          uploadedBytes = err.uploadedBytes;
          onProgress?.(uploadedBytes);
          break;
        }
        if (!(err.network || (err.status && err.status >= 500)) || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(30000, 1000 * 2 ** attempt++));
      }
    }
  }
  onProgress?.(total);
}

// Uploads a file as VDE1 ciphertext, resumably. The server stores and counts ciphertext bytes;
// progress is reported back in plaintext bytes so the UI's totals stay in the sizes the user sees.
export async function uploadEncryptedFile({ dropId, fileId, secret, file, key, onProgress, signal }) {
  const { cipherSource } = await import('./crypto/vde.js');
  const readPlain = async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer());
  const src = cipherSource(readPlain, file.size, key);
  const total = src.cipherLength;
  const toPlain = (cipherBytes) => Math.min(file.size, Math.round((cipherBytes / total) * file.size));

  let uploadedBytes = 0;
  try {
    const status = await getUploadStatus(dropId, fileId, secret);
    uploadedBytes = status.uploadedBytes || 0;
    if (status.uploaded) return onProgress?.(file.size);
  } catch {
    // brand-new file: start from zero
  }
  onProgress?.(toPlain(uploadedBytes));

  while (uploadedBytes < total) {
    const start = uploadedBytes;
    const end = Math.min(start + CHUNK_SIZE, total) - 1;
    const blob = await src.read(start, end + 1);
    let attempt = 0;
    for (;;) {
      try {
        const result = await putChunk({
          dropId, fileId, secret, blob, start, end, totalSize: total, signal,
          onProgress: (loaded) => onProgress?.(toPlain(loaded)),
        });
        uploadedBytes = result.uploadedBytes;
        break;
      } catch (err) {
        if (err.aborted) throw err;
        if (err.status === 409 && typeof err.uploadedBytes === 'number') {
          uploadedBytes = err.uploadedBytes;
          onProgress?.(toPlain(uploadedBytes));
          break;
        }
        if (!(err.network || (err.status && err.status >= 500)) || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(30000, 1000 * 2 ** attempt++));
      }
    }
  }
  onProgress?.(file.size);
}

export const getDrop = (token) => request('GET', `/api/d/${token}`);

export const unlockDrop = (token, password) =>
  request('POST', `/api/d/${token}/unlock`, { body: { password } });

export const downloadUrl = (token, key) => `/api/d/${token}/download?key=${encodeURIComponent(key)}`;

export const thumbUrl = (token, key, index) => `/api/d/${token}/thumbs/${index}?key=${encodeURIComponent(key)}`;

export const fileUrl =(token, key, index) => `/api/d/${token}/files/${index}?key=${encodeURIComponent(key)}`;

// ---- Pairing: a computer (no camera, no way to receive a link) waits for a phone's upload ----
export const createPairing = () => request('POST', '/api/pair');

export const getPairingStatus = (code, secret) =>
  request('GET', `/api/pair/${code}/status`, { headers: { 'X-Pair-Secret': secret } });

export const deletePairing = (code, secret) =>
  request('DELETE', `/api/pair/${code}`, { headers: { 'X-Pair-Secret': secret } });

export const checkPairCode = (code) => request('GET', `/api/pair/${code}/check`);
