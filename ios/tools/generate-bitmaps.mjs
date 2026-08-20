#!/usr/bin/env node
// Generates ios/Bloks/Avatar/Bitmaps.swift from the web client's own source.
//
//   node ios/tools/generate-bitmaps.mjs
//
// The avatars are the app's identity and the single easiest thing to get
// subtly, confidently wrong. Retyping sixteen rows of sixteen characters by
// hand produces something that looks plausible and is not the same
// creature, and redrawing by eye is worse. So the bitmaps and the palette
// are read out of src/, never copied into Swift by a person.
//
// What is NOT generated: the drawing geometry (eyes, mouths, the dithered
// foot band). Those are formulas rather than data, and they are ported by
// reading src/components/Avatar.tsx. If that file's Face() changes, the
// Swift port has to be updated by hand and this script will not tell you.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const avatarSource = join(repo, "src", "components", "Avatar.tsx");
const mascotSource = join(repo, "src", "lib", "mascot.ts");
const out = join(repo, "ios", "Bloks", "Avatar", "Bitmaps.swift");

/** Pull a balanced `{ ... }` literal that follows a marker.
 *
 * Anchored on the `=`, not the marker: the declaration carries a type
 * annotation (`Record<BlokShape, { rows: string[] }>`) whose own braces
 * come first and are not the value. */
function literalAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`could not find ${marker}`);
  const assign = source.indexOf("=", start);
  if (assign === -1) throw new Error(`${marker} is never assigned`);
  const open = source.indexOf("{", assign);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced literal after ${marker}`);
}

// BITMAPS is a plain object literal of string arrays and numbers, so it
// evaluates cleanly once the type annotation is off the front.
const avatar = readFileSync(avatarSource, "utf8");
const bitmaps = eval(`(${literalAfter(avatar, "const BITMAPS")})`);

// mascot.ts is plain TypeScript with no imports, so node's own type
// stripping can load it directly rather than us parsing it.
const { BLOK_COLORS, BLOK_SHAPES, BLOK_EXPRESSIONS } = await import(mascotSource);

// Sanity: every shape the palette knows about must have a bitmap, and
// every bitmap must be 16 rows of 16. A silent mismatch here is exactly
// the failure this script exists to prevent.
for (const shape of BLOK_SHAPES) {
  const spec = bitmaps[shape];
  if (!spec) throw new Error(`shape "${shape}" has no bitmap in Avatar.tsx`);
  if (spec.rows.length !== 16) throw new Error(`shape "${shape}" has ${spec.rows.length} rows, expected 16`);
  for (const row of spec.rows) {
    if (row.length !== 16) throw new Error(`shape "${shape}" has a row ${row.length} wide, expected 16`);
  }
}

const swiftString = (s) => `"${s}"`;
const shapeCases = BLOK_SHAPES.map((s) => `    case ${s}`).join("\n");
const expressionCases = BLOK_EXPRESSIONS.map((e) => `    case ${e}`).join("\n");

const bitmapEntries = BLOK_SHAPES.map((shape) => {
  const spec = bitmaps[shape];
  const rows = spec.rows.map((r) => `            ${swiftString(r)},`).join("\n");
  return `        .${shape}: BlokBitmap(
            rows: [
${rows}
            ],
            faceY: ${spec.faceY}
        ),`;
}).join("\n");

const colorEntries = BLOK_SHAPES.length
  ? Object.entries(BLOK_COLORS)
      .map(([name, hex]) => `        .${name}: 0x${hex.slice(1).toUpperCase()},`)
      .join("\n")
  : "";

const colorCases = Object.keys(BLOK_COLORS).map((c) => `    case ${c}`).join("\n");

const swift = `// GENERATED FILE. Do not edit.
//
// Written by ios/tools/generate-bitmaps.mjs from:
//   src/components/Avatar.tsx  (BITMAPS)
//   src/lib/mascot.ts          (BLOK_COLORS, BLOK_SHAPES, BLOK_EXPRESSIONS)
//
// Regenerate with:  node ios/tools/generate-bitmaps.mjs
import Foundation

/// The eight silhouettes. '#' is a body pixel, 16 rows of 16.
enum BlokShape: String, CaseIterable, Codable {
${shapeCases}

    /// Stable fallback for an agent made before shapes existed: hash the
    /// key so every agent gets its own silhouette without a migration.
    /// Mirrors shapeForBot() in src/lib/mascot.ts.
    static func forAgent(id: String?, name: String, declared: String?) -> BlokShape {
        if let declared, let shape = BlokShape(rawValue: declared) { return shape }
        let key = (id?.isEmpty == false ? id : nil) ?? name
        var hash: Int32 = 0
        for scalar in key.unicodeScalars {
            hash = hash &* 31 &+ Int32(truncatingIfNeeded: Int(scalar.value))
        }
        let all = BlokShape.allCases
        return all[Int(hash.magnitude) % all.count]
    }
}

enum BlokExpression: String, CaseIterable, Codable {
${expressionCases}
}

enum BlokColor: String, CaseIterable, Codable {
${colorCases}

    static func named(_ raw: String) -> BlokColor {
        BlokColor(rawValue: raw) ?? .blue
    }
}

struct BlokBitmap {
    let rows: [String]
    /// Where the face sits, in grid rows from the top of the 16x16 box.
    let faceY: Double
}

enum BlokArt {
    /// The 16x16 grid the creatures are drawn on.
    static let grid = 16
    /// The creature box inside the 100x100 tile, and its inset.
    static let box: Double = 72
    static let boxOffset: Double = (100 - 72) / 2
    static let cell: Double = 72 / 16

    static let bitmaps: [BlokShape: BlokBitmap] = [
${bitmapEntries}
    ]

    static let colorHex: [BlokColor: UInt32] = [
${colorEntries}
    ]
}
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, swift);
console.log(
  `wrote ${out}\n  ${BLOK_SHAPES.length} shapes, ${Object.keys(BLOK_COLORS).length} colours, ${BLOK_EXPRESSIONS.length} expressions`,
);
