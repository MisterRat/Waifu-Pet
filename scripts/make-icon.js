// Generates assets/tray.png (32x32) and assets/icon.png (512x512, used for the
// .exe icon) with no external dependencies. Draws a simple pink face.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");


function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing (all coordinates are designed on a 32x32 grid and scaled by k) ---
function render(size) {
  const k = size / 32;
  const px = Buffer.alloc(size * size * 4); // transparent

  function put(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // alpha-over
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  }

  function fillCircle(cx, cy, rad, r, g, b, a) {
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rad - 0.5) put(x, y, r, g, b, a);
        else if (d <= rad + 0.5) put(x, y, r, g, b, Math.round(a * (rad + 0.5 - d)));
      }
    }
  }

  function fillRect(x0, y0, x1, y1, r, g, b, a) {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) put(x, y, r, g, b, a);
  }

  fillCircle(16 * k, 16 * k, 14 * k, 255, 182, 213, 255); // pink face
  fillRect(10 * k, 13 * k, 12 * k + (k - 1), 17 * k + (k - 1), 60, 40, 70, 255); // eyes
  fillRect(20 * k, 13 * k, 22 * k + (k - 1), 17 * k + (k - 1), 60, 40, 70, 255);
  for (let x = 11 * k; x <= 21 * k; x++) {
    // smile
    const t = (x - 16 * k) / (5 * k);
    const y = 23 * k - t * t * 3 * k; // center lowest = a smile
    fillCircle(x, y, Math.max(0.6, k * 0.6), 60, 40, 70, 255);
  }
  fillCircle(8 * k, 19 * k, 2 * k, 255, 120, 160, 160); // blush
  fillCircle(24 * k, 19 * k, 2 * k, 255, 120, 160, 160);
  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });
// icon.png is always regenerated. tray.png is only created when missing, so a
// hand-made tray icon is never overwritten.
for (const [file, size, onlyIfMissing] of [["tray.png", 32, true], ["icon.png", 512, false]]) {
  const outPath = path.join(outDir, file);
  if (onlyIfMissing && fs.existsSync(outPath)) {
    console.log("kept existing", outPath);
    continue;
  }
  fs.writeFileSync(outPath, render(size));
  console.log("wrote", outPath);
}
