// ⌘Q on a Mac, held or pressed twice (electron/quit-guard.mjs): which
// keys are ⌘Q, the guard's timing on a clock of the test's own, the hint
// and its window, the setting kept with the theme (electron/workspaces.mjs),
// and the main process wiring, read as written, since none of it can
// run without Electron.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  AGAIN_MS,
  HINT_SIZE,
  HOLD_MS,
  LEAVE_MAX_MS,
  LINGER_MS,
  createQuitGuard,
  createQuitHint,
  endsQuitKey,
  hintBounds,
  isQuitKey,
  quitHintPage,
  type QuitPhase,
} from "../electron/quit-guard.mjs";
import { parseRegistry, setQuitGuard } from "../electron/workspaces.mjs";

const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    later: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (id: unknown) => void timers.delete(id as number),
    tick(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

function guard() {
  const time = clock();
  const phases: Array<QuitPhase | null> = [];
  let quits = 0;
  const g = createQuitGuard({ quit: () => quits++, hint: (p) => phases.push(p), later: time.later, cancel: time.cancel });
  return { g, time, phases, quits: () => quits };
}

const Q = { key: "q", code: "KeyQ" };
const META = { key: "Meta", code: "MetaLeft" };

describe("which keys are ⌘Q", () => {
  test("⌘ and the letter Q, and nothing else held", () => {
    assert.equal(isQuitKey({ meta: true, key: "q", code: "KeyQ" }), true);
    assert.equal(isQuitKey({ meta: true, key: "Q", code: "KeyQ" }), true);
    assert.equal(isQuitKey({ meta: true, shift: true, key: "q", code: "KeyQ" }), false, "⌘⇧Q is the system's Log Out");
    assert.equal(isQuitKey({ meta: true, alt: true, key: "q", code: "KeyQ" }), false);
    assert.equal(isQuitKey({ control: true, key: "q", code: "KeyQ" }), false);
    assert.equal(isQuitKey({ key: "q", code: "KeyQ" }), false, "Q typed in a field");
    assert.equal(isQuitKey({ meta: true, key: "w", code: "KeyW" }), false);
  });

  test("the letter decides on a Latin layout, the key's place on any other", () => {
    assert.equal(isQuitKey({ meta: true, key: "q", code: "KeyA" }), true, "AZERTY's Q");
    assert.equal(isQuitKey({ meta: true, key: "a", code: "KeyQ" }), false, "AZERTY's A, where QWERTY keeps Q");
    assert.equal(isQuitKey({ meta: true, key: "й", code: "KeyQ" }), true, "a Russian layout");
  });

  test("Q coming up, or ⌘, ends a hold", () => {
    assert.equal(endsQuitKey(Q), true);
    assert.equal(endsQuitKey(META), true);
    assert.equal(endsQuitKey({ key: "Meta", code: "MetaRight" }), true);
    assert.equal(endsQuitKey({ key: "w", code: "KeyW" }), false);
    assert.equal(endsQuitKey({ key: "a", code: "KeyQ" }), false);
  });
});

describe("the guard", () => {
  test("one press shows the hint and quits nothing; the hint goes on its own", () => {
    const { g, time, phases, quits } = guard();
    assert.equal(g.press(), true, "taken, so the menu never hears it");
    assert.deepEqual(phases, ["holding"]);
    time.tick(120);
    g.release(Q);
    assert.equal(g.state, "armed");
    time.tick(AGAIN_MS + 1);
    assert.equal(g.state, "idle", "too late for a second press");
    time.tick(LINGER_MS);
    assert.deepEqual(phases, ["holding", "armed", null]);
    assert.equal(quits(), 0);
  });

  test("held for a second, it quits once the keys come up, and not before", () => {
    const { g, time, phases, quits } = guard();
    g.press();
    // the key repeating while held is the same press
    for (let i = 0; i < 10; i++) {
      time.tick(90);
      g.press({ repeat: true });
    }
    time.tick(HOLD_MS);
    assert.equal(g.state, "leaving");
    assert.equal(quits(), 0, "the keys are still down: the next app would hear them");
    assert.equal(phases.at(-1), "leaving");
    g.release(Q);
    assert.equal(quits(), 1);
    assert.equal(g.state, "gone");
    // nothing after that quits twice
    g.press();
    g.release(Q);
    g.menu();
    assert.equal(quits(), 1);
  });

  test("⌘ coming up first counts as the release, since a Mac may keep Q's from the page", () => {
    const { g, time, quits } = guard();
    g.press();
    time.tick(HOLD_MS);
    g.release(META);
    assert.equal(quits(), 1);
  });

  test("a second press soon after quits, once it comes up", () => {
    const { g, time, quits } = guard();
    g.press();
    time.tick(80);
    g.release(Q);
    time.tick(AGAIN_MS - 100);
    g.press();
    assert.equal(g.state, "leaving");
    assert.equal(quits(), 0);
    time.tick(60);
    g.release(Q);
    assert.equal(quits(), 1);
  });

  test("a second press with no release heard between them is still a second press", () => {
    const { g, time, quits } = guard();
    g.press();
    time.tick(200);
    g.press();
    g.release(META);
    assert.equal(quits(), 1);
  });

  test("a second press too late starts over", () => {
    const { g, time, quits } = guard();
    g.press();
    time.tick(80);
    g.release(Q);
    time.tick(AGAIN_MS + 50);
    g.press();
    assert.equal(g.state, "holding");
    time.tick(100);
    g.release(Q);
    time.tick(AGAIN_MS + LINGER_MS);
    assert.equal(quits(), 0);
  });

  test("⌘Q still held from an app that just quit is not a press here", () => {
    const { g, time, phases, quits } = guard();
    for (let i = 0; i < 30; i++) {
      g.press({ repeat: true });
      time.tick(90);
    }
    assert.equal(g.state, "idle");
    assert.deepEqual(phases, []);
    assert.equal(quits(), 0);
  });

  test("another key, or the window losing the keyboard, ends a hold without quitting", () => {
    for (const end of ["other", "blur"] as const) {
      const { g, time, quits } = guard();
      g.press();
      time.tick(300);
      // ⌘ alone says nothing about the Q
      g.other({ key: "Meta" });
      assert.equal(g.state, "holding");
      if (end === "other") g.other({ key: "w", code: "KeyW" });
      else g.blur();
      assert.equal(g.state, "armed");
      time.tick(HOLD_MS * 3);
      assert.equal(quits(), 0, end);
    }
  });

  test("leaving, the keyboard going elsewhere lets it go; so does a release that never comes", () => {
    const blurred = guard();
    blurred.g.press();
    blurred.time.tick(HOLD_MS);
    blurred.g.blur();
    assert.equal(blurred.quits(), 1);

    const stuck = guard();
    stuck.g.press();
    stuck.time.tick(HOLD_MS);
    stuck.time.tick(LEAVE_MAX_MS - 1);
    assert.equal(stuck.quits(), 0);
    stuck.time.tick(1);
    assert.equal(stuck.quits(), 1);
  });

  test("the menu's Quit from the key: a press already under way is the same press", () => {
    const { g, time, quits } = guard();
    g.press();
    g.menu();
    assert.equal(g.state, "holding", "the menu heard the same ⌘Q the page did");
    time.tick(100);
    g.release(Q);
    g.menu();
    assert.equal(quits(), 1, "a second press only the menu heard, with no release to wait for");
  });

  test("the menu's Quit from the key alone needs a second press", () => {
    const { g, time, quits } = guard();
    g.menu();
    assert.equal(g.state, "armed");
    time.tick(AGAIN_MS + 1);
    g.menu();
    assert.equal(quits(), 0, "too late: it starts over");
    time.tick(100);
    g.menu();
    assert.equal(quits(), 1);
  });

  test("turning the setting off part way leaves nothing under way", () => {
    const { g, time, phases, quits } = guard();
    g.press();
    g.reset();
    assert.equal(g.state, "idle");
    assert.equal(phases.at(-1), null);
    time.tick(HOLD_MS * 2);
    assert.equal(quits(), 0);
  });
});

describe("the hint", () => {
  test("sits in the middle of the window it is over", () => {
    assert.deepEqual(hintBounds({ x: 100, y: 50, width: 1200, height: 800 }), {
      x: 100 + (1200 - HINT_SIZE.width) / 2,
      y: 50 + (800 - HINT_SIZE.height) / 2,
      width: HINT_SIZE.width,
      height: HINT_SIZE.height,
    });
  });

  test("its page says the words as text, in either theme, with a fill that runs for the hold", () => {
    const page = (url: string) => decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ""));
    const light = page(quitHintPage({ text: "Hold ⌘Q or press it twice to quit" }));
    assert.match(light, /Hold ⌘Q or press it twice to quit/);
    assert.match(light, /#ffffff/);
    assert.match(light, new RegExp(`transform ${HOLD_MS}ms linear`));
    assert.match(light, /window\.phase=/);
    assert.match(page(quitHintPage({ text: "x", dark: true })), /#1a1a1e/);
    const hostile = page(quitHintPage({ text: `<img src=x onerror="alert(1)">` }));
    assert.ok(!hostile.includes("<img"), "the words are text, never markup");
    assert.match(hostile, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });

  test("its window is a panel that never takes the keyboard or a click, shown without focus", async () => {
    const made: any[] = [];
    class FakeWindow {
      options: any;
      shown = false;
      visible = false;
      bounds: any = null;
      ignore = false;
      ran: string[] = [];
      loaded: string[] = [];
      webContents = { executeJavaScript: async (code: string) => void this.ran.push(code) };
      constructor(options: any) {
        this.options = options;
        made.push(this);
      }
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      setIgnoreMouseEvents(on: boolean) {
        this.ignore = on;
      }
      on() {}
      isDestroyed() {
        return false;
      }
      isVisible() {
        return this.visible;
      }
      loadURL(url: string) {
        this.loaded.push(url);
        return Promise.resolve();
      }
      setBounds(b: any) {
        this.bounds = b;
      }
      showInactive() {
        this.visible = true;
        this.shown = true;
      }
      hide() {
        this.visible = false;
      }
    }
    const time = clock();
    let front: { getBounds(): any } | null = null;
    const hint = createQuitHint({
      BrowserWindow: FakeWindow as any,
      over: () => front,
      words: () => "Hold ⌘Q or press it twice to quit",
      dark: () => false,
      later: time.later,
      cancel: time.cancel,
    });
    hint.show("holding");
    assert.equal(made.length, 0, "no window in front, nothing to show over");
    front = { getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }) };
    hint.show("holding");
    assert.equal(made.length, 1);
    const win = made[0];
    assert.equal(win.options.focusable, false);
    assert.equal(win.options.type, "panel");
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.preload, undefined, "the hint's page has no bridge to anything");
    assert.equal(win.ignore, true);
    assert.equal(win.shown, true);
    assert.deepEqual(win.bounds, hintBounds({ x: 0, y: 0, width: 1000, height: 700 }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(win.ran, ['window.phase("holding")']);
    hint.show("armed");
    hint.show(null);
    await new Promise((r) => setImmediate(r));
    assert.equal(win.visible, true, "it fades before it goes");
    time.tick(1000);
    assert.equal(win.visible, false);
    hint.show("holding");
    assert.equal(made.length, 1, "kept for the next time");
    assert.equal(win.loaded.length, 1, "and its page too, while the words and theme are the same");
  });
});

describe("the setting", () => {
  test("on unless turned off, and kept across a restart", () => {
    const fresh = parseRegistry("{}");
    assert.equal(fresh.prefs.quitGuard, true);
    const off = parseRegistry(JSON.stringify(setQuitGuard(fresh, false))).prefs;
    assert.equal(off.quitGuard, false);
    assert.equal(setQuitGuard(fresh, "no" as unknown as boolean), fresh, "anything but a yes or a no changes nothing");
  });
});

describe("the main process", () => {
  test("hears ⌘Q in every page on a Mac, keeps it from the menu, and only while it has the keyboard", () => {
    const hook = main.match(/app\.on\("web-contents-created", \(_event, contents\) => \{[\s\S]*?\n\}\);/)?.[0] ?? "";
    assert.match(hook, /if \(process\.platform !== "darwin"\) return;/);
    assert.match(hook, /if \(!quitGuardOn\(\)\) return;/);
    assert.match(hook, /if \(!contents\.isFocused\(\) \|\| !BrowserWindow\.getFocusedWindow\(\)\) return;/);
    assert.match(hook, /if \(isQuitKey\(input\)\) \{\s*event\.preventDefault\(\);\s*quitGuard\.press\(\{ repeat: input\.isAutoRepeat \}\);/);
    assert.match(main, /const quitGuardOn = \(\) => process\.platform === "darwin" && registry\?\.prefs\?\.quitGuard !== false;/);
  });

  test("the menu's Quit goes through the guard only from the key, in a Bloks window", () => {
    assert.match(main, /function menuQuit\(byKey\) \{\s*if \(byKey && quitGuardOn\(\) && BrowserWindow\.getFocusedWindow\(\)\) return quitGuard\.menu\(\);\s*app\.quit\(\);\s*\}/);
    assert.match(main, /appMenuTemplate\(\{ name: app\.name, packaged: app\.isPackaged, command: menuCommand, quit: menuQuit, words: mainWords\(\) \}\)/);
  });

  test("every other way out quits as it did: the tray, an update, a relaunch", () => {
    assert.match(main, /click: \(\) => app\.quit\(\) \}\]\)\);/, "the tray's Quit");
    assert.match(main, /handle\("app:relaunch", \(\) => \{\s*app\.relaunch\(\);\s*app\.quit\(\);/);
    assert.match(main, /return electronUpdater\.autoUpdater\.quitAndInstall\(\);/);
  });

  test("the switch is offered only on a Mac", () => {
    assert.match(main, /\.\.\.\(process\.platform === "darwin" \? \{ quitGuard: registry\.prefs\.quitGuard !== false \} : \{\}\),/);
  });
});
