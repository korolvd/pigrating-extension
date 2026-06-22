// Генератор иконок расширения без зависимостей: рисует пятачок в цветном колесе и кодирует PNG (zlib).
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
const inEllipse = (u, v, cx, cy, rx, ry) => { const a = (u - cx) / rx, b = (v - cy) / ry; return a * a + b * b <= 1; };

// палитра «радуга» (8 секторов колеса) + пятачок
const WHEEL = [[235, 87, 87], [242, 153, 74], [242, 201, 76], [39, 174, 96], [45, 156, 219], [47, 128, 237], [155, 81, 224], [237, 110, 160]];
const C = { white: [255, 255, 255], head: [244, 166, 192], snout: [239, 143, 179], nostril: [122, 50, 80], eye: [58, 32, 48] };

// цвет пикселя (верхний слой побеждает); null — прозрачный. Сплошное цветное колесо + пятачок в центре.
function colorAt(u, v) {
  const dx = u - 0.5, dy = v - 0.5;
  if (dx * dx + dy * dy > 0.48 * 0.48) return null;             // вне колеса — прозрачно
  const a = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  let col = WHEEL[Math.floor(a / 45) % 8];                      // 8 секторов от верха по часовой
  if (inEllipse(u, v, 0.5, 0.5, 0.24, 0.24)) col = C.white;     // белый ободок вокруг морды
  if (inEllipse(u, v, 0.5, 0.5, 0.208, 0.208)) col = C.head;    // голова
  if (inEllipse(u, v, 0.5, 0.552, 0.109, 0.083)) col = C.snout; // пятак
  if (inEllipse(u, v, 0.460, 0.552, 0.020, 0.031) || inEllipse(u, v, 0.540, 0.552, 0.020, 0.031)) col = C.nostril;
  if (inEllipse(u, v, 0.443, 0.464, 0.023, 0.023) || inEllipse(u, v, 0.557, 0.464, 0.023, 0.023)) col = C.eye;
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
