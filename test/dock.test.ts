// The side dock (GitHub 509, 522, 523): one column for every panel beside
// a conversation, remembered per conversation. These walk what it keeps,
// what it forgets, and what it must not do on its own.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DOCK_SIDE_BY_SIDE,
  DOCK_SIZE,
  EMPTY_PLACE,
  REVEAL_WIDTH,
  dock,
  mayReveal,
  MAX_DOCS,
  MAX_PLACES,
  chatKey,
  clampDockWidth,
  closeDoc,
  closeTab,
  sideForNew,
  minimizeTab,
  dismissMini,
  restoreTab,
  moveMini,
  minimizedIn,
  canMinimize,
  clampPaneHeight,
  ACROSS_SIZE,
  dropPanel,
  moveTab,
  paneOf,
  shownAnywhere,
  sideOf,
  tabsOn,
  mayShow,
  hideDock,
  isRoomKey,
  openDoc,
  parseDock,
  placeIn,
  roomKey,
  selectDoc,
  showPanel,
  toggleDock,
  type DockState,
} from "../src/lib/dock.ts";
import { dockChord, expandChord, panelChord } from "../src/lib/dockKeys.ts";
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
    // the tab still offered instead
    s = showPanel(hideDock(s, a, 5), a, "browser", 6);
    s = toggleDock(hideDock(s, a, 7), a, ["docs", "computer"], 8);
    assert.equal(placeIn(s, a).panel, "computer");
  });

  test("with no tab, the toggle opens the right pane on its list and opens nothing for the person", () => {
    let s = toggleDock(empty(), a, ["docs", "browser", "terminal"], 1);
    assert.equal(placeIn(s, a).open, true);
    assert.equal(placeIn(s, a).panel, null);
    assert.deepEqual(placeIn(s, a).tabs, []);
    // a tab moved to the bottom stays there; the right still opens on its list
    s = moveTab(showPanel(hideDock(s, a, 2), a, "terminal", 3), a, "terminal", "bottom", 4);
    s = toggleDock(hideDock(s, a, 5), a, ["docs", "terminal"], 6);
    assert.equal(placeIn(s, a).open, true);
    assert.equal(placeIn(s, a).panel, null);
    assert.equal(paneOf(placeIn(s, a), "bottom").panel, "terminal");
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

  test("closing the last one leaves the Files panel on its tree", () => {
    const s = closeDoc(openDoc(empty(), a, doc("only.md")), a, "bot1/only.md");
    assert.equal(placeIn(s, a).open, true);
    assert.equal(placeIn(s, a).panel, "docs");
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

describe("opened by an agent's work", () => {
  const wide = { width: REVEAL_WIDTH + 200, typingInDock: false };

  test("only a chat, never a room, and only with room beside it", () => {
    assert.equal(mayReveal(a, EMPTY_PLACE, "computer", wide), true);
    assert.equal(mayReveal(roomKey("r1"), EMPTY_PLACE, "computer", wide), false, "several agents would pull a room's dock about");
    assert.equal(mayReveal(null, EMPTY_PLACE, "computer", wide), false);
    assert.equal(mayReveal(a, EMPTY_PLACE, "computer", { ...wide, width: REVEAL_WIDTH - 1 }), false, "it would cover the chat");
  });

  test("never from under the person's keys, and never after a no", () => {
    const showingBrowser = placeIn(showPanel(empty(), a, "browser", 1), a);
    assert.equal(mayReveal(a, showingBrowser, "computer", { ...wide, typingInDock: true }), false);
    assert.equal(mayReveal(a, showingBrowser, "computer", wide), true);
    assert.equal(mayReveal(a, EMPTY_PLACE, "computer", { ...wide, typingInDock: true }), true, "a closed dock has nothing being typed into");
    assert.equal(mayReveal(a, EMPTY_PLACE, "computer", { ...wide, declined: true }), false);
    const showingComputer = placeIn(showPanel(empty(), a, "computer", 1), a);
    assert.equal(mayReveal(a, showingComputer, "computer", wide), false, "already in front");
  });

  test("a panel put away after an agent's work opened it stays away there, until the person opens it", () => {
    const key = chatKey("reveal-bot", "lane");
    const other = chatKey("reveal-bot", "other");
    const width = REVEAL_WIDTH + 100;
    dock.setCurrent(key);
    assert.equal(dock.reveal("computer", width), true);
    assert.equal(placeIn(dock.get(), key).panel, "computer");
    assert.equal(dock.reveal("computer", width), false, "already showing");
    dock.hide(key);
    assert.equal(dock.reveal("computer", width), false, "the person said no");
    assert.equal(dock.reveal("browser", width), true, "the no was to the computer only");
    dock.show(key, "docs");
    assert.equal(dock.reveal("browser", width), false, "picking another panel puts the browser away too");
    dock.setCurrent(other);
    assert.equal(dock.reveal("computer", width), true, "another conversation asks for itself");
    dock.setCurrent(key);
    dock.show(key, "computer");
    dock.hide(key);
    assert.equal(dock.reveal("computer", width), true, "opened by hand, it may be opened again");
    assert.equal(dock.reveal("computer", REVEAL_WIDTH - 1), false);
  });
});

describe("panels as tabs", () => {
  test("each panel shown joins the tabs once, in the order they were opened", () => {
    let s = showPanel(empty(), a, "changes", 1);
    s = showPanel(s, a, "terminal", 2);
    s = showPanel(s, a, "changes", 3);
    assert.deepEqual(placeIn(s, a).tabs, ["changes", "terminal"]);
    assert.equal(placeIn(s, a).panel, "changes");
    s = openDoc(s, a, doc("x.md"), 4);
    assert.deepEqual(placeIn(s, a).tabs, ["changes", "terminal", "docs"]);
  });

  test("closing the tab in front brings its neighbour forward, and the last one leaves the list", () => {
    let s = showPanel(showPanel(showPanel(empty(), a, "docs", 1), a, "changes", 2), a, "terminal", 3);
    s = showPanel(s, a, "changes", 4);
    s = closeTab(s, a, "changes", 5);
    assert.deepEqual(placeIn(s, a).tabs, ["docs", "terminal"]);
    assert.equal(placeIn(s, a).panel, "terminal", "the one that took its place");
    assert.equal(placeIn(s, a).open, true);
    s = closeTab(s, a, "docs", 6);
    assert.equal(placeIn(s, a).panel, "terminal", "a tab behind closes without moving the one in front");
    s = closeTab(s, a, "terminal", 7);
    assert.equal(placeIn(s, a).open, true, "the right pane stays open on its list");
    assert.equal(placeIn(s, a).panel, null);
    assert.equal(closeTab(s, a, "browser", 8), s, "a tab not open is no change");
  });

  test("a closed tab keeps what its panel held", () => {
    let s = openDoc(empty(), a, doc("kept.md"), 1);
    s = closeTab(s, a, "docs", 2);
    assert.equal(placeIn(s, a).docs.length, 1);
  });

  test("toggling back opens on an open tab before anything else", () => {
    let s = showPanel(showPanel(empty(), a, "changes", 1), a, "terminal", 2);
    s = closeTab(s, a, "terminal", 3);
    s = hideDock(s, a, 4);
    s = toggleDock(s, a, ["docs", "changes", "browser"], 5);
    assert.equal(placeIn(s, a).panel, "changes");
  });

  test("a place kept before there were tabs has its panel as its one tab", () => {
    const back = parseDock(JSON.stringify({ [a]: { open: true, panel: "browser", docs: [], doc: null, at: 1 }, [b]: { open: false, panel: null, at: 2 } }), null);
    assert.deepEqual(placeIn(back, a).tabs, ["browser"]);
    assert.deepEqual(placeIn(back, b).tabs, []);
    const kept = parseDock(JSON.stringify({ [a]: { open: true, panel: "docs", tabs: ["changes", "spaceship", "changes"], at: 1 } }), null);
    assert.deepEqual(placeIn(kept, a).tabs, ["changes", "docs"], "unknown and repeated tabs dropped, the shown one kept");
  });

  test("a panel that went away leaves the tabs too", () => {
    let s = showPanel(showPanel(empty(), a, "terminal", 1), a, "docs", 2);
    s = dropPanel(s, a, "terminal", 3);
    assert.deepEqual(placeIn(s, a).tabs, ["docs"]);
    assert.equal(placeIn(s, a).open, true, "the one in front stays");
  });

  test("⇧⌘F, ⇧⌘D, ⇧⌘B and ⌘J name their panels, Ctrl off a Mac", () => {
    const press = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
      key: "x", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
    });
    assert.equal(panelChord(press({ metaKey: true, shiftKey: true, code: "KeyF" }), "mac"), "docs");
    assert.equal(panelChord(press({ metaKey: true, shiftKey: true, code: "KeyD" }), "mac"), "changes");
    assert.equal(panelChord(press({ ctrlKey: true, shiftKey: true, key: "B" }), "other"), "browser");
    assert.equal(panelChord(press({ metaKey: true, code: "KeyJ" }), "mac"), "terminal");
    assert.equal(panelChord(press({ metaKey: true, code: "KeyF" }), "mac"), null, "⌘F is find");
    assert.equal(panelChord(press({ ctrlKey: true, code: "KeyJ" }), "mac"), null, "Ctrl is not ⌘ on a Mac");
    assert.equal(panelChord(press({ metaKey: true, altKey: true, shiftKey: true, code: "KeyB" }), "mac"), null);
  });
});

describe("shown by an agent on purpose", () => {
  const wide = { width: REVEAL_WIDTH + 200, typingInDock: false, turn: "m2" };

  test("chats only, with room, and never under the person's keys", () => {
    assert.equal(mayShow(a, EMPTY_PLACE, wide), true);
    assert.equal(mayShow(roomKey("r"), EMPTY_PLACE, wide), false);
    assert.equal(mayShow(a, EMPTY_PLACE, { ...wide, width: REVEAL_WIDTH - 1 }), false);
    const open = placeIn(showPanel(empty(), a, "terminal", 1), a);
    assert.equal(mayShow(a, open, { ...wide, typingInDock: true }), false);
    assert.equal(mayShow(a, open, wide), true, "the panel in front may be asked for again, for a file or a tab in it");
  });

  test("a no lasts the turn it was given in", () => {
    assert.equal(mayShow(a, EMPTY_PLACE, { ...wide, declinedIn: "m2" }), false);
    assert.equal(mayShow(a, EMPTY_PLACE, { ...wide, declinedIn: "m1" }), true, "asked again on a later turn");
    assert.equal(mayShow(a, EMPTY_PLACE, { ...wide, declinedIn: "" , turn: "" }), false, "no turn known is the same turn");
  });

  test("only the conversation it answers, kept for when it is on screen, and a closed panel stays closed for the turn", async () => {
    const key = chatKey("ask-bot", "lane");
    const other = chatKey("ask-bot", "other");
    const width = REVEAL_WIDTH + 100;
    dock.setCurrent(key);
    dock.noteTurn(key, "turn1", ["docs", "changes", "terminal"]);
    assert.equal(dock.ask({ botId: "ask-bot", threadId: "lane", panel: "changes", target: { kind: "change", path: "a.ts", line: 3 } }, width), true);
    assert.equal(placeIn(dock.get(), key).panel, "changes");
    assert.equal(dock.focus(key)?.target?.kind, "change");
    dock.closeTab(key, "changes");
    assert.equal(dock.ask({ botId: "ask-bot", threadId: "lane", panel: "changes" }, width), false, "closed in this turn");
    dock.noteTurn(key, "turn2", ["docs", "changes", "terminal"]);
    assert.equal(dock.ask({ botId: "ask-bot", threadId: "lane", panel: "changes" }, width), true, "a later turn may ask again");
    assert.equal(dock.ask({ botId: "ask-bot", threadId: "lane", panel: "browser" }, width), false, "a panel this conversation does not offer");
    // asked from a conversation not on screen: kept, and shown on return
    dock.setCurrent(other);
    assert.equal(dock.ask({ botId: "ask-bot", threadId: "lane", panel: "terminal" }, width), false);
    assert.notEqual(placeIn(dock.get(), key).panel, "terminal");
    // kept asks are judged by the window's width when they are shown
    const g = globalThis as { window?: unknown };
    g.window = { innerWidth: width };
    try {
      dock.setCurrent(key);
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      delete g.window;
    }
    assert.equal(placeIn(dock.get(), key).panel, "terminal");
  });

  test("a document asked for opens in Files", () => {
    const key = chatKey("ask-doc", "lane");
    dock.setCurrent(key);
    dock.noteTurn(key, "t", ["docs"]);
    assert.equal(dock.ask({ botId: "ask-doc", threadId: "lane", panel: "docs", target: { kind: "doc", botId: "ask-doc", name: "notes/a.md", mime: "text/markdown", size: 4, line: 7 } }, REVEAL_WIDTH + 1), true);
    const place = placeIn(dock.get(), key);
    assert.equal(place.panel, "docs");
    assert.equal(place.doc, "ask-doc/notes/a.md");
  });
});

describe("panes on every side", () => {
  test("a tab moved to the bottom opens a pane there, and the right brings its neighbour forward", () => {
    let s = showPanel(showPanel(empty(), a, "changes", 1), a, "terminal", 2);
    s = moveTab(s, a, "terminal", "bottom", 3);
    const place = placeIn(s, a);
    assert.equal(sideOf(place, "terminal"), "bottom");
    assert.deepEqual(paneOf(place, "bottom"), { open: true, panel: "terminal" });
    assert.equal(place.panel, "changes", "the right pane shows what was beside it");
    assert.equal(place.open, true);
    assert.deepEqual(tabsOn(place, "right"), ["changes"]);
    assert.deepEqual(tabsOn(place, "bottom"), ["terminal"]);
    assert.equal(shownAnywhere(place, "terminal"), true);
    assert.equal(shownAnywhere(place, "changes"), true, "both panes show at once");
  });

  test("the last tab leaving a pane closes it, and moving back to the right forgets the side", () => {
    let s = showPanel(empty(), a, "docs", 1);
    s = moveTab(s, a, "docs", "left", 2);
    assert.equal(placeIn(s, a).open, false, "nothing left on the right");
    s = moveTab(s, a, "docs", "right", 3);
    const place = placeIn(s, a);
    assert.equal(sideOf(place, "docs"), "right");
    assert.equal(place.sides?.docs, undefined);
    assert.equal(paneOf(place, "left").open, false);
    assert.equal(place.panel, "docs");
  });

  test("a new tab of a kind open in another pane goes to that pane", () => {
    // the browser on the right, the terminal moved to the bottom
    let s = showPanel(showPanel(empty(), a, "browser", 1), a, "terminal", 2);
    s = moveTab(s, a, "terminal", "bottom", 3);
    const place = placeIn(s, a);
    assert.equal(sideForNew(place, "browser", "bottom"), "right", "a page asked for in the terminal's pane joins the browser's");
    assert.equal(sideForNew(place, "terminal", "right"), "bottom", "a shell asked for in the browser's pane joins the terminal's");
    assert.equal(sideForNew(place, "changes", "bottom"), "bottom", "a kind open nowhere comes to the pane that asked");
    // closed, it is open nowhere, and comes where it is asked for
    s = closeTab(s, a, "browser", 4);
    assert.equal(sideForNew(placeIn(s, a), "browser", "bottom"), "bottom");
  });

  test("a minimized tab leaves its pane for a corner, and comes back as a tab", () => {
    let s = showPanel(showPanel(empty(), a, "changes", 1), a, "browser", 2);
    s = minimizeTab(s, a, "browser", 3);
    let place = placeIn(s, a);
    assert.deepEqual(minimizedIn(place), [{ panel: "browser", corner: "top-right" }]);
    assert.deepEqual(place.tabs, ["changes"], "no longer a tab");
    assert.equal(place.panel, "changes", "its neighbour comes forward");
    s = minimizeTab(s, a, "changes", 4);
    place = placeIn(s, a);
    assert.equal(place.open, true, "the right pane stays open on its list");
    assert.equal(place.panel, null);
    assert.equal(canMinimize(place, "terminal"), false, "two at most");
    const withTerminal = showPanel(s, a, "terminal", 5);
    assert.equal(minimizeTab(withTerminal, a, "terminal", 6), withTerminal, "a third is refused");
    s = moveMini(s, a, "browser", "bottom-left", 7);
    assert.equal(minimizedIn(placeIn(s, a)).find((m) => m.panel === "browser")?.corner, "bottom-left");
    s = restoreTab(s, a, "browser", 8);
    place = placeIn(s, a);
    assert.deepEqual(minimizedIn(place).map((m) => m.panel), ["changes"]);
    assert.equal(place.panel, "browser");
    assert.ok(place.tabs.includes("browser"));
    // showing a minimized panel by its key or the list puts it back too
    s = showPanel(s, a, "changes", 9);
    assert.deepEqual(minimizedIn(placeIn(s, a)), []);
  });

  test("a minimized window closed keeps its panel as a tab for the side panel, unopened", () => {
    let s = minimizeTab(showPanel(showPanel(empty(), a, "changes", 1), a, "browser", 2), a, "browser", 3);
    s = hideDock(s, a, 4);
    s = dismissMini(s, a, "browser", 5);
    let place = placeIn(s, a);
    assert.deepEqual(minimizedIn(place), []);
    assert.ok(place.tabs.includes("browser"), "a tab again");
    assert.equal(place.open, false, "the side panel is not opened for it");
    assert.equal(place.panel, "changes", "the tab that was in front stays in front");
    // on a pane open on its list, it is what the list gives way to
    s = minimizeTab(showPanel(empty(), a, "terminal", 6), a, "terminal", 7);
    s = dismissMini(s, a, "terminal", 8);
    place = placeIn(s, a);
    assert.equal(place.open, true);
    assert.equal(place.panel, "terminal");
  });

  test("a minimized panel is in view: an agent's work does not open it again, and it is kept", () => {
    const s = minimizeTab(showPanel(empty(), a, "browser", 1), a, "browser", 2);
    assert.equal(mayReveal(a, placeIn(s, a), "browser", { width: 4000, typingInDock: false }), false);
    const back = parseDock(JSON.stringify(s.places), null);
    assert.deepEqual(minimizedIn(placeIn(back, a)), [{ panel: "browser", corner: "top-right" }]);
    const odd = parseDock(JSON.stringify({ [a]: { open: false, panel: null, tabs: ["docs"], minimized: [{ panel: "docs", corner: "top-right" }, { panel: "browser", corner: "middle" }, { panel: "trace", corner: "bottom-left" }] } }), null);
    assert.deepEqual(minimizedIn(placeIn(odd, a)), [{ panel: "trace", corner: "bottom-left" }], "a tab, an unknown corner dropped");
  });

  test("showing, closing and hiding happen on the panel's own side", () => {
    let s = moveTab(showPanel(empty(), a, "terminal", 1), a, "terminal", "bottom", 2);
    s = showPanel(s, a, "changes", 3);
    s = moveTab(s, a, "changes", "bottom", 4);
    s = showPanel(s, a, "terminal", 5);
    assert.equal(paneOf(placeIn(s, a), "bottom").panel, "terminal");
    s = closeTab(s, a, "terminal", 6);
    assert.equal(paneOf(placeIn(s, a), "bottom").panel, "changes", "its neighbour on the bottom comes forward");
    s = hideDock(s, a, 7, "bottom");
    assert.equal(paneOf(placeIn(s, a), "bottom").open, false);
    assert.equal(paneOf(placeIn(s, a), "bottom").panel, "changes", "hidden, not forgotten");
  });

  test("where each panel sits is remembered, and nonsense in it is dropped", () => {
    let s = moveTab(showPanel(showPanel(empty(), a, "browser", 1), a, "terminal", 2), a, "terminal", "top", 3);
    const raw = JSON.stringify({ ...s.places, odd: { open: true, panel: "browser", tabs: ["browser"], sides: { browser: "sky", spaceship: "left" }, panes: { sky: { open: true } } } });
    const back = parseDock(raw, "500", null, JSON.stringify({ bottom: 240, left: "x", top: -3 }));
    assert.equal(sideOf(placeIn(back, a), "terminal"), "top");
    assert.deepEqual(paneOf(placeIn(back, a), "top"), { open: true, panel: "terminal" });
    assert.equal(placeIn(back, a).panel, "browser");
    assert.equal(placeIn(back, "odd").sides, undefined);
    assert.equal(placeIn(back, "odd").panes, undefined);
    assert.deepEqual(back.sizes, { bottom: 240 }, "only sizes that are sizes");
  });

  test("a pane across keeps room for the conversation", () => {
    assert.equal(clampPaneHeight(5000, 900), 900 - ACROSS_SIZE.chat);
    assert.equal(clampPaneHeight(10, 900), ACROSS_SIZE.min);
    assert.equal(clampPaneHeight(Number.NaN, 900), ACROSS_SIZE.fallback);
  });

  test("an agent's work does not open a panel already on screen in another pane", () => {
    const s = moveTab(showPanel(empty(), a, "computer", 1), a, "computer", "bottom", 2);
    assert.equal(mayReveal(a, placeIn(s, a), "computer", { width: REVEAL_WIDTH + 1, typingInDock: false }), false);
  });

  test("⇧⌘\\ expands, Ctrl off a Mac", () => {
    const press = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
      key: "|", code: "Backslash", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, ...over,
    });
    assert.equal(expandChord(press({ metaKey: true }), "mac"), true);
    assert.equal(expandChord(press({ ctrlKey: true }), "other"), true);
    assert.equal(expandChord(press({ metaKey: true, shiftKey: false }), "mac"), false);
  });

  test("the person moving a panel an agent opened out of sight is not a no; hiding it is", () => {
    const key = chatKey("move-bot", "lane");
    dock.setCurrent(key);
    assert.equal(dock.reveal("computer", REVEAL_WIDTH + 10), true);
    dock.move(key, "computer", "bottom");
    assert.equal(shownAnywhere(placeIn(dock.get(), key), "computer"), true);
    dock.hide(key, "bottom");
    dock.show(key, "docs");
    assert.equal(dock.reveal("computer", REVEAL_WIDTH + 10), false, "put away after an agent opened it");
  });
});
