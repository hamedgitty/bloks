// Where the window was, and whether that place still exists.
//
// Remembering bounds is the easy half. The hard half is that displays
// change between runs: a laptop leaves its desk, a monitor changes
// scale, and the saved rectangle may now describe a screen that is not
// plugged in. A window restored there would be invisible, which reads
// as "the app broke", so every restore is resolved against the displays
// that exist right now. The pure functions live here so they can be
// tested without a display at all.

/** The size a fresh install opens at, before any state exists. */
export const DEFAULT_SIZE = Object.freeze({ width: 1440, height: 920 });

/** Below this the composer and sidebar start fighting for pixels. */
export const MIN_SIZE = Object.freeze({ width: 900, height: 600 });

const wholeNumber = (value) => Number.isInteger(value) && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * The saved file, taken with suspicion. It is user-writable JSON, so a
 * truncated write, a hand edit or a different app version are all
 * ordinary inputs. Anything short of four whole-number bounds means
 * "no saved state", never an exception.
 */
export function parseWindowState(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const bounds = value?.bounds;
  if (!bounds || typeof bounds !== "object") return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(wholeNumber) || width <= 0 || height <= 0) return null;
  return { bounds: { x, y, width, height }, maximized: value.maximized === true };
}

const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
};

/**
 * Turn saved state plus the current display work areas into bounds that
 * are certainly visible. The first work area must be the primary
 * display; it is the fallback for everything.
 *
 * The window goes to whichever display it shared the most pixels with.
 * If it shared none, the size survives but the position resets to the
 * middle of the primary, because a stale corner is where windows go to
 * disappear.
 */
export function resolveWindowState(saved, workAreas) {
  const areas = (workAreas ?? []).filter(
    (a) => a && [a.x, a.y, a.width, a.height].every(wholeNumber) && a.width > 0 && a.height > 0,
  );
  const primary = areas[0];
  const fallback = {
    width: primary ? Math.min(DEFAULT_SIZE.width, primary.width) : DEFAULT_SIZE.width,
    height: primary ? Math.min(DEFAULT_SIZE.height, primary.height) : DEFAULT_SIZE.height,
  };
  const state = parseWindowState(saved);
  if (!state || !primary) return { bounds: fallback, maximized: false };

  let home = primary;
  let shared = 0;
  for (const area of areas) {
    const pixels = overlap(state.bounds, area);
    if (pixels > shared) {
      shared = pixels;
      home = area;
    }
  }

  const width = clamp(state.bounds.width, Math.min(MIN_SIZE.width, home.width), home.width);
  const height = clamp(state.bounds.height, Math.min(MIN_SIZE.height, home.height), home.height);
  const bounds =
    shared > 0
      ? {
          x: clamp(state.bounds.x, home.x, home.x + home.width - width),
          y: clamp(state.bounds.y, home.y, home.y + home.height - height),
          width,
          height,
        }
      : {
          x: home.x + Math.round((home.width - width) / 2),
          y: home.y + Math.round((home.height - height) / 2),
          width,
          height,
        };
  return { bounds, maximized: state.maximized };
}

/** Dock badges show a count, and a count is all they may show. Anything
 * that is not a sane small integer becomes 0 rather than a NaN badge. */
export function normalizeBadgeCount(value) {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.trunc(value), 0, 999);
}
