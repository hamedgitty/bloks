// The side dock (GitHub 509, 522, 523): one column for every panel beside
// a conversation, remembered per conversation. These walk what it keeps,
// what it forgets, and what it must not do on its own.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DOCK_SIDE_BY_SIDE,
  DOCK_SIZE,
  MAX_DOCS,
  MAX_PLACES,
  chatKey,
  clampDockWidth,
  closeDoc,
  dropPanel,
  hideDock,
  isRoomKey,
  openDoc,
  parseDock,
  pickPanel,
  placeIn,
  roomKey,
  selectDoc,
  showPanel,
  toggleDock,
  type DockState,
} from "../src/lib/dock.ts";
import { dockChord } from "../src/lib/dockKeys.ts";
import { keysFor } from "../src/lib/shortcuts.ts";

const empty = (): DockState => ({ places: {}, width: DOCK_SIZE.fallback });
const a = chatKey("bot1", "lane1");
const b = chatKey("bot1", "lane2");
const doc = (name: string) => ({ botId: "bot1", name, mime: "text/markdown", size: 10 });

describe("open, shown and hidden", () => {
  test("each conversation has its own dock", () => {
    const s = showPanel(empty(), a, "browser", 1);
    assert.equal(placeIn(s, a).open, true);
    assert.equal(placeIn(s, b).open, false, "another conversation's dock is untouched");
  });

  test("picking the panel already shown keeps it shown", () => {
    // the ribbon picks, the × closes: a second click on the same icon
    // closing the dock was easy to do by accident
    const s = showPanel(showPanel(empty(), a, "terminal", 1), a, "terminal", 2);
    assert.equal(placeIn(s, a).open, true);
    assert.equal(placeIn(s, a).panel, "terminal");
  });

  test("hiding keeps the panel and the documents for next time", () => {
    let s = openDoc(empty(), a, doc("report.md"), 1);
    s = hideDock(s, a, 2);
    assert.equal(placeIn(s, a).open, false);
    assert.equal(placeIn(s, a).panel, "docs");
    assert.equal(placeIn(s, a).docs.length, 1);
  });

  test("the header's toggle opens on what was shown last, if still offered", () => {
    let s = showPanel(empty(), a, "computer", 1);
    s = hideDock(s, a, 2);
    s = toggleDock(s, a, ["docs", "computer"], 3);
    assert.equal(placeIn(s, a).panel, "computer");
    s = toggleDock(s, a, ["docs", "computer"], 4);
    assert.equal(placeIn(s, a).open, false);
    // the browser went away (a phone looking at the Mac, say): it opens on
    // something offered instead
    s = showPanel(hideDock(s, a, 5), a, "browser", 6);
    s = toggleDock(hideDock(s, a, 7), a, ["docs", "computer"], 8);
    assert.equal(placeIn(s, a).panel, "computer");
  });

  test("with nothing said, documents open first, then the first panel offered", () => {
    assert.equal(pickPanel(placeIn(openDoc(empty(), a, doc("x.md")), a), ["docs", "browser"]), "docs");
    assert.equal(pickPanel(placeIn(empty(), a), ["docs", "browser", "terminal"]), "browser");
    assert.equal(pickPanel(placeIn(empty(), a), []), null);
  });

  test("a panel that goes away closes the dock rather than showing another", () => {
    const s = dropPanel(showPanel(empty(), a, "terminal", 1), a, "terminal", 2);
    assert.equal(placeIn(s, a).open, false);
    // and one that was not shown changes nothing
    const t = showPanel(empty(), a, "docs", 1);
    assert.equal(dropPanel(t, a, "terminal", 2), t);
  });
});

