// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Vetrimus QR Drop authors

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrame, encodeDataFrame, encodeManifestBody, decodeManifestBody, buildDegreeTable, planSegments, segmentGeometry,
} from '../src/index.js';

const fileId = Uint8Array.from([1, 2, 3, 4, 5, 6]);

test('data frame roundtrip and verdicts', () => {
  const payload = Uint8Array.from({ length: 40 }, (_, i) => i);
  const f = encodeDataFrame({ fileId, segment: 513, index: 0xfedcba98, payload });
  const p = parseFrame(f);
  assert.equal(p.verdict, 'ok');
  assert.equal(p.segment, 513);
  assert.equal(p.index, 0xfedcba98);
  assert.deepEqual([...p.payload], [...payload]);

  const bad = f.slice();
  bad[20] ^= 1;
  assert.equal(parseFrame(bad).verdict, 'corrupt');
  assert.equal(parseFrame(new TextEncoder().encode('https://example.org')).verdict, 'foreign');
  assert.equal(parseFrame(new Uint8Array(0)).verdict, 'foreign');
  const v2 = f.slice();
  v2[2] = 2;
  assert.deepEqual(parseFrame(v2), { verdict: 'unsupported-version', version: 2 });
  assert.equal(parseFrame(f.subarray(0, 10)).verdict, 'corrupt');
});

test('manifest roundtrip and validation', () => {
  const K = 100;
  const blockLen = 100;
  const fileSize = 250000;
  const { segmentCount } = planSegments(fileSize, blockLen, K);
  const m = {
    blockLen, K: planSegments(fileSize, blockLen, K).K, fileSize, table: buildDegreeTable(planSegments(fileSize, blockLen, K).K),
    name: 'файл.bin', mime: 'application/octet-stream',
    segmentHashes: Array.from({ length: segmentCount }, (_, i) => new Uint8Array(32).fill(i)),
  };
  const body = encodeManifestBody(m);
  const d = decodeManifestBody(body);
  assert.equal(d.name, 'файл.bin');
  assert.equal(d.fileSize, fileSize);
  assert.equal(d.segmentCount, segmentCount);

  assert.throws(() => decodeManifestBody(body.subarray(0, body.length - 1)));
  const flagged = body.slice();
  flagged[1] = 1;
  assert.throws(() => decodeManifestBody(flagged), /flags/);
  assert.throws(() => decodeManifestBody(body, { maxFileSize: 1000 }), /size/);
});

test('segment planning is balanced and covers the file', () => {
  for (const [size, bl, kmax] of [[1, 100, 2048], [150e6, 2935, 2048], [3e6, 1447, 2048], [999999, 77, 64], [2048 * 100 + 1, 100, 2048]]) {
    const { K, segmentCount } = planSegments(size, bl, kmax);
    assert.ok(K <= kmax);
    let covered = 0;
    let minK = Infinity;
    for (let s = 0; s < segmentCount; s++) {
      const g = segmentGeometry({ blockLen: bl, fileSize: size, segmentCount }, s);
      assert.ok(g.K <= K);
      assert.equal(g.start, covered);
      covered += g.length;
      minK = Math.min(minK, g.K);
    }
    assert.equal(covered, size);
    assert.ok(K - minK <= 1, 'segments are even');
  }
});
