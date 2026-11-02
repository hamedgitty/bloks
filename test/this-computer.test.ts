// The word for the machine, which is not always "Mac".
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import fs from "node:fs";
import path from "node:path";

import { LANGUAGES, setLanguage, t } from "../src/lib/i18n.ts";
import { headline } from "../src/lib/hostingMove.ts";
import {
  deviceWord,
  fromThisComputer,
  meetingNotesHere,
  onThisComputer,
  onYourComputer,
  thisComputer,
  toThisComputer,
  yourComputer,
} from "../src/lib/thisComputer.ts";

describe("deviceWord", () => {
  test("a Mac is a Mac", () => {
    assert.equal(deviceWord("MacIntel"), "Mac");
    assert.equal(thisComputer("MacIntel"), "this Mac");
    assert.equal(yourComputer("MacIntel"), "your Mac");
  });

  test("Windows is a PC, which is what the issue was about", () => {
    assert.equal(deviceWord("Win32"), "PC");
    assert.equal(thisComputer("Win32"), "this PC");
    assert.equal(yourComputer("Win32"), "your PC");
  });

  test("Linux gets the neutral word rather than a wrong one", () => {
    assert.equal(deviceWord("Linux x86_64"), "computer");
    assert.equal(thisComputer("X11; Ubuntu"), "this computer");
  });

  test("an unknown platform is never guessed as a Mac", () => {
    assert.equal(deviceWord("Something else entirely"), "computer");
    assert.equal(deviceWord(""), "computer");
  });
});

describe("after on, to and from", () => {
  test("English says the same words in each place", () => {
    assert.equal(onThisComputer("Win32"), "this PC");
    assert.equal(toThisComputer("MacIntel"), "this Mac");
    assert.equal(fromThisComputer("Linux x86_64"), "this computer");
    assert.equal(onYourComputer("Win32"), "your PC");
  });

  test("every language has each place, so none falls back to English mid-sentence", () => {
    const dir = path.resolve(import.meta.dirname, "..", "src", "locales");
    for (const { code } of LANGUAGES) {
      const words = JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), "utf8")) as Record<string, string>;
      for (const place of ["thisOn", "thisTo", "thisFrom", "yourOn"]) {
        for (const kind of ["mac", "pc", "computer"]) assert.ok(words[`thisComputer.${place}.${kind}`], `${code}: thisComputer.${place}.${kind}`);
      }
    }
  });

  test("German declines the noun there, and Portuguese folds its preposition in", async () => {
    try {
      await setLanguage("de");
      assert.equal(t("moveHome.moveToThisMac", { computer: toThisComputer("Win32") }), "Auf diesen PC verschieben");
      assert.equal(t("movedBanner.removeFromThisMac", { computer: fromThisComputer("MacIntel") }), "Von diesem Mac entfernen");
      assert.match(t("aboutPage.itRunsOnAMachine", { computer: onYourComputer("Linux x86_64") }), /nicht auf deinem Computer\./);
      await setLanguage("pt-BR");
      assert.equal(t("movedBanner.removeFromThisMac", { computer: fromThisComputer("Linux x86_64") }), "Remover deste computador");
      assert.equal(t("moveHome.moveToThisMac", { computer: toThisComputer("Win32") }), "Mover para este PC");
      assert.equal(t("libHostingMove.headline.doneMac", { name: "Pessoal", computer: onThisComputer("Win32") }), "Pessoal está neste PC");
    } finally {
      await setLanguage("en");
    }
  });

  test("a move home goes to this computer, and lands in a workspace on it", async () => {
    try {
      await setLanguage("de");
      const home = { direction: "to-mac" as const, from: { id: "ws_h", name: "Hosted" }, to: { id: null, name: "Hosted" }, phase: "running" as const };
      assert.match(headline(home), /^Hosted wird auf diese[nm] (Mac|PC|Computer) verschoben$/);
      assert.match(headline(home), / diesen /, "going there takes the accusative");
      assert.match(headline({ ...home, to: { id: "ws_n", name: "Neu" } }), / diesem .* nach Neu /, "a workspace on it takes the dative");
      assert.match(headline({ ...home, phase: "done" }), /^Hosted ist auf diesem /);
    } finally {
      await setLanguage("en");
    }
  });
});

describe("meetingNotesHere", () => {
  test("the desktop app on a Mac offers them", () => {
    assert.equal(meetingNotesHere(true, false, "MacIntel"), true);
  });

  test("the desktop app on Windows or Linux does not, though its bridge has the call", () => {
    assert.equal(meetingNotesHere(true, false, "Win32"), false);
    assert.equal(meetingNotesHere(true, false, "Linux x86_64"), false);
  });

  test("a browser, or a window onto a hosted workspace, does not, even on a Mac", () => {
    assert.equal(meetingNotesHere(false, false, "MacIntel"), false);
    assert.equal(meetingNotesHere(true, true, "MacIntel"), false);
  });
});