describe("documents", () => {
  test("opening one shows it in front, and opening it again adds no second tab", () => {
    let s = openDoc(empty(), a, doc("one.md"), 1);
    s = openDoc(s, a, doc("two.md"), 2);
    s = openDoc(s, a, doc("one.md"), 3);
    const place = placeIn(s, a);
    assert.deepEqual(place.docs.map((d) => d.name), ["one.md", "two.md"]);
    assert.equal(place.doc, "bot1/one.md");
    assert.equal(place.panel, "docs");
    assert.equal(place.open, true);
  });

  test("past the cap the oldest goes, never the one just opened", () => {
    let s = empty();
    for (let i = 0; i < MAX_DOCS + 3; i++) s = openDoc(s, a, doc(`f${i}.md`), i);
    const place = placeIn(s, a);
    assert.equal(place.docs.length, MAX_DOCS);
    assert.equal(place.docs[place.docs.length - 1].name, `f${MAX_DOCS + 2}.md`);
    assert.equal(place.doc, `bot1/f${MAX_DOCS + 2}.md`);
  });

  test("closing the one in front brings its neighbour forward", () => {
    let s = openDoc(openDoc(openDoc(empty(), a, doc("1.md")), a, doc("2.md")), a, doc("3.md"));
    s = selectDoc(s, a, "bot1/2.md");
    s = closeDoc(s, a, "bot1/2.md");
    assert.equal(placeIn(s, a).doc, "bot1/3.md");
    s = closeDoc(s, a, "bot1/3.md");
    assert.equal(placeIn(s, a).doc, "bot1/1.md");
  });

  test("closing the last one closes the dock it was shown in", () => {
    const s = closeDoc(openDoc(empty(), a, doc("only.md")), a, "bot1/only.md");
    assert.equal(placeIn(s, a).open, false);
    assert.equal(placeIn(s, a).docs.length, 0);
  });

  test("a file not open cannot be put in front", () => {
    const s = openDoc(empty(), a, doc("x.md"));
    assert.equal(selectDoc(s, a, "bot1/missing.md"), s);
  });
});

describe("kept on this device", () => {
  test("what was stored comes back, and nonsense in it is dropped", () => {
    let s = openDoc(empty(), a, doc("report.md"), 5);
    s = showPanel(s, b, "browser", 6);
    const raw = JSON.stringify({
      ...s.places,
      junk: 7,
      bad: { open: true, panel: "spaceship", docs: [{ name: 3 }, { botId: "x", name: "ok.md" }] },
    });
    const back = parseDock(raw, "512");
    assert.equal(back.width, 512);
    assert.deepEqual(placeIn(back, a).docs.map((d) => d.name), ["report.md"]);
    assert.equal(placeIn(back, b).panel, "browser");
    assert.equal(back.places.junk, undefined);
    // a panel it does not know is no panel, and no panel is not open
    assert.equal(placeIn(back, "bad").panel, null);
    assert.equal(placeIn(back, "bad").open, false);
    assert.deepEqual(placeIn(back, "bad").docs.map((d) => d.name), ["ok.md"]);
  });

  test("an unreadable store is an empty dock, at the browser's old width if it had one", () => {
    const back = parseDock("{not json", null, "640");
    assert.deepEqual(back.places, {});
    assert.equal(back.width, 640);
    assert.equal(parseDock(null, null).width, DOCK_SIZE.fallback);
  });

  test("only the most recently touched conversations are remembered", () => {
    let s = empty();
    for (let i = 0; i < MAX_PLACES + 10; i++) s = showPanel(s, chatKey("b", `l${i}`), "docs", i);
    assert.equal(Object.keys(s.places).length, MAX_PLACES);
    assert.ok(s.places[chatKey("b", `l${MAX_PLACES + 9}`)]);
    assert.equal(s.places[chatKey("b", "l0")], undefined);
  });
});

describe("width", () => {
  test("the chat keeps its room, and the dock its own", () => {
    assert.equal(clampDockWidth(5000, 1200), 1200 - DOCK_SIZE.chat);
    assert.equal(clampDockWidth(10, 1200), DOCK_SIZE.min);
    assert.equal(clampDockWidth(Number.NaN, 1600), DOCK_SIZE.fallback);
    assert.equal(DOCK_SIDE_BY_SIDE, DOCK_SIZE.min + DOCK_SIZE.chat);
  });
});

describe("rooms and keys", () => {
  test("a room is one conversation, told apart from a chat", () => {
    assert.equal(isRoomKey(roomKey("r1")), true);
    assert.equal(isRoomKey(chatKey("b", "l")), false);
  });

  test("⌘⌥B on a Mac and Ctrl+Alt+B elsewhere, by the key's place", () => {
    const press = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
      key: "∫", code: "KeyB", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, ...over,
    });
    assert.equal(dockChord(press({ metaKey: true }), "mac"), true, "Option turns b into ∫ on a Mac");
    assert.equal(dockChord(press({ ctrlKey: true, key: "b" }), "other"), true);
    assert.equal(dockChord(press({ metaKey: true, altKey: false }), "mac"), false, "⌘B is the sidebar's");
    assert.equal(dockChord(press({ metaKey: true, shiftKey: true }), "mac"), false);
    assert.deepEqual(keysFor("dockToggle", "mac").length, 1);
  });
});
