// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Vetrimus QR Drop authors

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSender, fromBytes, Receiver, MemorySymbolStore, MemorySegmentSink, encodeDataFrame, parseFrame,
} from '../src/index.js';

function rand(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
function lcg(seed) {
  let x = seed;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

async function run({ size, frameBytes, loss, seed, kMax, skip = 0, receiver, sender: reuse, limit = 100000, name = 'f.bin' }) {
  const data = rand(size, seed);
  const sender = reuse ?? await createSender({ source: fromBytes(data), name, frameBytes, kMax, startOffset: seed });
  const rx = receiver ?? new Receiver();
  const r = lcg(seed + 1);
  for (let i = 0; i < skip; i++) await sender.nextFrame();
  let sent = 0;
  while (!rx.complete && sent < limit) {
    const f = await sender.nextFrame();
    sent++;
    if (r() < loss) continue;
    await rx.push(f);
  }
  return { data, rx, sender, sent };
}

test('lossless small file', async () => {
  const { data, rx } = await run({ size: 1000, frameBytes: 200, loss: 0, seed: 1 });
  assert.ok(rx.complete);
  assert.deepEqual(rx.result(), data);
});

test('multi-segment file with 5% and 20% loss', async () => {
  for (const loss of [0.05, 0.2]) {
    const { data, rx, sender, sent } = await run({ size: 400000, frameBytes: 300, loss, seed: 2, kMax: 256 });
    assert.ok(sender.segmentCount > 3);
    assert.ok(rx.complete, `loss ${loss}`);
    assert.deepEqual(rx.result(), data);
    const ideal = Math.ceil(400000 / (300 - 18)) / (1 - loss);
    assert.ok(sent < ideal * 1.35 + 50, `sent ${sent} vs ideal ${ideal}`);
  }
});

test('late join: receiver starts mid-stream', async () => {
  const { data, rx } = await run({ size: 100000, frameBytes: 250, loss: 0.05, seed: 3, kMax: 128, skip: 777 });
  assert.deepEqual(rx.result(), data);
});

test('foreign QR codes and garbage are ignored', async () => {
  const data = rand(5000, 4);
  const sender = await createSender({ source: fromBytes(data), frameBytes: 200, startOffset: 4 });
  const rx = new Receiver();
  await rx.push(new TextEncoder().encode('https://example.org/'));
  const junk = rand(200, 99);
  await rx.push(junk);
  while (!rx.complete) await rx.push(await sender.nextFrame());
  assert.deepEqual(rx.result(), data);
  assert.equal(rx.stats.foreign, 2); // the URL and the random bytes
});

test('resume with a persistent store and a restarted sender', async () => {
  const store = new MemorySymbolStore();
  const sink = new MemorySegmentSink();
  const data = rand(60000, 5);
  const first = await createSender({ source: fromBytes(data), frameBytes: 250, kMax: 100, startOffset: 111 });
  let rx = new Receiver({ store, sink });
  for (let i = 0; i < 150; i++) await rx.push(await first.nextFrame());
  assert.ok(!rx.complete);

  // receiver app restarts; sender restarts with a different random offset
  rx = new Receiver({ store, sink });
  const second = await createSender({ source: fromBytes(data), frameBytes: 250, kMax: 100, startOffset: 222 });
  assert.deepEqual(second.fileId, first.fileId); // identity does not depend on the offset
  let n = 0;
  while (!rx.complete && n++ < 5000) await rx.push(await second.nextFrame());
  assert.ok(rx.complete);
  assert.deepEqual(rx.result(), data);
});

test('poisoned symbol with valid CRC is detected and the segment recovers', async () => {
  const data = rand(100000, 6);
  const sender = await createSender({ source: fromBytes(data), frameBytes: 600, kMax: 100, startOffset: 6 });
  const rx = new Receiver();
  let poisonedCount = 0;
  let n = 0;
  while (!rx.complete && n++ < 20000) {
    let f = await sender.nextFrame();
    const p = parseFrame(f);
    if (poisonedCount < 30 && p.verdict === 'ok' && p.type === 2) {
      const payload = p.payload.slice();
      payload[0] ^= 0xff;
      f = encodeDataFrame({ fileId: p.fileId, segment: p.segment, index: p.index, payload });
      poisonedCount++;
    }
    await rx.push(f);
  }
  assert.equal(poisonedCount, 30);
  assert.ok(rx.complete);
  assert.ok(rx.stats.hashFailures >= 1);
  assert.deepEqual(rx.result(), data);
});

test('manifest split over several frames', async () => {
  const data = rand(400000, 7);
  const sender = await createSender({ source: fromBytes(data), name: 'x'.repeat(200), frameBytes: 120, kMax: 64, startOffset: 7 });
  const rx = new Receiver();
  let n = 0;
  while (!rx.complete && n++ < 100000) await rx.push(await sender.nextFrame());
  assert.deepEqual(rx.result(), data);
});
