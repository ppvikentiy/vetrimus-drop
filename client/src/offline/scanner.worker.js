// Decodes camera frames and feeds them to the VQD receiver. Everything heavy lives here, off the UI thread.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { MemorySegmentSink, MemorySymbolStore, Receiver } from 'vqd';
import { OpfsStorage, opfsSupported, pruneTransfers } from './opfsStore.js';

const READ_OPTIONS = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: false,
  textMode: 'Plain',
};

let receiver = null;
let storage = null;
let mode = 'memory';
let canvas = null;
let ctx = null;
let ready = null;
let lastReport = 0;
let lastResult = null;
let unsupportedVersion = null;
const counters = { frames: 0, decoded: 0 };


async function init() {
  await prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) }, fireImmediately: true });
  if (await opfsSupported()) {
    storage = new OpfsStorage();
    mode = 'opfs';
    receiver = new Receiver({ store: storage, sink: storage });
  } else {
    mode = 'memory';
    receiver = new Receiver({ store: new MemorySymbolStore(), sink: new MemorySegmentSink() });
  }
  postMessage({ type: 'ready', storage: mode });
}

function summary() {
  const r = receiver;
  const m = r.manifest;
  return {
    type: 'status',
    frames: counters.frames,
    decoded: counters.decoded,
    symbols: r.stats.symbols,
    duplicates: r.stats.duplicates,
    hashFailures: r.stats.hashFailures,
    unsupportedVersion,
    last: lastResult,
    manifest: m
      ? { fileId: r.fid, name: m.name, mime: m.mime, size: m.fileSize, segments: m.segmentCount, blockLen: m.blockLen }
      : null,
    progress: r.progress,
    segmentsDone: m ? r.done.slice() : [],
    complete: r.complete,
  };
}

function report(force) {
  const now = performance.now();
  if (!force && now - lastReport < 200) return;
  lastReport = now;
  postMessage(summary());
}

async function decodeFrame(bitmap) {
  counters.frames++;
  // The code is shown as a square: read the central square of the frame only.
  const side = Math.min(bitmap.width, bitmap.height);
  if (!canvas || canvas.width !== side) {
    canvas = new OffscreenCanvas(side, side);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, side, side);
  bitmap.close();
  const image = ctx.getImageData(0, 0, side, side);
  const found = await readBarcodes(image, READ_OPTIONS);
  if (!found.length || !found[0].isValid) return;
  counters.decoded++;
  const previousFid = receiver.fid;
  const result = await receiver.push(found[0].bytes);
  lastResult = result.kind;
  if (result.kind === 'unsupported-version') unsupportedVersion = result.version;
  if (result.kind === 'manifest' && mode === 'opfs' && previousFid !== receiver.fid) {
    // Only one transfer is kept: a new file replaces whatever was stored before.
    await pruneTransfers(receiver.fid);
  }
  if (result.kind === 'manifest' || result.kind === 'segment-complete') report(true);
  if (receiver.complete) await finish();
}

async function finish() {
  const m = receiver.manifest;
  let file;
  if (mode === 'opfs') {
    file = await storage.file(receiver.fid, m.fileSize);
  } else {
    file = new Blob([receiver.result()]);
  }
  postMessage({ ...summary(), type: 'complete', file, name: m.name, mime: m.mime });
}

onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      ready ??= init();
      await ready;
    } else if (msg.type === 'frame') {
      await ready;
      if (receiver.complete) {
        msg.bitmap.close();
      } else {
        await decodeFrame(msg.bitmap);
        report(false);
      }
      postMessage({ type: 'idle' });
    } else if (msg.type === 'reset') {
      await ready;
      const fid = receiver.fid;
      storage?.close();
      if (mode === 'opfs') {
        storage = new OpfsStorage();
        receiver = new Receiver({ store: storage, sink: storage });
        if (msg.discard && fid) await pruneTransfers(null);
      } else {
        receiver = new Receiver({ store: new MemorySymbolStore(), sink: new MemorySegmentSink() });
      }
      unsupportedVersion = null;
      lastResult = null;
      counters.frames = 0;
      counters.decoded = 0;
      report(true);
    }
  } catch (error) {
    postMessage({ type: 'error', message: String(error?.message || error) });
    if (msg.type === 'frame') postMessage({ type: 'idle' });
  }
};

