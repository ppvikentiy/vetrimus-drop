import QRCode from 'qrcode';

// Frame sizes are the exact byte-mode capacities of QR codes at error correction level L.
export const PROFILES = [
  { id: 'max', version: 40, frameBytes: 2953, label: 'Максимум', hint: 'QR версии 40 — для хорошей камеры и яркого экрана' },
  { id: 'mid', version: 30, frameBytes: 1732, label: 'Средне', hint: 'QR версии 30 — надёжнее на средних камерах' },
  { id: 'low', version: 20, frameBytes: 858, label: 'Надёжно', hint: 'QR версии 20 — для слабой камеры или маленького экрана' },
];

export const QUIET = 4; // modules of white border required around a QR code

/**
 * Draws one frame as a QR code onto a canvas, one pixel per module (scale with CSS, image-rendering: pixelated).
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8Array} bytes
 * @param {number} version
 */
export function drawQr(canvas, bytes, version) {
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'L', version });
  const size = qr.modules.size;
  const side = size + 2 * QUIET;
  if (canvas.width !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  const ctx = canvas.getContext('2d', { alpha: false });
  const image = ctx.createImageData(side, side);
  const px = new Uint32Array(image.data.buffer);
  px.fill(0xffffffff);
  const modules = qr.modules.data;
  for (let y = 0; y < size; y++) {
    const row = (y + QUIET) * side + QUIET;
    for (let x = 0; x < size; x++) if (modules[y * size + x]) px[row + x] = 0xff000000;
  }
  ctx.putImageData(image, 0, 0);
  return side;
}
