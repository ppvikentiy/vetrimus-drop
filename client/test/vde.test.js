// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMasterKey, keyToString, keyFromString, deriveFileKey, deriveMetaKey,
  encryptSegment, decryptSegment, segmentCount, ciphertextLength, plaintextLength,
  cipherSource, encryptBytes, decryptBytes, encryptMetadata, decryptMetadata,
  SEGMENT_SIZE, CIPHER_SEGMENT_SIZE, KEY_BYTES,
} from '../src/crypto/vde.js';

function rand(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

test('key string round-trips and rejects junk', () => {
  for (let i = 0; i < 50; i++) {
    const k = generateMasterKey();
    assert.equal(k.length, KEY_BYTES);
    const s = keyToString(k);
    assert.match(s, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(keyFromString(s), k);
    assert.deepEqual(keyFromString(` ${s} `), k); // trimmed
  }
  assert.equal(keyFromString(''), null);
  assert.equal(keyFromString('short'), null);
  assert.equal(keyFromString('!'.repeat(43)), null);
  assert.equal(keyFromString(keyToString(new Uint8Array(31))), null);
});

test('ciphertext/plaintext length are inverse across boundaries', () => {
  for (const n of [0, 1, 15, 16, 17, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, 3 * SEGMENT_SIZE, 3 * SEGMENT_SIZE + 123]) {
    const c = ciphertextLength(n);
    assert.equal(c, n + 16 * segmentCount(n));
    assert.equal(plaintextLength(c), n, `n=${n}`);
  }
});

test('segment encrypt/decrypt round-trip, incl. empty and partial', async () => {
  const key = await deriveFileKey(generateMasterKey(), 0);
  for (const n of [0, 1, 100, SEGMENT_SIZE]) {
    const plain = rand(n, n + 1);
    const ct = await encryptSegment(key, 0, plain, true);
    assert.equal(ct.length, n + 16);
    assert.deepEqual(await decryptSegment(key, 0, ct, true), plain);
  }
});

test('tamper, reorder, final-flag and wrong-key all fail', async () => {
  const master = generateMasterKey();
  const key = await deriveFileKey(master, 0);
  const plain = rand(5000, 7);
  const ct = await encryptSegment(key, 3, plain, false);
  const fail = (p) => assert.rejects(p);
  // flipped byte
  const bad = ct.slice(); bad[10] ^= 1;
  await fail(decryptSegment(key, 3, bad, false));
  // wrong segment index (reorder)
  await fail(decryptSegment(key, 4, ct, false));
  // wrong final flag (truncation/extension)
  await fail(decryptSegment(key, 3, ct, true));
  // wrong file key
  await fail(decryptSegment(await deriveFileKey(master, 1), 3, ct, false));
  // wrong master
  await fail(decryptSegment(await deriveFileKey(generateMasterKey(), 0), 3, ct, false));
});

test('file keys and meta key are independent', async () => {
  const master = generateMasterKey();
  const k0 = await deriveFileKey(master, 0);
  const plain = rand(32, 3);
  const ct = await encryptSegment(k0, 0, plain, true);
  await assert.rejects(decryptSegment(await deriveFileKey(master, 2), 0, ct, true));
  await assert.rejects(decryptSegment(await deriveMetaKey(master), 0, ct, true));
});

test('encryptBytes/decryptBytes round-trip across many sizes', async () => {
  const key = await deriveFileKey(generateMasterKey(), 5);
  for (const n of [0, 1, 16, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 10, 2 * SEGMENT_SIZE + 500]) {
    const plain = rand(n, n + 9);
    const ct = await encryptBytes(key, plain);
    assert.equal(ct.length, ciphertextLength(n));
    assert.deepEqual(await decryptBytes(key, ct), plain);
  }
});

test('cipherSource arbitrary range equals the full ciphertext slice', async () => {
  const key = await deriveFileKey(generateMasterKey(), 0);
  const n = 2 * SEGMENT_SIZE + 4096; // 3 segments
  const plain = rand(n, 42);
  const src = cipherSource((s, e) => plain.subarray(s, e), n, key);
  const whole = await src.read(0, src.cipherLength);
  assert.equal(whole.length, ciphertextLength(n));
  // reconstruct from arbitrary chunk boundaries (as the resumable uploader would)
  for (const chunk of [1, 7, CIPHER_SEGMENT_SIZE, CIPHER_SEGMENT_SIZE + 3, 1000003]) {
    const src2 = cipherSource((s, e) => plain.subarray(s, e), n, key);
    const parts = [];
    for (let pos = 0; pos < src2.cipherLength; pos += chunk) {
      parts.push(await src2.read(pos, Math.min(pos + chunk, src2.cipherLength)));
    }
    const joined = new Uint8Array(src2.cipherLength);
    let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    assert.deepEqual(joined, whole, `chunk=${chunk}`);
  }
  // and the whole thing decrypts back
  assert.deepEqual(await decryptBytes(key, whole), plain);
});

test('metadata block round-trips (names, sizes, thumbs)', async () => {
  const master = generateMasterKey();
  const meta = {
    v: 1,
    files: [
      { name: 'Отчёт «итог».pdf', type: 'application/pdf', size: 123456 },
      { name: 'фото.jpg', type: 'image/jpeg', size: 2000000, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(2000) },
    ],
  };
  const ct = await encryptMetadata(master, meta);
  assert.deepEqual(await decryptMetadata(master, ct), meta);
  await assert.rejects(decryptMetadata(generateMasterKey(), ct));
});
