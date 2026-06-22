// Сборка чистого пакета расширения pigrating.zip (только рантайм-файлы), без зависимостей.
// Запуск: node tools/build.mjs  (или npm run build)
import zlib from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  'manifest.json',
  'background.js',
  'core.js',
  'twitch.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'help.html',
  'help/1-fill.png',
  'help/3-apps-script.png',
  'help/4-paste.png',
  'help/6-deploy.png',
  'help/7-type.png',
  'help/8-access.png',
  'help/10-url.png',
  'help/11-paste-url.png',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'LICENSE',
];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const DOS_TIME = 0, DOS_DATE = 22561; // фиксированная дата 2024-01-01 → детерминированный zip
const local = [], central = [];
let offset = 0;

for (const name of FILES) {
  const data = readFileSync(name);
  const comp = zlib.deflateRawSync(data); // метод 8 (deflate) — сырой поток
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, comp);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += lh.length + nameBuf.length + comp.length;
}

const localBuf = Buffer.concat(local);
const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(FILES.length, 8); eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);

writeFileSync('pigrating.zip', Buffer.concat([localBuf, centralBuf, eocd]));
console.log(`pigrating.zip — ${FILES.length} файлов`);
for (const f of FILES) console.log('  +', f);
