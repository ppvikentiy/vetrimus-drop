// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Vetrimus QR Drop authors

import { crc16 } from './crc16.js';
import { isValidDegreeTable } from './degree.js';

export const MAGIC = [0x56, 0x51]; // "VQ"
export const VERSION = 1;
export const TYPE_MANIFEST = 1;
export const TYPE_DATA = 2;

export const FILE_ID_BYTES = 6;
export const DATA_HEADER = 16; // magic2 version1 type1 fileId6 segment2 index4
export const DATA_OVERHEAD = DATA_HEADER + 2; // + CRC-16
export const MANIFEST_HEADER = 12; // magic2 version1 type1 fileId6 part1 parts1
export const MANIFEST_OVERHEAD = MANIFEST_HEADER + 2;

export const MAX_K = 4096;
export const MIN_BLOCK_LEN = 16;
/** Sanity limit enforced by receivers; the format itself does not impose one. */
export const MAX_FILE_SIZE = 256 * 1024 * 1024;
export const MAX_NAME_BYTES = 255;

export const FLAG_GZIP = 0x01; // reserved, MUST be 0 in version 1

/** @param {number} frameBytes total bytes carried by one QR frame @returns {number} */
export function blockLenFor(frameBytes) {
  return frameBytes - DATA_OVERHEAD;
}

