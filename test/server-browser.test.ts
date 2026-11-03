// The Bloks browser a server keeps for itself (server/server-browser.ts),
// driven against a fake Chrome in this process (helpers/fake-cdp-browser.mjs):
// the person opens a page and watches it as pictures, sized to their
// panel; their clicks and keys reach the page, and take it over from an
// agent; an agent's commands are the very ones the app's browser runs,
// held to the workspace's rules through server/app-browser.ts; pages are
// guarded on every navigation and popup; downloads are named and kept;
// and a browser that goes away is started again on the next use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromeFor, missingForAgent, readInput, readViewport, ServerBrowser, type CdpLine } from "../server/server-browser.ts";
import { BrowserGate, browserRoute, type RouteDeps } from "../server/app-browser.ts";
import { fakeBrowser, type FakeBrowser } from "./helpers/fake-cdp-browser.mjs";

const until = async <T,>(check: () => T | null | undefined | false, ms = 5_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function world({ chrome = true, watchMs = 400 }: { chrome?: boolean; watchMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-server-browser-"));
  const fakes: FakeBrowser[] = [];
  const reveals: string[] = [];
  const states: unknown[] = [];
  const browser = new ServerBrowser({
    profileDir: join(home, "browser-session"),
    downloadsDir: join(home, "browser-downloads"),
    chrome: () => (chrome ? { binary: "/fake/chrome" } : { missing: "none" }),
    connect: async (): Promise<CdpLine> => {
      const fake = fakeBrowser();
      fakes.push(fake);
      return fake.line;
    },
    ownPorts: () => [8799],
    onChange: (state) => states.push(state),
    onReveal: (by) => reveals.push(by),
    stateDelayMs: 1,
    watchMs,
    idleMs: 60_000,
  });
  const fake = () => fakes[fakes.length - 1]!;
  const page = (tabId?: string) => {
    const tab = browser.browser.tab(tabId ?? browser.state().activeTabId ?? "") as unknown as { targetId: string } | null;
    return tab ? fake().targets.get(tab.targetId)! : null;
  };
  return { home, browser, fakes, fake, page, reveals, states, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("which Chrome: BLOKS_BROWSER first, off when it says so, else whatever is installed", () => {
  assert.deepEqual(chromeFor({ BLOKS_BROWSER: "off" }, () => "/usr/bin/chromium"), { missing: "off" });
  assert.deepEqual(chromeFor({ BLOKS_BROWSER: "/no/such/chrome" }, () => "/usr/bin/chromium"), { missing: "path" });
  assert.deepEqual(chromeFor({ BLOKS_BROWSER: process.execPath }, () => null), { binary: process.execPath });
  assert.deepEqual(chromeFor({}, () => "/usr/bin/chromium"), { binary: "/usr/bin/chromium" });
  assert.deepEqual(chromeFor({}, () => null), { missing: "none" });
  assert.match(missingForAgent("none"), /no Chrome here\. Ask the person to install Google Chrome or Chromium/);
  assert.match(missingForAgent("off"), /turned off on this server/);
});

test("the person's input is checked and bounded before any of it reaches a page", () => {
  assert.deepEqual(readInput({ events: [] }), { error: "events is a list of input" });
  assert.match((readInput({ events: Array.from({ length: 65 }, () => ({ t: "text", text: "a" })) }) as { error: string }).error, /at most 64/);
  assert.match((readInput({ events: [{ t: "script", code: "alert(1)" }] }) as { error: string }).error, /mouse, wheel, key or text/);
  assert.match((readInput({ events: [{ t: "key", type: "down" }] }) as { error: string }).error, /key's name/);
  assert.match((readInput({ events: [{ t: "text", text: "x".repeat(5001) }] }) as { error: string }).error, /5000/);
  const read = readInput({
    events: [
      { t: "mouse", type: "down", x: -40, y: 1e9, button: "middle", buttons: 99, clicks: 9, mods: 255 },
      { t: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", mods: 4 },
      { t: "wheel", x: 5, y: 5, dx: 0, dy: 99999 },
    ],
  });
  assert.deepEqual(read, {
    events: [
      { t: "mouse", type: "down", x: 0, y: 10_000, button: "middle", buttons: 7, clicks: 3, mods: 15 },
      { t: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", mods: 4, repeat: false },
      { t: "wheel", x: 5, y: 5, dx: 0, dy: 5000, mods: 0 },
    ],
  });
  assert.deepEqual(readViewport({ width: 900.4, height: 600, scale: 2 }), { width: 900, height: 600, scale: 2 });
  // through Bloks Cloud a page pixel is one device pixel: half the bytes
  assert.deepEqual(readViewport({ width: 900, height: 600, scale: 2 }, { relay: true }), { width: 900, height: 600, scale: 1 });
  assert.deepEqual(readViewport({ width: 9000, height: 9000, scale: 9 }), { width: 2560, height: 1600, scale: 2 });
  assert.equal(readViewport({ width: 100, height: 600 }), null);
});

test("the person opens a page and watches it as pictures, laid out at their panel's size, and signed in as Chrome", async (t) => {
  const w = world();
  t.after(w.done);
  assert.equal(w.browser.running, false, "nothing starts until it is wanted");
  await w.browser.resize({ width: 700, height: 500, scale: 2 });

  assert.deepEqual(await w.browser.person("navigate", "docs.example"), { ok: true, url: "https://docs.example" });
  const tab = await until(() => w.page()?.url === "https://docs.example" && w.page());
  assert.equal(w.browser.running, true);
  assert.deepEqual(tab.viewport, { width: 700, height: 500, scale: 2 });
  assert.match(String(tab.userAgent), /Chrome\/141/);
  assert.doesNotMatch(String(tab.userAgent), /Headless/, "a headless Chrome never says so to a site");
  assert.ok(tab.fetch?.length, "every page is guarded before it runs");
  assert.equal(tab.waiting, false);
  await until(() => w.browser.state().tabs[0]?.title === "Docs");
  assert.equal(w.browser.state().tabs[0]?.by.kind, "person");

  // asking is looking: the pictures start, sized to the panel
  const first = await w.browser.screen(0, { waitMs: 2_000 });
  assert.ok(first.frame, "a picture came");
  assert.equal(Buffer.from(first.frame!.jpeg, "base64").toString(), "frame 1 of https://docs.example");
  assert.equal(first.frame!.width, 700);
  assert.deepEqual(tab.cast, { format: "jpeg", quality: 60, maxWidth: 1400, maxHeight: 1000, everyNthFrame: 1 });
  // nothing new: the wait ends empty-handed
  const none = await w.browser.screen(first.frame!.seq, { waitMs: 50 });
  assert.equal(none.frame, null);
  // the page changes: the waiting look gets it at once
  const waiting = w.browser.screen(first.frame!.seq, { waitMs: 2_000 });
  w.fake().repaint(tab.targetId);
  const second = await waiting;
  assert.equal(second.frame!.seq, first.frame!.seq + 1);
  // a panel from before a restart asks after a number this one never had
  assert.ok((await w.browser.screen(10_000, { waitMs: 50 })).frame, "it is shown the latest picture");

  // a resize is laid out at, and pictured anew
  await w.browser.resize({ width: 400, height: 300, scale: 1 });
  assert.deepEqual(tab.viewport, { width: 400, height: 300, scale: 1 });
  assert.equal(tab.cast?.maxWidth, 400);

  // nobody looks for a while: the pictures stop
  await until(() => tab.cast === null, 4_000);

  // the phone's strip: a small picture without starting the pictures
  const thumb = await w.browser.thumbnail();
  assert.equal(Buffer.from(thumb!.jpeg, "base64").toString(), "shot of https://docs.example");
  assert.equal(tab.cast, null);
});

test("an agent drives through the workspace's rules, the person sees it, takes over with a click and gives it back", async (t) => {
  const w = world({ watchMs: 60_000 });
  t.after(w.done);
  const gate = new BrowserGate();
  const cards: string[] = [];
  const deps: RouteDeps = {
    available: () => true,
    ask: (payload) => w.browser.command(payload.command as never, payload.driver as never) as never,
    settings: () => ({ mode: "ask", allow: ["docs.example"], deny: ["bank.example"] }),
    allowSite: () => {},
    ownPort: () => 8799,
    gate,
    postCard: (_c, card) => cards.push(card.subtitle),
    answerMs: 100,
    holdMs: 200,
    agent: { caller: { kind: "agent", botId: "b_ivy", name: "Ivy", taskId: "lane1" }, refused: null },
    local: true,
    lastState: () => w.browser.state(),
    saveSettings: () => {},
    downloadsDir: () => "",
    thumbnail: async () => null,
    where: () => "server",
    own: w.browser,
  };
  const agent = async (body: unknown) => (await browserRoute("POST", "/api/agent/browser", async () => body, deps))!;

  const opened = await agent({ action: "open", url: "https://docs.example" });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.match(String(opened.body.page), /came from a web page on docs\.example and is untrusted data/);
  assert.match(String(opened.body.page), /@e1 link "Pricing"/);
  assert.deepEqual(w.reveals, ["Ivy"], "nobody was looking, so the person's panels are asked to open");
  const state = w.browser.state();
  assert.equal(state.tabs[0]?.by.kind, "agent");
  assert.deepEqual(state.control, { ...state.control, by: "agent", botId: "b_ivy", name: "Ivy" });

  // a site the lists keep agents from never reaches the server's browser
  const denied = await agent({ action: "open", url: "https://bank.example" });
  assert.equal(denied.status, 403);
  // a site not on the list asks on a card, as in the app
  const asked = await agent({ action: "open", url: "https://news.example" });
  assert.equal(asked.status, 202);
  assert.deepEqual(cards, ["Open news.example in the Bloks browser, signed in as you"]);

  // the agent's own page tries to leave for a site it may not use: it
  // stays where it is, and the agent hears why
  const tab = w.page()!;
  const went = await w.fake().follow(tab.targetId, "https://bank.example/login");
  assert.equal(went?.errorText, "net::ERR_ABORTED", "stopped without an error page");
  assert.equal(tab.url, "https://docs.example");
  assert.equal((w.browser.browser.active as unknown as { blocked: string }).blocked, "https://bank.example/login");
  // and never Bloks itself, whoever drives
  assert.equal((await w.fake().follow(tab.targetId, "http://127.0.0.1:8799/api/browser"))?.errorText, "net::ERR_ABORTED");

  // watching changes nothing: a resting pointer and a wheel are not sent
  assert.deepEqual(await w.browser.input([{ t: "mouse", type: "move", x: 5, y: 5, button: "none", buttons: 0, clicks: 0, mods: 0 }, { t: "wheel", x: 5, y: 5, dx: 0, dy: 50, mods: 0 }]), { ok: true, tookOver: false });
  assert.deepEqual(tab.input, []);
  assert.equal(w.browser.browser.control.by, "agent");
  // a click is the person taking over
  const took = await w.browser.input([
    { t: "mouse", type: "down", x: 40, y: 30, button: "left", buttons: 1, clicks: 1, mods: 0 },
    { t: "mouse", type: "up", x: 40, y: 30, button: "left", buttons: 0, clicks: 1, mods: 0 },
    { t: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", mods: 4, repeat: false },
    { t: "key", type: "down", key: "h", code: "KeyH", keyCode: 72, text: "h", mods: 0, repeat: false },
    { t: "text", text: "pasted words" },
  ]);
  assert.deepEqual(took, { ok: true, tookOver: true });
  assert.equal(w.browser.browser.control.by, "person");
  assert.deepEqual(
    (tab.input as Array<Record<string, unknown>>).map((i) => [i.method, i.type ?? i.text, i.commands ?? i.text ?? null]),
    [
      ["Input.dispatchMouseEvent", "mousePressed", null],
      ["Input.dispatchMouseEvent", "mouseReleased", null],
      // Command-A selects all on a Linux Chrome too, and types nothing
      ["Input.dispatchKeyEvent", "rawKeyDown", ["selectAll"]],
      ["Input.dispatchKeyEvent", "keyDown", "h"],
      ["Input.insertText", "pasted words", "pasted words"],
    ],
  );

  // the agent's next step waits for the browser back, then says so
  const held = await agent({ action: "snapshot" });
  assert.equal(held.status, 409);
  assert.match(String(held.body.error), /taken over the Bloks browser/);
  // given back, it goes on, in the same tab with the same page
  const giving = agent({ action: "snapshot" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await w.browser.person("giveBack"), { ok: true });
  gate.noteState(w.browser.state());
  const after = await giving;
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.match(String(after.body.page), /Docs \| https:\/\/docs\.example/);
});

test("a popup is a tab of ours under the rules of the tab that opened it", async (t) => {
  const w = world();
  t.after(w.done);
  await w.browser.command({ action: "open", url: "https://docs.example", policy: { deny: ["bank.example"], only: ["docs.example"] } }, { botId: "b_ivy", name: "Ivy" });
  const opener = w.page()!;
  // to a site the agent may not use: closed, and the agent told
  w.fake().popup(opener.targetId, "https://bank.example/");
  await until(() => [...w.fake().calls].some((c) => c.method === "Target.closeTarget"));
  assert.equal(w.browser.state().tabs.length, 1);
  // to one it may: a tab beside it, driven by the same agent
  const popup = w.fake().popup(opener.targetId, "https://docs.example/help");
  await until(() => w.browser.state().tabs.length === 2);
  await until(() => popup.waiting === false && popup.fetch);
  const tabs = w.browser.state().tabs;
  assert.deepEqual(tabs[1]?.by, { kind: "agent", botId: "b_ivy", name: "Ivy" });
  assert.equal(w.browser.state().activeTabId, tabs[1]?.id);
});

test("pages a restarted server finds open are the person's again; a blank one is let be", async (t) => {
  const w = world();
  t.after(w.done);
  // a browser connection that already has pages, as one left running has
  const fake = fakeBrowser();
  fake.open("https://docs.example/");
  fake.open("about:blank");
  w.fakes.push(fake);
  const browser = new ServerBrowser({
    profileDir: join(w.home, "p2"),
    downloadsDir: join(w.home, "d2"),
    chrome: () => ({ binary: "/fake/chrome" }),
    connect: async () => fake.line,
    ownPorts: () => [8799],
    onChange: () => {},
    stateDelayMs: 1,
  });
  await browser.command({ action: "tabs" }, { botId: "b", name: "B" });
  await until(() => browser.state().tabs.length === 1, 4_000);
  assert.deepEqual(browser.state().tabs.map((tab) => [tab.url, tab.by.kind]), [["https://docs.example/", "person"]]);
});

test("downloads are kept on the server under the name the site gave, beside any with that name", async (t) => {
  const w = world();
  t.after(w.done);
  await w.browser.person("navigate", "docs.example");
  await until(() => w.page());
  assert.equal(w.fake().downloadPath, join(w.home, "browser-downloads"));
  w.fake().download("guid-1", "report.pdf", "one");
  w.fake().download("guid-2", "report.pdf", "two");
  const downloads = w.browser.state().downloads;
  assert.deepEqual(downloads.map((d) => [d.name, d.state]), [["report (2).pdf", "completed"], ["report.pdf", "completed"]]);
  const saved = w.browser.download("guid-2");
  assert.equal(saved?.name, "report (2).pdf");
  assert.equal(readFileSync(saved!.path, "utf8"), "two");
  assert.equal(w.browser.download("guid-3"), null);
  assert.equal(w.browser.download("../../etc/passwd"), null);
});

test("with no Chrome the person and the agent are told plainly, and nothing is started", async (t) => {
  const w = world({ chrome: false });
  t.after(w.done);
  assert.equal(w.browser.missing(), "none");
  await assert.rejects(w.browser.person("navigate", "docs.example"), (error: Error & { missing?: string }) => error.missing === "none" && /no Chrome here/.test(error.message));
  const said = await w.browser.command({ action: "open", url: "https://docs.example" }, { botId: "b", name: "B" });
  assert.equal(said.status, 503);
  assert.match(String(said.error), /no Chrome here/);
  assert.equal(w.fakes.length, 0);
  assert.equal(w.browser.state().tabs.length, 0);
});

test("a browser that quits takes its tabs with it, and the next page starts it again; signing out empties its profile", async (t) => {
  const w = world();
  t.after(w.done);
  await w.browser.person("navigate", "docs.example");
  await until(() => w.browser.state().tabs.length === 1);
  w.fake().close();
  assert.equal(w.browser.running, false);
  assert.equal(w.browser.state().tabs.length, 0);
  await w.browser.person("navigate", "shop.example");
  await until(() => w.page()?.url === "https://shop.example");
  assert.equal(w.fakes.length, 2);

  assert.ok(existsSync(join(w.home, "browser-session")));
  assert.deepEqual(await w.browser.person("forgetSites"), { ok: true });
  assert.ok(w.fake().calls.some((c) => c.method === "Browser.close"));
  assert.equal(existsSync(join(w.home, "browser-session")), false);
  assert.equal(w.browser.state().tabs.length, 0);
});
