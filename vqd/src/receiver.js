// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Vetrimus QR Drop authors

import { SegmentDecoder } from './fountain.js';
import {
  TYPE_DATA,
  TYPE_MANIFEST,
  computeFileId,
  decodeManifestBody,
  fileId32,
  parseFrame,
  segmentGeometry,
} from './format.js';
import { defaultSha256 } from './sender.js';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Where raw symbols wait until their segment can be decoded. Browsers back this with OPFS or
 * IndexedDB so that a 150 MB transfer does not live in memory; this one is the in-memory reference.
 * Keys are (fileId hex, segment), so different files never mix and a resumed transfer finds its data.
 *
 * Interface: append(fid, segment, index, payload), symbols(fid, segment) async iterable of
 * { index, payload }, drop(fid, segment); optional indices(fid, segment) and open(fid, manifest)
 * (called once a manifest is accepted, before any other call for that file).
 */
export class MemorySymbolStore {
  constructor() {
    this.map = new Map();
  }
  async append(fid, segment, index, payload) {
    const key = `${fid}:${segment}`;
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push({ index, payload: payload.slice() });
  }
  async *symbols(fid, segment) {
    for (const s of this.map.get(`${fid}:${segment}`) ?? []) yield s;
  }
  /** Indices only (optional in the interface): lets a resuming receiver rebuild its bookkeeping cheaply. */
  async indices(fid, segment) {
    return (this.map.get(`${fid}:${segment}`) ?? []).map((s) => s.index);
  }
  async drop(fid, segment) {
    this.map.delete(`${fid}:${segment}`);
  }
}

/**
 * Where verified segments go. Browsers back this with OPFS / a File System handle.
 * Interface: write(fid, segment, bytes), has(fid, segment) (may be async); optional open(fid, manifest).
 */
export class MemorySegmentSink {
  constructor() {
    this.map = new Map();
  }
  async write(fid, segment, bytes) {
    this.map.set(`${fid}:${segment}`, bytes.slice());
  }
  has(fid, segment) {
    return this.map.has(`${fid}:${segment}`);
  }
  assemble(fid, manifest) {
    const out = new Uint8Array(manifest.fileSize);
    for (let s = 0; s < manifest.segmentCount; s++) {
      const part = this.map.get(`${fid}:${s}`);
      if (!part) throw new Error(`segment ${s} missing`);
      out.set(part, segmentGeometry(manifest, s).start);
    }
    return out;
  }
}

/**
 * Feed it decoded QR payloads in any order, with any losses, from any point in the stream.
 * push() calls are serialised internally.
 */
export class Receiver {
  constructor({ store = new MemorySymbolStore(), sink = new MemorySegmentSink(), sha256 = defaultSha256, maxFileSize } = {}) {
    this.store = store;
    this.sink = sink;
    this.sha256 = sha256;
    this.maxFileSize = maxFileSize;
    this.queue = Promise.resolve();
    this.reset();
    this.stats = { frames: 0, foreign: 0, corrupt: 0, symbols: 0, duplicates: 0, hashFailures: 0, decodeAttempts: 0 };
  }

  reset() {
    this.fid = null;
    this.manifest = null;
    this.pendingManifest = null;
    this.done = null;
    this.counts = null;
    this.nextAttempt = null;
    this.seen = null;
    this.dry = null;
    this.complete = false;
  }

  /** @returns {Promise<object>} what the frame turned out to be (for UI feedback and tests) */
  push(frameBytes) {
    const result = this.queue.then(() => this.handle(frameBytes));
    this.queue = result.catch(() => {});
    return result;
  }

  get progress() {
    if (!this.manifest) return 0;
    const m = this.manifest;
    let acc = 0;
    for (let s = 0; s < m.segmentCount; s++) {
      if (this.done[s]) acc += segmentGeometry(m, s).length;
      else acc += Math.min(0.99, this.counts[s] / segmentGeometry(m, s).K) * segmentGeometry(m, s).length;
    }
    return Math.min(1, acc / m.fileSize);
  }

  get segmentsDone() {
    return this.done ? this.done.reduce((a, b) => a + b, 0) : 0;
  }

  /** The finished file; only for the in-memory sink. */
  result() {
    if (!this.complete) throw new Error('transfer not complete');
    return this.sink.assemble(this.fid, this.manifest);
  }

  async handle(frameBytes) {
    this.stats.frames++;
    const f = parseFrame(frameBytes);
    if (f.verdict === 'foreign') {
      this.stats.foreign++;
      return { kind: 'foreign' };
    }
    if (f.verdict === 'unsupported-version') return { kind: 'unsupported-version', version: f.version };
    if (f.verdict === 'corrupt') {
      this.stats.corrupt++;
      return { kind: 'corrupt' };
    }
    return f.type === TYPE_MANIFEST ? this.handleManifest(f) : this.handleData(f);
  }

