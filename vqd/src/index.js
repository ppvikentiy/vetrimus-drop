// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Vetrimus QR Drop authors

export { Rng, fmix32, symbolSeed } from './rng.js';
export { crc16 } from './crc16.js';
export { buildDegreeTable, isValidDegreeTable, sampleDegree } from './degree.js';
export { SegmentDecoder, encodeSymbol, symbolNeighbors } from './fountain.js';
export {
  DATA_OVERHEAD,
  MANIFEST_OVERHEAD,
  MAX_FILE_SIZE,
  TYPE_DATA,
  TYPE_MANIFEST,
  VERSION,
  blockLenFor,
  decodeManifestBody,
  encodeDataFrame,
  encodeManifestBody,
  encodeManifestFrame,
  fileId32,
  manifestFrames,
  parseFrame,
  planSegments,
  segmentGeometry,
} from './format.js';
export { createSender, defaultQuota, defaultSha256, fromBlob, fromBytes } from './sender.js';
export { MemorySegmentSink, MemorySymbolStore, Receiver } from './receiver.js';
