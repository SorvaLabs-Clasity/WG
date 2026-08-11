/**
 * Generates the app icon — the navbar mark, at every size the installers want.
 *
 * Drawn in code rather than exported from a design tool because there is no SVG
 * rasteriser on a stock macOS box, and because an icon that regenerates from
 * source cannot drift from the thing it is meant to match.
 *
 *   node scripts/make-icon.mjs
 *
 * Writes into github-control-hub/desktop/assets/:
 *   icon.icns   macOS bundle       (via iconutil)
 *   icon.ico    Windows installer  (PNG-in-ICO, Vista and later)
 *   icon.png    1024px, for Linux and anything else
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..",
                 "github-control-hub", "desktop", "assets");

// Navbar light mode: slate-900 tile, white shield. Dark-on-light survives both
// a light and a dark taskbar; a white tile would vanish against a pale one.
const BG   = [15, 23, 42, 255];
const MARK = [255, 255, 255, 255];

// ── geometry ──────────────────────────────────────────────────────────
// All in a unit square centred on the origin, so it scales exactly.

/** Squircle-ish tile. Corner radius as a fraction of the full width. */
function insideTile(x, y, r) {
  const ax = Math.abs(x), ay = Math.abs(y);
  const cx = 1 - r, cy = 1 - r;
  if (ax <= cx || ay <= cy) return ax <= 1 && ay <= 1;
  return (ax - cx) ** 2 + (ay - cy) ** 2 <= r * r;
}

/**
 * Shield: straight sides down to `yStraight`, then an elliptical taper to a
 * point at the bottom, with the top corners rounded.
 */
function insideShield(x, y) {
  if (y < -1 || y > 1) return false;
  const yStraight = 0.12;
  let hw = 1;
  if (y > yStraight) {
    const t = (y - yStraight) / (1 - yStraight);
    // Two things have to be true at once, which rules out the obvious curves.
    // At the shoulder the slope must be zero or the straight side meets the
    // taper in a visible kink — that rules out sqrt(1 - t). At the tip it must
    // converge steeply or the shield bottoms out flat and reads as a pocket —
    // that rules out the quarter-ellipse sqrt(1 - t*t). Raising the ellipse to
    // a power under 1 keeps its flat shoulder and sharpens its tip.
    hw = Math.pow(Math.max(0, 1 - t * t), 0.72);
  }
  if (Math.abs(x) > hw) return false;

  const rc = 0.22;
  if (y < -1 + rc) {
    const dx = Math.abs(x) - (1 - rc);
    const dy = -1 + rc - y;
    if (dx > 0 && dx * dx + dy * dy > rc * rc) return false;
  }
  return true;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The check, knocked out of the shield in the tile colour. */
function insideCheck(x, y) {
  const w = 0.15;
  return distToSegment(x, y, -0.42, 0.00, -0.12, 0.30) <= w
      || distToSegment(x, y, -0.12, 0.30,  0.44, -0.30) <= w;
}

/** Colour at a point in tile space, or null for transparent. */
function sample(x, y) {
  if (!insideTile(x, y, 0.42)) return null;

  // Shield occupies this fraction of the tile, nudged up so the point does not
  // sit hard on the bottom edge.
  const s = 0.66;
  const sx = x / s, sy = (y - 0.02) / s;

  if (insideShield(sx, sy) && !insideCheck(sx, sy)) return MARK;
  return BG;
}

// ── rasteriser ────────────────────────────────────────────────────────
/** 4×4 supersampling. Cheap, and the edges are the whole job at 16px. */
function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = ((i + (si + 0.5) / SS) / size) * 2 - 1;
          const y = ((j + (sj + 0.5) / SS) / size) * 2 - 1;
          const c = sample(x, y);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      // Premultiply-free average: colour is the mean over covered samples only,
      // so a half-covered edge keeps its hue instead of darkening toward black.
      const cov = a / 255;
      px[o]     = cov ? Math.round(r / cov) : 0;
      px[o + 1] = cov ? Math.round(g / cov) : 0;
      px[o + 2] = cov ? Math.round(b / cov) : 0;
      px[o + 3] = Math.round(a / n);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = render(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // Each scanline carries a leading filter byte; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) {
    raw[j * (size * 4 + 1)] = 0;
    px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO ───────────────────────────────────────────────────────────────
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(sizes.length, 4);

  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const o = i * 16;
    dir[o]     = s >= 256 ? 0 : s;       // 0 means 256
    dir[o + 1] = s >= 256 ? 0 : s;
    dir[o + 2] = 0;                      // palette size
    dir[o + 3] = 0;                      // reserved
    dir.writeUInt16LE(1, o + 4);         // colour planes
    dir.writeUInt16LE(32, o + 6);        // bits per pixel
    dir.writeUInt32LE(images[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, dir, ...images]);
}

// ── write ─────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

writeFileSync(join(OUT, "icon.png"), png(1024));
console.log("  icon.png   1024×1024");

writeFileSync(join(OUT, "icon.ico"), ico([16, 32, 48, 64, 128, 256]));
console.log("  icon.ico   16 32 48 64 128 256");

// iconutil wants a directory of exactly these names.
const iconset = join(OUT, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const [name, size] of [
  ["icon_16x16", 16], ["icon_16x16@2x", 32],
  ["icon_32x32", 32], ["icon_32x32@2x", 64],
  ["icon_128x128", 128], ["icon_128x128@2x", 256],
  ["icon_256x256", 256], ["icon_256x256@2x", 512],
  ["icon_512x512", 512], ["icon_512x512@2x", 1024],
]) writeFileSync(join(iconset, `${name}.png`), png(size));

try {
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(OUT, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("  icon.icns  16…1024");
} catch {
  // iconutil is macOS-only. The iconset is left in place so it can be
  // converted on a Mac; electron-builder can also fall back to icon.png.
  console.log("  icon.icns  SKIPPED (iconutil unavailable) — icon.iconset kept");
}
