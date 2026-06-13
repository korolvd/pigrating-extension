// Генератор иконок расширения без зависимостей: рисует свинку и кодирует PNG (zlib).
// Запуск: node tools/make-icons.mjs  → icons/icon16.png, icon48.png, icon128.png
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── PNG-кодер (RGBA, 8 бит) ──
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer).copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── геометрия в нормированных координатах [0..1] ──
const inRoundRect = (u, v, rad) => { const x = Math.min(u, 1 - u), y = Math.min(v, 1 - v); if (x >= rad || y >= rad) return true; const dx = rad - x, dy = rad - y; return dx * dx + dy * dy <= rad * rad; };
const inEllipse = (u, v, cx, cy, rx, ry) => { const a = (u - cx) / rx, b = (v - cy) / ry; return a * a + b * b <= 1; };
const inTri = (u, v, ax, ay, bx, by, cx, cy) => {
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

const C = { blue: [47, 128, 237], ear: [236, 122, 170], head: [255, 168, 200], snout: [240, 130, 176], nostril: [120, 50, 80], eye: [60, 30, 46] };

// цвет пикселя (верхний слой побеждает); null — прозрачный
function colorAt(u, v) {
  if (!inRoundRect(u, v, 0.18)) return null;
  let col = C.blue;
  if (inTri(u, v, 0.20, 0.36, 0.33, 0.06, 0.47, 0.34) || inTri(u, v, 0.80, 0.36, 0.67, 0.06, 0.53, 0.34)) col = C.ear;
  if (inEllipse(u, v, 0.5, 0.55, 0.38, 0.40)) col = C.head;
  if (inEllipse(u, v, 0.5, 0.66, 0.19, 0.145)) col = C.snout;
  if (inEllipse(u, v, 0.43, 0.66, 0.035, 0.06) || inEllipse(u, v, 0.57, 0.66, 0.035, 0.06)) col = C.nostril;
  if (inEllipse(u, v, 0.37, 0.46, 0.045, 0.045) || inEllipse(u, v, 0.63, 0.46, 0.045, 0.045)) col = C.eye;
  return col;
}

// рендер с суперсэмплингом ×4 и усреднением (premultiplied) — гладкие края
function render(size) {
  const S = 4, W = size * S;
  const hi = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const col = colorAt((x + 0.5) / W, (y + 0.5) / W);
    if (col) { const i = (y * W + x) * 4; hi[i] = col[0]; hi[i + 1] = col[1]; hi[i + 2] = col[2]; hi[i + 3] = 255; }
  }
  const out = new Uint8Array(size * size * 4);
  for (let ty = 0; ty < size; ty++) for (let tx = 0; tx < size; tx++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const i = (((ty * S + sy) * W) + (tx * S + sx)) * 4, a = hi[i + 3];
      R += hi[i] * a; G += hi[i + 1] * a; B += hi[i + 2] * a; A += a;
    }
    const o = (ty * size + tx) * 4;
    out[o] = A ? Math.round(R / A) : 0; out[o + 1] = A ? Math.round(G / A) : 0; out[o + 2] = A ? Math.round(B / A) : 0; out[o + 3] = Math.round(A / (S * S));
  }
  return out;
}

mkdirSync('icons', { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, encodePNG(size, render(size)));
  console.log(`icons/icon${size}.png`);
}