export function fileId32(fileId) {
  return ((fileId[0] << 24) | (fileId[1] << 16) | (fileId[2] << 8) | fileId[3]) >>> 0;
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

/* ----------------------------------------------------------------------------------------- */
/* Frames                                                                                     */
/* ----------------------------------------------------------------------------------------- */

function sealFrame(buf) {
  const c = crc16(buf, 0, buf.length - 2);
  buf[buf.length - 2] = c >>> 8;
  buf[buf.length - 1] = c & 0xff;
  return buf;
}

/** @param {{fileId: Uint8Array, segment: number, index: number, payload: Uint8Array}} f */
export function encodeDataFrame({ fileId, segment, index, payload }) {
  const buf = new Uint8Array(DATA_OVERHEAD + payload.length);
  buf[0] = MAGIC[0];
  buf[1] = MAGIC[1];
  buf[2] = VERSION;
  buf[3] = TYPE_DATA;
  buf.set(fileId, 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(10, segment);
  dv.setUint32(12, index >>> 0);
  buf.set(payload, DATA_HEADER);
  return sealFrame(buf);
}

/** @param {{fileId: Uint8Array, part: number, parts: number, body: Uint8Array}} f */
export function encodeManifestFrame({ fileId, part, parts, body }) {
  const buf = new Uint8Array(MANIFEST_OVERHEAD + body.length);
  buf[0] = MAGIC[0];
  buf[1] = MAGIC[1];
  buf[2] = VERSION;
  buf[3] = TYPE_MANIFEST;
  buf.set(fileId, 4);
  buf[10] = part;
  buf[11] = parts;
  buf.set(body, MANIFEST_HEADER);
  return sealFrame(buf);
}

/**
 * Classifies and parses a decoded QR payload.
 *
 * verdict: 'ok' | 'foreign' (not ours: stay silent, the camera sees every QR code in view)
 *        | 'unsupported-version' (ours, but a version we cannot read: tell the user to update)
 *        | 'corrupt' (ours, failed its CRC or is malformed: indistinguishable from a bad read)
 */
export function parseFrame(bytes) {
  if (bytes.length < 4 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return { verdict: 'foreign' };
  if (bytes[2] !== VERSION) return { verdict: 'unsupported-version', version: bytes[2] };
  const type = bytes[3];
  const minLen = type === TYPE_DATA ? DATA_OVERHEAD : type === TYPE_MANIFEST ? MANIFEST_OVERHEAD : Infinity;
  if (bytes.length < minLen) return { verdict: 'corrupt' };
  const stored = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (stored !== crc16(bytes, 0, bytes.length - 2)) return { verdict: 'corrupt' };
  const fileId = bytes.slice(4, 4 + FILE_ID_BYTES);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === TYPE_DATA) {
    return {
      verdict: 'ok',
      type,
      fileId,
      segment: dv.getUint16(10),
      index: dv.getUint32(12),
      payload: bytes.subarray(DATA_HEADER, bytes.length - 2),
    };
  }
  const part = bytes[10];
  const parts = bytes[11];
  if (parts === 0 || part >= parts) return { verdict: 'corrupt' };
  return { verdict: 'ok', type, fileId, part, parts, body: bytes.subarray(MANIFEST_HEADER, bytes.length - 2) };
}

/* ----------------------------------------------------------------------------------------- */
/* Manifest                                                                                   */
/* ----------------------------------------------------------------------------------------- */

/**
 * Manifest body, big-endian:
 *   u8   manifest version (1)
 *   u8   flags (0 in version 1)
 *   u16  blockLen
 *   u16  K            blocks per full segment
 *   u32  segmentCount
 *   u32  fileSize high, u32 fileSize low
 *   u8   degreeTableLength, then that many u16 thresholds
 *   u8   nameLength,  name bytes (UTF-8)
 *   u8   mimeLength,  mime bytes (ASCII)
 *   segmentCount * 32 bytes: SHA-256 of each segment's real bytes
 *
 * @param {{blockLen:number,K:number,fileSize:number,table:Uint16Array,name:string,mime:string,segmentHashes:Uint8Array[],flags?:number}} m
 */
export function encodeManifestBody(m) {
  const name = te.encode(m.name).slice(0, MAX_NAME_BYTES);
  const mime = te.encode(m.mime).slice(0, MAX_NAME_BYTES);
  const size = 1 + 1 + 2 + 2 + 4 + 8 + 1 + m.table.length * 2 + 1 + name.length + 1 + mime.length + m.segmentHashes.length * 32;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let o = 0;
  buf[o++] = 1;
  buf[o++] = m.flags ?? 0;
  dv.setUint16(o, m.blockLen); o += 2;
  dv.setUint16(o, m.K); o += 2;
  dv.setUint32(o, m.segmentHashes.length); o += 4;
  dv.setUint32(o, Math.floor(m.fileSize / 0x100000000)); o += 4;
  dv.setUint32(o, m.fileSize >>> 0); o += 4;
  buf[o++] = m.table.length;
  for (const t of m.table) { dv.setUint16(o, t); o += 2; }
  buf[o++] = name.length;
  buf.set(name, o); o += name.length;
  buf[o++] = mime.length;
  buf.set(mime, o); o += mime.length;
  for (const h of m.segmentHashes) { buf.set(h, o); o += 32; }
  return buf;
}

/**
 * Parses and validates a manifest body. Throws on anything inconsistent: manifests arrive from
 * a camera and must never be trusted to size an allocation.
 */
export function decodeManifestBody(buf, { maxFileSize = MAX_FILE_SIZE } = {}) {
  const fail = (why) => {
    throw new Error(`invalid manifest: ${why}`);
  };
  if (buf.length < 24) fail('too short');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const version = buf[o++];
  if (version !== 1) fail(`unsupported manifest version ${version}`);
  const flags = buf[o++];
  if (flags !== 0) fail('unsupported flags');
  const blockLen = dv.getUint16(o); o += 2;
  const K = dv.getUint16(o); o += 2;
  const segmentCount = dv.getUint32(o); o += 4;
  const hi = dv.getUint32(o); o += 4;
  const lo = dv.getUint32(o); o += 4;
  if (hi > 0x1fffff) fail('file size out of range');
  const fileSize = hi * 0x100000000 + lo;
  if (blockLen < MIN_BLOCK_LEN) fail('block length too small');
  if (K < 1 || K > MAX_K) fail('K out of range');
  if (fileSize < 1 || fileSize > maxFileSize) fail('file size out of range');
  if (segmentCount !== Math.ceil(Math.ceil(fileSize / blockLen) / K)) fail('segment count inconsistent');
  const tableLen = buf[o++];
  if (o + tableLen * 2 + 2 > buf.length) fail('truncated');
  const table = new Uint16Array(tableLen);
  for (let i = 0; i < tableLen; i++) { table[i] = dv.getUint16(o); o += 2; }
  if (!isValidDegreeTable(table, K)) fail('bad degree table');
  const nameLen = buf[o++];
  if (o + nameLen + 1 > buf.length) fail('truncated');
  let name;
  try { name = td.decode(buf.subarray(o, o + nameLen)); } catch { fail('name is not UTF-8'); }
  o += nameLen;
  const mimeLen = buf[o++];
  if (o + mimeLen > buf.length) fail('truncated');
  let mime;
  try { mime = td.decode(buf.subarray(o, o + mimeLen)); } catch { fail('mime is not UTF-8'); }
  o += mimeLen;
  if (buf.length - o !== segmentCount * 32) fail('segment hash list length');
  const segmentHashes = [];
  for (let i = 0; i < segmentCount; i++) { segmentHashes.push(buf.slice(o, o + 32)); o += 32; }
  return { blockLen, K, segmentCount, fileSize, table, name, mime, segmentHashes, flags };
}

/** Splits a manifest body over as many frames as needed. */
export function manifestFrames(fileId, body, frameBytes) {
  const cap = frameBytes - MANIFEST_OVERHEAD;
  const parts = Math.max(1, Math.ceil(body.length / cap));
  if (parts > 255) throw new Error('manifest does not fit in 255 frames');
  const frames = [];
  for (let i = 0; i < parts; i++) {
    frames.push(encodeManifestFrame({ fileId, part: i, parts, body: body.subarray(i * cap, Math.min(body.length, (i + 1) * cap)) }));
  }
  return frames;
}

/**
 * The file is cut into totalBlocks = ceil(fileSize / blockLen) blocks and those into segmentCount
 * segments of nearly equal size: the first (totalBlocks mod segmentCount) segments hold one block more
 * than the rest, so block counts differ by at most one and never exceed K (the manifest's K is the
 * larger of the two). Returns the byte range and block count of segment s.
 * @param {{fileSize:number, blockLen:number, segmentCount:number}} m
 */
export function segmentGeometry(m, s) {
  const total = Math.ceil(m.fileSize / m.blockLen);
  const base = Math.floor(total / m.segmentCount);
  const extra = total % m.segmentCount;
  const first = s * base + Math.min(s, extra);
  const blocks = base + (s < extra ? 1 : 0);
  const start = first * m.blockLen;
  const length = Math.min(blocks * m.blockLen, m.fileSize - start);
  return { start, length, K: blocks };
}

/** Chooses (K, segmentCount) for a file: as few segments as possible with at most kMax blocks each, balanced. */
export function planSegments(fileSize, blockLen, kMax) {
  const total = Math.ceil(fileSize / blockLen);
  let n = Math.ceil(total / kMax);
  for (;;) {
    const K = Math.ceil(total / n);
    const n2 = Math.ceil(total / K);
    if (n2 === n) return { K, segmentCount: n };
    n = n2;
  }
}

/** First 6 bytes of SHA-256(body): the stream identity carried in every frame. */
export async function computeFileId(body, sha256) {
  return (await sha256(body)).slice(0, FILE_ID_BYTES);
}