  async handleManifest(f) {
    const fid = hex(f.fileId);
    if (this.manifest && fid === this.fid) return { kind: 'manifest-known' };
    if (!this.pendingManifest || this.pendingManifest.fid !== fid || this.pendingManifest.parts.length !== f.parts) {
      this.pendingManifest = { fid, parts: new Array(f.parts).fill(null) };
    }
    this.pendingManifest.parts[f.part] = f.body.slice();
    if (this.pendingManifest.parts.some((p) => p === null)) return { kind: 'manifest-part', have: this.pendingManifest.parts.filter(Boolean).length, of: f.parts };

    const parts = this.pendingManifest.parts;
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      body.set(p, o);
      o += p.length;
    }
    this.pendingManifest = null;
    if (!equalBytes(await computeFileId(body, this.sha256), f.fileId)) return { kind: 'corrupt' };
    let manifest;
    try {
      manifest = decodeManifestBody(body, this.maxFileSize ? { maxFileSize: this.maxFileSize } : undefined);
    } catch (error) {
      return { kind: 'bad-manifest', error: error.message };
    }
    this.fid = fid;
    this.manifest = manifest;
    this.id32 = fileId32(f.fileId);
    // Optional hooks: persistent stores learn the geometry before anything is read or written.
    await this.store.open?.(fid, manifest);
    if (this.sink !== this.store) await this.sink.open?.(fid, manifest);
    const n = manifest.segmentCount;
    this.done = new Array(n).fill(0);
    this.counts = new Array(n).fill(0);
    this.seen = Array.from({ length: n }, () => new Set());
    this.dry = new Array(n).fill(null);
    this.nextAttempt = Array.from({ length: n }, (_, s) => this.attemptStart(segmentGeometry(manifest, s).K));
    this.complete = false;
    for (let s = 0; s < n; s++) {
      if (await this.sink.has(fid, s)) {
        this.done[s] = 1; // resumed transfer: segment already on disk
        continue;
      }
      if (this.store.indices) {
        // resumed transfer: symbols already in the store count towards decodability
        for (const index of await this.store.indices(fid, s)) {
          this.seen[s].add(index);
          this.counts[s]++;
          this.dryFor(s).addSymbol(index, null);
        }
        this.nextAttempt[s] = Math.max(this.nextAttempt[s], this.counts[s] + 1);
      }
    }
    this.checkComplete();
    return { kind: 'manifest', fileId: fid, manifest };
  }

  attemptStep(K) {
    return K < 100 ? 1 : Math.max(2, Math.ceil(K * 0.002));
  }

  attemptStart(K) {
    return K < 100 ? K : K + this.attemptStep(K);
  }

  checkComplete() {
    if (this.done.every(Boolean)) this.complete = true;
  }

  dryFor(s) {
    if (!this.dry[s]) {
      const g = segmentGeometry(this.manifest, s);
      this.dry[s] = new SegmentDecoder({ K: g.K, blockLen: this.manifest.blockLen, table: this.manifest.table, fileId32: this.id32, segment: s, structureOnly: true });
    }
    return this.dry[s];
  }

  async handleData(f) {
    const m = this.manifest;
    if (!m || hex(f.fileId) !== this.fid) return { kind: 'data-without-manifest' };
    const s = f.segment;
    if (s >= m.segmentCount || f.payload.length !== m.blockLen) {
      this.stats.corrupt++;
      return { kind: 'corrupt' };
    }
    if (this.done[s]) return { kind: 'segment-already-done', segment: s };
    if (this.seen[s].has(f.index)) {
      this.stats.duplicates++;
      return { kind: 'duplicate' };
    }
    this.seen[s].add(f.index);
    this.stats.symbols++;
    await this.store.append(this.fid, s, f.index, f.payload);
    this.counts[s]++;
    const K = segmentGeometry(m, s).K;
    const dry = this.dryFor(s);
    dry.addSymbol(f.index, null);
    if (!dry.complete && this.counts[s] >= this.nextAttempt[s]) {
      dry.solveResidual(); // bit-level only: no payload is touched
      this.nextAttempt[s] = this.counts[s] + this.attemptStep(K);
    }
    if (dry.complete && (await this.decodeSegment(s))) {
      return { kind: 'segment-complete', segment: s, complete: this.complete };
    }
    return { kind: 'symbol', segment: s };
  }

  /** Runs once per segment, when the structure oracle says the received symbols are sufficient. */
  async decodeSegment(s) {
    const m = this.manifest;
    const g = segmentGeometry(m, s);
    this.stats.decodeAttempts++;
    const dec = new SegmentDecoder({ K: g.K, blockLen: m.blockLen, table: m.table, fileId32: this.id32, segment: s });
    for await (const sym of this.store.symbols(this.fid, s)) {
      dec.addSymbol(sym.index, sym.payload);
      if (dec.complete) break;
    }
    if (!dec.complete) dec.solveResidual();
    if (!dec.complete) return false;
    const bytes = dec.data.subarray(0, g.length);
    if (!equalBytes(await this.sha256(bytes), m.segmentHashes[s])) {
      // A symbol with a valid CRC but wrong content got through. The segment is poisoned: start it over.
      this.stats.hashFailures++;
      await this.store.drop(this.fid, s);
      this.seen[s].clear();
      this.counts[s] = 0;
      this.dry[s] = null;
      this.nextAttempt[s] = this.attemptStart(g.K);
      return false;
    }
    await this.sink.write(this.fid, s, bytes);
    await this.store.drop(this.fid, s);
    this.seen[s].clear();
    this.dry[s] = null;
    this.done[s] = 1;
    this.checkComplete();
    return true;
  }
}

export { TYPE_DATA, TYPE_MANIFEST };
