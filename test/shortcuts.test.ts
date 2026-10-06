// The list behind ⌘/ and the palette's key hints (#154), and the message
// ↑ opens for editing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  chordLabel,
  keysFor,
  platformOf,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutSheet,
} from "../src/lib/shortcuts.ts";
import { lastEditable } from "../src/lib/transcript.ts";
import type { Message } from "../src/state/reducer.ts";

describe("the shortcut list", () => {
  test("every entry has a key, says what it does, and sits in a group the sheet draws", () => {
    const groups = new Set(SHORTCUT_GROUPS.map((g) => g.id));
    for (const shortcut of SHORTCUTS) {
      assert.ok(shortcut.does.trim(), `${shortcut.id} says nothing`);
      assert.ok(shortcut.keys.length > 0, `${shortcut.id} has no key`);
      for (const chord of shortcut.keys) assert.ok(chord.length > 0, `${shortcut.id} has an empty chord`);
      assert.ok(groups.has(shortcut.group), `${shortcut.id} is in no group`);
    }
  });

  test("ids are unique, so the palette finds the one it means", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("a key listed twice says where each meaning applies", () => {
    // Enter sends, and Enter also steps through find; ⌥↑ walks the
    // sidebar, and on a section heading moves it. Two lines with the same
    // key and no word about where would read as a mistake.
    for (const a of SHORTCUTS) {
      for (const b of SHORTCUTS) {
        if (a.id >= b.id) continue;
        const shared = a.keys.some((ka) => b.keys.some((kb) => ka.join("+") === kb.join("+")));
        if (shared) assert.ok(a.when || b.when, `${a.id} and ${b.id} share a key with no "when"`);
      }
    }
  });

  test("the keys that were there before the sheet are on it", () => {
    const mac = (id: string) => keysFor(id, "mac");
    assert.deepEqual(mac("palette"), ["⌘K"]);
    assert.deepEqual(mac("newAgent"), ["⌘N"]);
    assert.deepEqual(mac("find"), ["⌘F"]);
    assert.deepEqual(mac("send"), ["↩"]);
    assert.deepEqual(mac("interrupt"), ["⌘↩"]);
    assert.deepEqual(mac("moveSection"), ["⌥↑", "⌥↓"]);
    assert.deepEqual(keysFor("zoom", "other"), ["Ctrl+Plus", "Ctrl+-", "Ctrl+0"]);
  });

  test("and so are the new ones", () => {
    assert.deepEqual(keysFor("settings", "mac"), ["⌘,"]);
    assert.deepEqual(keysFor("shortcuts", "mac"), ["⌘/"]);
    assert.deepEqual(keysFor("sidebarStep", "mac"), ["⌥↑", "⌥↓"]);
    assert.deepEqual(keysFor("sidebarWaiting", "mac"), ["⌥⇧↑", "⌥⇧↓"]);
    assert.deepEqual(keysFor("editLast", "mac"), ["↑"]);
  });

  test("an id the list does not have gets no keys rather than a guess", () => {
    assert.deepEqual(keysFor("nothing-by-this-name", "mac"), []);
  });
});

describe("labels", () => {
  test("a Mac draws symbols, run together, in Apple's order", () => {
    assert.equal(chordLabel(["Mod", "K"], "mac"), "⌘K");
    assert.equal(chordLabel(["Alt", "Shift", "Down"], "mac"), "⌥⇧↓");
    // written in another order, still ⌃⌥⇧⌘
    assert.equal(chordLabel(["Shift", "Mod", "Alt", "P"], "mac"), "⌥⇧⌘P");
    assert.equal(chordLabel(["Shift", "Enter"], "mac"), "⇧↩");
    assert.equal(chordLabel(["Esc"], "mac"), "esc");
  });

  test("Ctrl+Tab is the Control key on a Mac too, not Command", () => {
    assert.deepEqual(keysFor("recent", "mac"), ["⌃⇥", "⌃⇧⇥"]);
    assert.deepEqual(keysFor("recent", "other"), ["Ctrl+Tab", "Ctrl+Shift+Tab"]);
  });

  test("everywhere else spells the words out and joins them with a plus", () => {
    assert.equal(chordLabel(["Mod", "K"], "other"), "Ctrl+K");
    assert.equal(chordLabel(["Mod", ","], "other"), "Ctrl+,");
    assert.equal(chordLabel(["Shift", "Alt", "Down"], "other"), "Alt+Shift+↓");
    assert.equal(chordLabel(["Mod", "Enter"], "other"), "Ctrl+Enter");
    // "Ctrl++" reads as a typo
    assert.equal(chordLabel(["Mod", "+"], "other"), "Ctrl+Plus");
  });

  test("no label on another platform says Command or uses a Mac symbol", () => {
    for (const shortcut of SHORTCUTS) {
      for (const label of keysFor(shortcut.id, "other")) {
        assert.doesNotMatch(label, /[⌘⌥⇧⌃↩⇥]|Cmd|Command/, `${shortcut.id}: ${label}`);
      }
    }
  });

  test("which keyboard is which", () => {
    assert.equal(platformOf("MacIntel"), "mac");
    assert.equal(platformOf("iPad"), "mac");
    assert.equal(platformOf("Win32"), "other");
    assert.equal(platformOf("Linux x86_64"), "other");
    assert.equal(platformOf(""), "other");
  });
});

describe("the sheet", () => {
  test("groups come in the order the sheet promises", () => {
    assert.deepEqual(
      shortcutSheet(true).map((g) => g.id),
      ["navigation", "conversation", "composer", "app"],
    );
  });

  test("a browser tab leaves out the keys the browser keeps for itself", () => {
    const ids = (desktop: boolean) => shortcutSheet(desktop).flatMap((g) => g.shortcuts.map((s) => s.id));
    assert.ok(ids(true).includes("recent"));
    assert.ok(!ids(false).includes("recent"), "Ctrl+Tab never reaches a page in a browser");
    assert.ok(ids(false).includes("palette"));
  });
});

describe("↑ in an empty composer", () => {
  let n = 0;
  const said = (role: "user" | "bot", text: string, extra: Partial<Message> = {}): Message => ({
    id: `m${++n}`,
    role,
    kind: "text",
    text,
    at: n,
    ...extra,
  });

  test("opens the newest thing you typed, whatever the agent said after it", () => {
    const mine = said("user", "second thought");
    assert.equal(lastEditable([said("user", "first"), mine, said("bot", "noted")]), mine);
  });

  test("a message taken back has no words left, so the one before it is the last thing you said", () => {
    const earlier = said("user", "keep this");
    assert.equal(lastEditable([earlier, said("user", "", { deleted: true })]), earlier);
  });

  test("words that came another way, or passed between agents, are not yours to rewrite here", () => {
    const typed = said("user", "typed here");
    const messages = [
      typed,
      said("user", "from the watcher", { via: "watcher" }),
      said("user", "from another agent", { agent: { peerId: "b2", peerName: "Ada", dir: "in" } }),
    ];
    assert.equal(lastEditable(messages), typed);
  });

  test("a message still waiting is yours to reword, and one never sent is sent again instead", () => {
    // the waiting one sits in the strip above the composer, and opens there
    const waiting = said("user", "on second thought", { queued: true });
    assert.equal(lastEditable([said("user", "first"), said("bot", "working"), waiting]), waiting);
    const typed = said("user", "typed here");
    assert.equal(lastEditable([typed, said("user", "never went", { unsent: true })]), typed);
  });

  test("nothing of yours means nothing to edit, and the key stays a caret", () => {
    assert.equal(lastEditable([]), null);
    assert.equal(lastEditable([said("bot", "hello")]), null);
    assert.equal(lastEditable([said("user", "", { deleted: true })]), null);
  });
});
