// Restoring a window onto displays that may have changed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_SIZE,
  normalizeBadgeCount,
  parseWindowState,
  resolveWindowState,
} from "../electron/window-state.mjs";

const LAPTOP = { x: 0, y: 25, width: 1512, height: 944 };
const MONITOR = { x: 1512, y: 0, width: 2560, height: 1415 };

describe("parseWindowState", () => {
  test("round-trips a saved state", () => {
    const raw = JSON.stringify({ bounds: { x: 40, y: 60, width: 1200, height: 800 }, maximized: true });
    assert.deepEqual(parseWindowState(raw), {
      bounds: { x: 40, y: 60, width: 1200, height: 800 },
      maximized: true,
    });
  });

  test("rejects garbage without throwing", () => {
    for (const raw of [null, "", "{", "[]", "{}", '{"bounds":{}}', '{"bounds":{"x":1.5,"y":0,"width":100,"height":100}}', '{"bounds":{"x":0,"y":0,"width":0,"height":100}}']) {
      assert.equal(parseWindowState(raw), null);
    }
  });
});

describe("resolveWindowState", () => {
  test("no saved state opens at the default, capped to the display", () => {
    const { bounds, maximized } = resolveWindowState(null, [LAPTOP]);
    assert.equal(bounds.width, Math.min(DEFAULT_SIZE.width, LAPTOP.width));
    assert.equal(bounds.height, Math.min(DEFAULT_SIZE.height, LAPTOP.height));
    assert.equal(maximized, false);
  });

  test("a window on a still-connected display stays put", () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1440, height: 920 }, maximized: false };
    const { bounds } = resolveWindowState(saved, [LAPTOP, MONITOR]);
    assert.deepEqual(bounds, saved.bounds);
  });

  test("a window on an unplugged display re-centres on the primary", () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1440, height: 920 }, maximized: false };
    const { bounds } = resolveWindowState(saved, [LAPTOP]);
    assert.equal(bounds.width, 1440);
    assert.ok(bounds.x >= LAPTOP.x && bounds.x + bounds.width <= LAPTOP.x + LAPTOP.width);
    assert.ok(bounds.y >= LAPTOP.y && bounds.y + bounds.height <= LAPTOP.y + LAPTOP.height);
  });

  test("a window hanging off the edge is pulled fully on screen", () => {
    const saved = { bounds: { x: 1400, y: 900, width: 1200, height: 800 }, maximized: false };
    const { bounds } = resolveWindowState(saved, [LAPTOP]);
    assert.ok(bounds.x + bounds.width <= LAPTOP.x + LAPTOP.width);
    assert.ok(bounds.y + bounds.height <= LAPTOP.y + LAPTOP.height);
  });

  test("a window bigger than the new display shrinks to fit", () => {
    const small = { x: 0, y: 0, width: 1280, height: 720 };
    const saved = { bounds: { x: 0, y: 0, width: 2400, height: 1300 }, maximized: false };
    const { bounds } = resolveWindowState(saved, [small]);
    assert.equal(bounds.width, small.width);
    assert.equal(bounds.height, small.height);
  });

  test("maximized survives the round trip", () => {
    const saved = { bounds: { x: 10, y: 30, width: 1000, height: 700 }, maximized: true };
    assert.equal(resolveWindowState(saved, [LAPTOP]).maximized, true);
  });

  test("no displays at all still answers something usable", () => {
    const { bounds } = resolveWindowState(null, []);
    assert.deepEqual(bounds, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
  });
});

describe("normalizeBadgeCount", () => {
  test("keeps counts sane", () => {
    assert.equal(normalizeBadgeCount(3), 3);
    assert.equal(normalizeBadgeCount(0), 0);
    assert.equal(normalizeBadgeCount(-2), 0);
    assert.equal(normalizeBadgeCount(4.7), 4);
    assert.equal(normalizeBadgeCount(Infinity), 0);
    assert.equal(normalizeBadgeCount(NaN), 0);
    assert.equal(normalizeBadgeCount(5000), 999);
  });
});
