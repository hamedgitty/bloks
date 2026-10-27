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
import { getLanguage, inEnglish, LANGUAGES, setLanguage, t } from "../src/lib/i18n.ts";
import { lastEditable } from "../src/lib/transcript.ts";
import type { Message } from "../src/state/reducer.ts";

describe("the shortcut list", () => {
  test("every entry has a key, says what it does, and sits in a group the sheet draws", () => {
    const groups = new Set(SHORTCUT_GROUPS.map((g) => g.id));
    for (const shortcut of SHORTCUTS) {
      assert.ok(inEnglish(shortcut.does).trim(), `${shortcut.id} says nothing`);
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

  test("Mac agent and workspace numbers have distinct hints, with the other platforms unchanged", () => {
    assert.deepEqual(keysFor("sidebarAgent", "mac"), ["⌘1", "⌘9"]);
    assert.deepEqual(keysFor("workspace", "mac"), ["⌥⌘1", "⌥⌘9"]);
    assert.deepEqual(keysFor("workspace", "other"), ["Ctrl+1", "Ctrl+9"]);
    assert.deepEqual(keysFor("sidebarAgent", "other"), []);
    assert.deepEqual(keysFor("sidebarAgent", "mac", false), []);
    const workspace = shortcutSheet(true, "mac").flatMap((group) => group.shortcuts).find((s) => s.id === "workspace")!;
    assert.deepEqual(workspace.keys.map((chord) => chordLabel(chord, "mac")), ["⌥⌘1", "⌥⌘9"]);
    for (const [desktop, platform] of [[false, "mac"], [true, "other"], [false, "other"]] as const) {
      assert.ok(!shortcutSheet(desktop, platform).flatMap((group) => group.shortcuts).some((s) => s.id === "sidebarAgent"));
    }
  });

  test("the numbered agent hint follows the chosen language", async () => {
    const before = getLanguage();
    try {
      const agent = shortcutSheet(true, "mac").flatMap((group) => group.shortcuts).find((s) => s.id === "sidebarAgent")!;
      assert.ok(agent.when);
      await setLanguage("en");
      const english = [t(agent.does), t(agent.when)];
      assert.deepEqual(english, ["Go to an agent in the sidebar", "first to ninth agent, skipping folded sections"]);
      for (const { code } of LANGUAGES) {
        await setLanguage(code);
        const translated: string[] = [t(agent.does), t(agent.when)];
        assert.ok(translated.every((line) => line.trim()), code);
        if (code !== "en") {
          assert.notEqual(translated[0], english[0], code);
          assert.notEqual(translated[1], english[1], code);
        }
      }
      assert.deepEqual(agent.keys.map((chord) => chordLabel(chord, "mac")), ["⌘1", "⌘9"]);
    } finally {
      await setLanguage(before);
    }
  });

  test("Esc stops the agent, and says where, since it also closes things and ends dictation", () => {
    assert.deepEqual(keysFor("stop", "mac"), ["esc"]);
    assert.deepEqual(keysFor("stop", "other"), ["Esc"]);
    const stop = SHORTCUTS.find((s) => s.id === "stop")!;
    assert.equal(stop.group, "composer");
    assert.match(inEnglish(stop.when!), /while it is working/);
    // the two it shares the key with are still there
    assert.deepEqual(keysFor("stopDictation", "mac"), ["esc"]);
    assert.deepEqual(keysFor("close", "mac"), ["esc"]);
  });

  test("the conversation tabs have a browser's keys, ⌘ on a Mac and Ctrl elsewhere (#401)", () => {
    assert.deepEqual(keysFor("newConversation", "mac"), ["⌘T"]);
    assert.deepEqual(keysFor("newConversation", "other"), ["Ctrl+T"]);
    assert.deepEqual(keysFor("closeConversation", "mac"), ["⌘W"]);
    assert.deepEqual(keysFor("closeConversation", "other"), ["Ctrl+W"]);
    assert.deepEqual(keysFor("conversationStep", "mac"), ["⇧⌘[", "⇧⌘]"]);
    assert.deepEqual(keysFor("conversationStep", "other"), ["Ctrl+Shift+[", "Ctrl+Shift+]"]);
    assert.deepEqual(keysFor("tabArrows", "mac"), ["←", "→", "Home", "End"]);
    assert.deepEqual(keysFor("laneArrows", "other"), ["↑", "↓", "Home", "End"]);
    // ⌘W's old meaning, which only the Mac's menu bar has
    assert.deepEqual(keysFor("closeWindow", "mac"), ["⇧⌘W"]);
    assert.deepEqual(keysFor("closeWindow", "other"), []);
  });

  test("closing says it asks first and that General stays, and stepping says the terminal's keys win in it", () => {
    const close = SHORTCUTS.find((s) => s.id === "closeConversation")!;
    assert.match(inEnglish(close.when!), /asks first/);
    assert.match(inEnglish(close.when!), /General/);
    assert.match(inEnglish(SHORTCUTS.find((s) => s.id === "conversationStep")!.when!), /outside the terminal/);
    assert.match(inEnglish(SHORTCUTS.find((s) => s.id === "terminalStep")!.when!), /in the terminal/);
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
      ["navigation", "conversation", "composer", "terminal", "app"],
    );
  });

  test("a browser tab leaves out the keys the browser keeps for itself", () => {
    const ids = (desktop: boolean) => shortcutSheet(desktop).flatMap((g) => g.shortcuts.map((s) => s.id));
    assert.ok(ids(true).includes("recent"));
    assert.ok(!ids(false).includes("recent"), "Ctrl+Tab never reaches a page in a browser");
    assert.ok(ids(false).includes("palette"));
  });

  test("the tabs' keys are the app's alone, and Close Window only a Mac's", () => {
    const ids = (desktop: boolean, platform: "mac" | "other") =>
      shortcutSheet(desktop, platform).flatMap((g) => g.shortcuts.map((s) => s.id));
    for (const id of ["newConversation", "closeConversation", "conversationStep"]) {
      assert.ok(ids(true, "mac").includes(id), `${id} is missing from the app's sheet`);
      assert.ok(ids(true, "other").includes(id), `${id} is missing on Windows and Linux`);
      assert.ok(!ids(false, "mac").includes(id), `a browser keeps ${id}'s key for its own tabs`);
    }
    assert.ok(ids(true, "mac").includes("closeWindow"));
    assert.ok(!ids(true, "other").includes("closeWindow"));
    // and a browser tab's palette shows no key the browser will not pass on
    assert.deepEqual(keysFor("newConversation", "mac", false), []);
    assert.deepEqual(keysFor("find", "mac", false), ["⌘F"]);
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
