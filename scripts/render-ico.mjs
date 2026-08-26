// The Windows icon, packed from the same mark as everything else.
//
// electron-builder is supposed to convert build/icon.png for Windows on
// its own, and 1.1.0 shipped an exe with no icon anyway. So the .ico is
// now built here, checked in, and named explicitly in the builder
// config: one fewer conversion to trust at release time.
//
// The ICO container is simple enough to write by hand: a 6-byte header,
// one 16-byte directory entry per image, then the images. Every entry
// is a PNG, which Windows has accepted since Vista, so no BMP encoding
// is needed. Sizes are resized here from build/icon.png with sips on
// macOS (where releases are cut) or rsvg/magick fallbacks elsewhere.
//
// Run: node scripts/render-ico.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIZES = [256, 128, 64, 48, 32, 16];
const SOURCE = new URL("../build/icon.png", import.meta.url).pathname;
const OUT = new URL("../build/icon.ico", import.meta.url).pathname;

const work = mkdtempSync(join(tmpdir(), "bloks-ico-"));
const pngs = SIZES.map((size) => {
  const out = join(work, `${size}.png`);
  execFileSync("sips", ["-z", String(size), String(size), SOURCE, "--out", out], {
    stdio: "ignore",
  });
  return { size, bytes: readFileSync(out) };
});

const HEADER = 6;
const ENTRY = 16;
const header = Buffer.alloc(HEADER);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = HEADER + ENTRY * pngs.length;
for (const { size, bytes } of pngs) {
  const entry = Buffer.alloc(ENTRY);
  entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(bytes.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += bytes.length;
}

writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs.map((p) => p.bytes)]));
rmSync(work, { recursive: true, force: true });
console.log(`build/icon.ico  ${pngs.length} sizes, ${offset} bytes`);
