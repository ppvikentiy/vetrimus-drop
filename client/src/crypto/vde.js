// SPDX-License-Identifier: Apache-2.0
// Vetrimus Drop Encryption v1 (VDE1): client-side end-to-end encryption.
//
// One random 256-bit master key per drop. It lives only in the share link's fragment (after '#'),
// so it never reaches the server. From it we derive, with HKDF-SHA-256, an independent AES-256-GCM
// key for the metadata block and one per file. Each file (and the metadata block) is encrypted as a
// sequence of fixed-size segments; the server stores and serves only ciphertext.
//
// Per segment: AES-256-GCM over SEG_SIZE bytes of plaintext (the last segment may be shorter).
//   nonce = 4 zero bytes || uint64 big-endian segment index   (unique: each file has its own key)
//   aad   = 1 byte: 1 for the final segment, else 0            (truncation/extension is detected)
// A wrong key, a reordered, duplicated, dropped or appended segment, or a file swapped in from
// another drop all fail decryption: the derived key depends on the file index, the nonce on the
// segment index, and the aad on whether the segment is last.

const SEG_SIZE = 1024 * 1024; // 1 MiB of plaintext per segment
const TAG_SIZE = 16; // AES-GCM authentication tag
const CT_SEG = SEG_SIZE + TAG_SIZE; // ciphertext bytes for a full segment
export const SEGMENT_SIZE = SEG_SIZE;
export const CIPHER_SEGMENT_SIZE = CT_SEG;
export const KEY_BYTES = 32;

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export function generateMasterKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// URL-safe base64 without padding, for the link fragment.
export function keyToString(key) {
  let s = '';
  for (const b of key) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function keyFromString(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+$/.test(s)) return null;
  let bin;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  if (bin.length !== KEY_BYTES) return null;
  const out = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 (with padding) for the metadata block carried in JSON. Binary-safe for large inputs. */
export function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hkdf(master, info) {
  const base = await subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** AES-GCM key for file number `index` (0-based) of this drop. */
export const deriveFileKey = (master, index) => hkdf(master, `vde1 file ${index >>> 0}`);
/** AES-GCM key for the drop's metadata block (names, sizes, thumbnails). */
export const deriveMetaKey = (master) => hkdf(master, 'vde1 meta');

function nonce(segmentIndex) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, segmentIndex >>> 0);
  return iv;
}
const aad = (isFinal) => Uint8Array.of(isFinal ? 1 : 0);

/** Encrypts one plaintext segment. Returns ciphertext (plaintext length + 16). */
export async function encryptSegment(key, segmentIndex, plain, isFinal) {
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce(segmentIndex), additionalData: aad(isFinal) }, key, plain);
  return new Uint8Array(ct);
}

/** Decrypts one ciphertext segment. Throws if it was tampered with, reordered or truncated. */
export async function decryptSegment(key, segmentIndex, cipher, isFinal) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce(segmentIndex), additionalData: aad(isFinal) }, key, cipher);
  return new Uint8Array(pt);
}

/** Number of segments a plaintext of this length occupies (at least one, so empty data still authenticates). */
export function segmentCount(plainLength) {
  return Math.max(1, Math.ceil(plainLength / SEG_SIZE));
}

/** Ciphertext length for a plaintext of `plainLength` bytes. */
export function ciphertextLength(plainLength) {
  return plainLength + TAG_SIZE * segmentCount(plainLength);
}

/** Plaintext length recovered from a ciphertext length (inverse of ciphertextLength). */
export function plaintextLength(cipherLength) {
  const full = Math.floor(cipherLength / CT_SEG);
  const rest = cipherLength - full * CT_SEG;
  if (rest === 0) return full * SEG_SIZE; // exact multiple: last segment is full
  return full * SEG_SIZE + (rest - TAG_SIZE);
}

/**
 * Lazily turns a source of plaintext into ciphertext for resumable upload. The uploader works in
 * ciphertext coordinates (that is what the server stores); this reads only the plaintext segments a
 * requested ciphertext range needs, encrypts them, and returns exactly that slice.
 *
 * @param {(start:number,end:number)=>Promise<Uint8Array>|Uint8Array} readPlain reads plaintext bytes [start,end)
 * @param {number} plainLength total plaintext length
 * @param {CryptoKey} key file (or metadata) key
 */
export function cipherSource(readPlain, plainLength, key) {
  const segs = segmentCount(plainLength);
  const cipherLength = ciphertextLength(plainLength);
  const cache = new Map(); // small LRU-ish cache so sequential chunk reads don't re-encrypt boundaries
  async function segment(i) {
    if (cache.has(i)) return cache.get(i);
    const start = i * SEG_SIZE;
    const end = Math.min(start + SEG_SIZE, plainLength);
    const plain = await readPlain(start, end);
    const ct = await encryptSegment(key, i, plain, i === segs - 1);
    if (cache.size > 4) cache.clear();
    cache.set(i, ct);
    return ct;
  }
  return {
    cipherLength,
    /** Ciphertext bytes [cStart, cEnd). */
    async read(cStart, cEnd) {
      const out = new Uint8Array(cEnd - cStart);
      let pos = cStart;
      while (pos < cEnd) {
        const i = Math.floor(pos / CT_SEG);
        const segStart = i * CT_SEG;
        const ct = await segment(i);
        const within = pos - segStart;
        const take = Math.min(ct.length - within, cEnd - pos);
        out.set(ct.subarray(within, within + take), pos - cStart);
        pos += take;
      }
      return out;
    },
  };
}

/** Encrypts a whole byte array (used for the metadata block). */
export async function encryptBytes(key, plain) {
  const src = cipherSource((s, e) => plain.subarray(s, e), plain.length, key);
  return src.read(0, src.cipherLength);
}

/** Decrypts a whole ciphertext byte array (inverse of encryptBytes). */
export async function decryptBytes(key, cipher) {
  const segs = Math.max(1, Math.ceil(cipher.length / CT_SEG));
  const out = [];
  for (let i = 0; i < segs; i++) {
    const start = i * CT_SEG;
    const end = Math.min(start + CT_SEG, cipher.length);
    out.push(await decryptSegment(key, i, cipher.subarray(start, end), i === segs - 1));
  }
  let total = 0;
  for (const p of out) total += p.length;
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    buf.set(p, o);
    o += p.length;
  }
  return buf;
}

/** Encrypts and packs the drop's metadata object (one segmented block). */
export async function encryptMetadata(master, meta) {
  return encryptBytes(await deriveMetaKey(master), te.encode(JSON.stringify(meta)));
}

export async function decryptMetadata(master, cipher) {
  const bytes = await decryptBytes(await deriveMetaKey(master), cipher);
  return JSON.parse(new TextDecoder().decode(bytes));
}
