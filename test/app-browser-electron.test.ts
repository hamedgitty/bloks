// The Bloks browser's Electron half without an Electron
// (electron/app-browser.mjs): where a tab may go, what a snapshot says,
// which fields ask first, what each agent command does to a page as
// protocol calls on a fake debugger, and who has the wheel.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppBrowser,
  MAX_TABS,
  addressFor,
  allowedForAgent,
  downloadName,
  fieldKind,
  formatAxSnapshot,
  hostMatches,
  partitionFor,
  refusedNavigation,
  runOnTab,
} from "../electron/app-browser.mjs";
import { siteMatches } from "../server/app-browser.ts";
import { closeKey, closesPanel } from "../src/lib/appBrowser.ts";
import { axTree, fakeTab, methods, type FakePage } from "./helpers/fake-debugger.ts";

const SHOP: FakePage = {
  url: "https://shop.example.com/cart",
  title: "Your cart",
  text: "Two items in your cart",
  elements: [
    { backendNodeId: 11, role: "heading", name: "Your cart" },
    { backendNodeId: 12, role: "button", name: "Checkout" },
    { backendNodeId: 13, role: "textbox", name: "Coupon", nodeName: "input", attributes: { type: "text", name: "coupon" } },
    { backendNodeId: 14, role: "textbox", name: "Password", nodeName: "input", attributes: { type: "password" } },
    { backendNodeId: 15, role: "textbox", name: "Card number", nodeName: "input", attributes: { autocomplete: "cc-number" } },
    { backendNodeId: 16, role: "button", name: "Choose file", nodeName: "input", attributes: { type: "file" } },
    { backendNodeId: 17, role: "combobox", name: "Size", nodeName: "select", options: ["Small", "Medium", "Large"] },
    { backendNodeId: 18, role: "button", name: "Buy now", coveredBy: 'div "We use cookies"' },
  ],
};

test("each workspace browses in a session of its own, named safely", () => {
  assert.equal(partitionFor("personal"), "persist:bloks-browser-personal");
  assert.equal(partitionFor("ws_abc-1"), "persist:bloks-browser-ws_abc-1");
  assert.equal(partitionFor("../evil"), "persist:bloks-browser-___evil");
  assert.notEqual(partitionFor("a"), partitionFor("b"));
});

test("a tab goes to the web only, and never to a Bloks server", () => {
  const ownPorts = [8799, 18800];
  for (const url of ["https://example.com", "http://example.com/a?b", "about:blank", "http://127.0.0.1:3000/", "http://localhost:5173"]) {
    assert.equal(refusedNavigation(url, { ownPorts }), null, url);
  }
  for (const url of ["file:///etc/passwd", "chrome://settings", "devtools://devtools/x", "javascript:alert(1)", "data:text/html,hi", "chrome-extension://x/y", "view-source:https://a.b", "not a url"]) {
    assert.ok(refusedNavigation(url, { ownPorts }), url);
  }
  for (const url of ["http://127.0.0.1:8799/", "http://localhost:8799/api/config", "http://[::1]:18800/", "http://127.1.2.3:8799/", "http://app.localhost:8799/", "http://0.0.0.0:8799"]) {
    assert.match(refusedNavigation(url, { ownPorts }) ?? "", /Bloks itself/, url);
  }
});

test("while an agent drives, the workspace's lists hold its tab", () => {
  assert.equal(allowedForAgent("https://anything.example", null), true);
  assert.equal(allowedForAgent("https://bad.example/x", { deny: ["bad.example"], only: null }), false);
  assert.equal(allowedForAgent("https://sub.bad.example/x", { deny: ["bad.example"], only: null }), false);
  assert.equal(allowedForAgent("https://good.example/x", { deny: [], only: ["good.example"] }), true);
  assert.equal(allowedForAgent("https://other.example/x", { deny: [], only: ["good.example"] }), false);
  assert.equal(allowedForAgent("https://good.example/x", { deny: ["good.example"], only: ["good.example"] }), false, "deny beats allow");
});

test("the app and the server match sites by one rule", () => {
  const cases: Array<[string, string]> = [
    ["example.com", "example.com"], ["shop.example.com", "example.com"], ["example.com", "*.example.com"],
    ["notexample.com", "example.com"], ["example.co", "example.com"], ["a.b.example.com", "b.example.com"], ["", "example.com"], ["example.com", ""],
  ];
  for (const [host, site] of cases) assert.equal(hostMatches(host, site), siteMatches(host, site), `${host} / ${site}`);
  assert.equal(hostMatches("notexample.com", "example.com"), false);
});

test("the address bar takes an address, a host or a search", () => {
  assert.equal(addressFor("https://example.com/a"), "https://example.com/a");
  assert.equal(addressFor("example.com"), "https://example.com");
  assert.equal(addressFor("localhost:3000/x"), "https://localhost:3000/x");
  assert.equal(addressFor("cheap flights to lisbon"), "https://duckduckgo.com/?q=cheap%20flights%20to%20lisbon");
  assert.equal(addressFor("   "), null);
});

test("passwords, card fields and file pickers are told apart from ordinary fields", () => {
  const node = (nodeName: string, attrs: Record<string, string>) => ({ nodeName, attributes: Object.entries(attrs).flat() });
  assert.equal(fieldKind(node("INPUT", { type: "password" })), "password");
  assert.equal(fieldKind(node("INPUT", { type: "text", autocomplete: "current-password" })), "password");
  assert.equal(fieldKind(node("INPUT", { type: "text", autocomplete: "one-time-code" })), "password");
  assert.equal(fieldKind(node("INPUT", { autocomplete: "cc-number" })), "payment");
  assert.equal(fieldKind(node("INPUT", { autocomplete: "billing cc-csc" })), "payment");
  assert.equal(fieldKind(node("INPUT", { name: "cardnumber" })), "payment");
  assert.equal(fieldKind(node("INPUT", { id: "cvv" })), "payment");
  assert.equal(fieldKind(node("INPUT", { placeholder: "Security code" })), "payment");
  assert.equal(fieldKind(node("INPUT", { type: "file" })), "file");
  assert.equal(fieldKind(node("INPUT", { type: "email", name: "email" })), null);
  assert.equal(fieldKind(node("TEXTAREA", { name: "notes" })), null);
  assert.equal(fieldKind(node("DIV", { "aria-label": "card number" })), null, "only a real field");
  assert.equal(fieldKind(null), null);
});

test("a snapshot lists what can be acted on, each with a ref, and says the rest is left out", () => {
  const shaped = formatAxSnapshot(axTree(SHOP), { url: SHOP.url, title: SHOP.title });
  const lines = shaped.text.split("\n");
  assert.equal(lines[0], "Your cart | https://shop.example.com/cart");
  assert.equal(lines[1], "8 elements:");
  assert.match(shaped.text, /@e1 heading "Your cart"/);
  assert.match(shaped.text, /@e2 button "Checkout"/);
  assert.equal(shaped.refs.get("e2"), 12);
  assert.equal(shaped.count, 8);

  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "6"], backendDOMNodeId: 1 },
    { nodeId: "2", parentId: "1", role: { value: "generic" }, ignored: true, childIds: ["4"] },
    { nodeId: "4", parentId: "2", role: { value: "checkbox" }, name: { value: "  Remember\n me " }, properties: [{ name: "checked", value: { value: false } }], backendDOMNodeId: 40 },
    { nodeId: "3", parentId: "1", role: { value: "dialog" }, name: { value: "" }, childIds: ["5"], backendDOMNodeId: 30 },
    { nodeId: "5", parentId: "3", role: { value: "button" }, name: { value: "Accept" }, properties: [{ name: "focused", value: { value: true } }], backendDOMNodeId: 50 },
    { nodeId: "6", parentId: "1", role: { value: "paragraph" }, name: { value: "Words" }, backendDOMNodeId: 60 },
  ];
  const nested = formatAxSnapshot(nodes, { url: "https://a.example", title: "A" });
  assert.match(nested.text, /^ {2}@e1 checkbox "Remember me" unchecked$/m, "an ignored wrapper is walked through");
  assert.match(nested.text, /^ {2}@e2 dialog$/m);
  assert.match(nested.text, /^ {4}@e3 button "Accept" focused$/m, "a dialog's buttons read as the dialog's");
  assert.doesNotMatch(nested.text, /Words/, "plain text is for read");

  const many = Array.from({ length: 5 }, (_, i) => ({ nodeId: `b${i}`, role: { value: "button" }, name: { value: `B${i}` }, backendDOMNodeId: 100 + i }));
  const cut = formatAxSnapshot(many, { limit: 3 });
  assert.equal(cut.count, 3);
  assert.match(cut.text, /2 more not listed: scroll, then snapshot again/);
  assert.match(formatAxSnapshot([], {}).text, /^\(untitled\) \| about:blank\nnothing on this page to act on$/);
});

test("open navigates, waits for the page and answers its snapshot", async () => {
  const tab = fakeTab({ [SHOP.url]: SHOP });
  const answer = await runOnTab(tab, { action: "open", url: SHOP.url });
  assert.deepEqual(methods(tab), ["Page.enable", "Page.navigate", "Runtime.evaluate", "Accessibility.enable", "Accessibility.getFullAXTree"]);
  assert.match(answer.text ?? "", /@e2 button "Checkout"/);
  assert.equal(tab.refs?.get("e2"), 12, "the refs are kept for the next command");
});

test("a click is a real mouse press in the element's middle, and a covered one says what covers it", async () => {
  const tab = fakeTab({ [SHOP.url]: SHOP });
  await runOnTab(tab, { action: "open", url: SHOP.url });
  tab.calls.length = 0;
  const clicked = await runOnTab(tab, { action: "click", ref: "e2" });
  assert.match(clicked.text ?? "", /^clicked @e2/);
  const mouse = tab.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.x, c.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 60, 40], ["mousePressed", 60, 40], ["mouseReleased", 60, 40]]);
  assert.ok(methods(tab).indexOf("DOM.scrollIntoViewIfNeeded") < methods(tab).indexOf("DOM.getBoxModel"), "scrolled into view first");

  tab.calls.length = 0;
  const covered = await runOnTab(tab, { action: "click", ref: "e8" });
  assert.match(covered.error ?? "", /div "We use cookies" is in front of @e8/);
  assert.ok(!methods(tab).includes("Input.dispatchMouseEvent"), "nothing was clicked");

  const filePick = await runOnTab(tab, { action: "click", ref: "e6" });
  assert.match(filePick.error ?? "", /Use upload/);

  await assert.rejects(() => runOnTab(tab, { action: "click", ref: "e99" }), /no element @e99 on this page\. Take a fresh snapshot/);
});

test("typing clears the field, inserts the text, never says it back, and stops at a password or a card", async () => {
  const tab = fakeTab({ [SHOP.url]: SHOP });
  await runOnTab(tab, { action: "open", url: SHOP.url });
  tab.calls.length = 0;
  const typed = await runOnTab(tab, { action: "type", ref: "e3", text: "SAVE10" });
  assert.equal(typed.text, "typed 6 characters into @e3");
  assert.deepEqual(methods(tab), ["DOM.describeNode", "DOM.focus", "DOM.resolveNode", "Runtime.callFunctionOn", "Input.insertText"]);
  assert.equal(tab.calls.at(-1)!.params.text, "SAVE10");

  tab.calls.length = 0;
  await runOnTab(tab, { action: "type", ref: "e3", text: "X", append: true, submit: true });
  assert.ok(!tab.calls.some((c) => String(c.params.functionDeclaration ?? "").includes('this.value = ""')), "append keeps what is there");
  assert.deepEqual(tab.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => [c.params.type, c.params.key]), [["keyDown", "Enter"], ["keyUp", "Enter"]]);

  for (const [ref, kind] of [["e4", "password"], ["e5", "payment"]] as const) {
    tab.calls.length = 0;
    const held = await runOnTab(tab, { action: "type", ref, text: "hunter2" });
    assert.deepEqual(held.needs, { kind, ref });
    assert.ok(!methods(tab).includes("Input.insertText"), `nothing typed into ${kind} before a yes`);
    const after = await runOnTab(tab, { action: "type", ref, text: "hunter2", approved: true });
    assert.equal(after.text, `typed 7 characters into @${ref}`);
    assert.doesNotMatch(JSON.stringify(after), /hunter2/);
  }
});

test("select, scroll, press, wait, screenshot, back and upload each map to their calls", async () => {
  const tab = fakeTab({ [SHOP.url]: SHOP });
  await runOnTab(tab, { action: "open", url: SHOP.url });

  assert.equal((await runOnTab(tab, { action: "select", ref: "e7", value: "med" })).text, 'chose "Medium" in @e7');
  assert.match((await runOnTab(tab, { action: "select", ref: "e7", value: "Huge" })).error ?? "", /has no option "Huge"\. It has: Small, Medium, Large/);
  assert.match((await runOnTab(tab, { action: "select", ref: "e2", value: "x" })).error ?? "", /not a list to choose from/);

  tab.calls.length = 0;
  assert.match((await runOnTab(tab, { action: "scroll", direction: "down" })).text ?? "", /^scrolled down, 50% of the way down/);
  const wheel = tab.calls.find((c) => c.method === "Input.dispatchMouseEvent")!;
  assert.deepEqual([wheel.params.type, wheel.params.deltaY, wheel.params.x], ["mouseWheel", 640, 500]);
  tab.calls.length = 0;
  await runOnTab(tab, { action: "scroll", direction: "up" });
  assert.equal(tab.calls.find((c) => c.method === "Input.dispatchMouseEvent")!.params.deltaY, -640);
  assert.equal((await runOnTab(tab, { action: "scroll", ref: "e2" })).text, "scrolled @e2 into view");

  tab.calls.length = 0;
  assert.match((await runOnTab(tab, { action: "press", key: "escape" })).text ?? "", /^pressed escape/);
  assert.deepEqual(tab.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params.key), ["Escape", "Escape"]);
  assert.match((await runOnTab(tab, { action: "press", key: "F13" })).error ?? "", /no key called F13/);

  tab.appearsAfter = { text: "Order placed", checks: 3 };
  assert.match((await runOnTab(tab, { action: "wait", text: "Order placed", ms: 2000 })).text ?? "", /^"Order placed" is on the page/);
  assert.match((await runOnTab(tab, { action: "wait", text: "Never", ms: 300 })).error ?? "", /did not appear/);
  assert.match((await runOnTab(tab, { action: "wait", gone: "Two items", ms: 300 })).error ?? "", /is still there/);

  assert.deepEqual(await runOnTab(tab, { action: "screenshot" }), { image: "aGVsbG8=", mime: "image/jpeg" });
  assert.match((await runOnTab(tab, { action: "back" })).error ?? "", /no page to go back to/);

  assert.deepEqual((await runOnTab(tab, { action: "upload", ref: "e6", path: "/tmp/cv.pdf" })).needs, { kind: "file", ref: "e6" });
  tab.calls.length = 0;
  assert.equal((await runOnTab(tab, { action: "upload", ref: "e6", path: "/tmp/cv.pdf", approved: true })).text, "chose the file for @e6");
  assert.deepEqual(tab.calls.find((c) => c.method === "DOM.setFileInputFiles")!.params, { files: ["/tmp/cv.pdf"], backendNodeId: 16 });
  assert.match((await runOnTab(tab, { action: "upload", ref: "e3", path: "/tmp/cv.pdf", approved: true })).error ?? "", /not a file upload/);
});

test("read is the page's text, cut at the limit and said to be cut", async () => {
  const long = { ...SHOP, text: "x".repeat(30_000) };
  const tab = fakeTab({ [SHOP.url]: long });
  await runOnTab(tab, { action: "open", url: SHOP.url });
  const read = await runOnTab(tab, { action: "read" });
  assert.ok((read.text ?? "").startsWith("Your cart | https://shop.example.com/cart\n\n"));
  assert.match(read.text ?? "", /\(cut here: the page goes on\)$/);
});

// ── who has the wheel ──────────────────────────────────────────────────

function browserWith(page: FakePage, idleMs = 60_000) {
  const tabs: ReturnType<typeof fakeTab>[] = [];
  const states: unknown[] = [];
  const browser = new AppBrowser({
    makeTab: () => {
      const tab = fakeTab({ [page.url]: page });
      tabs.push(tab);
      return tab;
    },
    onChange: (state) => states.push(state),
    idleMs,
    ownPorts: () => [8799],
  });
  return { browser, tabs, states };
}

const IVY = { botId: "b_ivy", name: "Ivy" };

test("an agent's open makes a tab of its own, and the browser says it is browsing", async () => {
  const { browser } = browserWith(SHOP);
  const answer = await browser.command({ action: "open", url: SHOP.url }, IVY);
  assert.equal(answer.tab, "t1");
  assert.equal(answer.url, SHOP.url);
  const state = browser.state();
  assert.deepEqual(state.tabs[0].by, { kind: "agent", botId: "b_ivy", name: "Ivy" });
  assert.equal(state.control.by, "agent");
  assert.deepEqual(state.tabs[0].url, SHOP.url);
  assert.ok(!JSON.stringify(state).includes("Two items"), "the state never carries what is on a page");
  assert.match((await browser.command({ action: "open", url: "http://127.0.0.1:8799/" }, IVY)).error ?? "", /Bloks itself/);
  assert.match((await new AppBrowser({ makeTab: () => fakeTab() }).command({ action: "read" }, IVY)).error ?? "", /no page is open/);
});

test("the person takes over: the agent's next action is held and says who waits, until it is given back", async () => {
  const { browser } = browserWith(SHOP);
  await browser.command({ action: "open", url: SHOP.url }, IVY);
  browser.takeOver();
  assert.deepEqual(browser.control, { by: "person", since: browser.control.by === "person" ? browser.control.since : 0, from: IVY });
  const held = await browser.command({ action: "click", ref: "e2" }, IVY);
  assert.equal(held.held, true);
  assert.equal(held.control?.by, "person");
  assert.deepEqual((browser.control as { waiting?: unknown }).waiting, IVY);
  browser.giveBack();
  assert.equal(browser.control.by, "idle");
  assert.match((await browser.command({ action: "click", ref: "e2" }, IVY)).text ?? "", /^clicked @e2/);
  assert.equal(browser.control.by, "agent");
});

test("an agent lets go when it says done, or after a while without a step", async () => {
  const { browser } = browserWith(SHOP, 30);
  await browser.command({ action: "open", url: SHOP.url }, IVY);
  await browser.command({ action: "done" }, { botId: "b_other", name: "Other" });
  assert.equal(browser.control.by, "agent", "only the agent driving lets go");
  await browser.command({ action: "done" }, IVY);
  assert.equal(browser.control.by, "idle");
  await browser.command({ action: "snapshot" }, IVY);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((browser.control as { by: string }).by, "idle", "idle again once it went quiet");
});

test("tabs: listed, switched, closed only by whoever opened them, and kept to a dozen", async () => {
  const { browser } = browserWith(SHOP);
  browser.newTab({ kind: "person" });
  await browser.command({ action: "open", url: SHOP.url, newTab: true }, IVY);
  const listed = await browser.command({ action: "tabs" }, IVY);
  assert.deepEqual(listed.tabs?.map((t) => t.id), ["t1", "t2"]);
  assert.equal(listed.activeTabId, "t2");
  assert.equal((await browser.command({ action: "switch", tab: "t1" }, IVY)).text, "switched to t1");
  assert.equal(browser.state().activeTabId, "t1");
  assert.match((await browser.command({ action: "close", tab: "t1" }, IVY)).error ?? "", /only a tab you opened/);
  assert.equal((await browser.command({ action: "close", tab: "t2" }, IVY)).text, "closed t2");
  assert.match((await browser.command({ action: "switch", tab: "t9" }, IVY)).error ?? "", /no tab t9/);
  for (let i = browser.state().tabs.length; i < MAX_TABS; i++) browser.newTab();
  assert.throws(() => browser.newTab(), /12 tabs at most/);
  const answer = await browser.command({ action: "open", url: SHOP.url, newTab: true }, IVY);
  assert.match(answer.error ?? "", /12 tabs at most/, "said to the agent, not thrown at it");
});

test("who closed the last tab is said, so the person's panel closes with theirs and stays open on an agent's", async () => {
  const { browser } = browserWith(SHOP);
  assert.equal(browser.state().closed, null, "nothing closed yet");
  browser.newTab({ kind: "person" });
  await browser.command({ action: "open", url: SHOP.url, newTab: true }, IVY);
  browser.close("t1", "person");
  assert.deepEqual({ ...browser.state().closed, at: 0 }, { seq: 1, at: 0, by: "person", emptied: false }, "one is still open");
  await browser.command({ action: "close", tab: "t2" }, IVY);
  const byAgent = browser.state().closed!;
  assert.deepEqual([byAgent.seq, byAgent.by, byAgent.emptied], [2, "agent", true]);
  assert.equal(closesPanel(byAgent, closeKey({ ...byAgent, seq: 1 })), false, "an agent's last close leaves the panel open");

  browser.newTab({ kind: "person" });
  browser.close("t3", "person");
  const mine = browser.state().closed!;
  assert.deepEqual([mine.by, mine.emptied], ["person", true]);
  assert.equal(closesPanel(mine, closeKey(byAgent)), true, "the person's own last tab takes the panel with it");
  assert.equal(closesPanel(mine, closeKey(mine)), false, "a close already heard of changes nothing");
  assert.equal(closesPanel(null, ""), false);

  // a page going by itself, or a browser shutting, is nobody's close
  browser.newTab({ kind: "person" });
  browser.close("t4");
  assert.equal(browser.state().closed!.by, "page");
  assert.equal(closesPanel(browser.state().closed, closeKey(mine)), false);
});

test("an agent's address never replaces the page the person has open", async () => {
  const { browser, tabs } = browserWith(SHOP);
  browser.navigate("example.com");
  await browser.command({ action: "open", url: SHOP.url }, IVY);
  assert.deepEqual(browser.state().tabs.map((t) => [t.id, t.by.kind]), [["t1", "person"], ["t2", "agent"]]);
  assert.equal(tabs[0].current.url, "https://example.com", "the person's page kept its place");
  await browser.command({ action: "open", url: SHOP.url }, IVY);
  assert.equal(browser.state().tabs.length, 2, "its own tab is reused");
  // and the person sending the agent's tab somewhere makes it theirs
  browser.navigate("example.org");
  assert.deepEqual(browser.state().tabs.find((t) => t.id === "t2")?.by, { kind: "person" });
});

test("the person's address bar refuses what no tab may open", () => {
  const { browser, tabs } = browserWith(SHOP);
  assert.match(browser.navigate("file:///Users").error ?? "", /file: addresses/);
  assert.match(browser.navigate("localhost:8799").error ?? "", /Bloks itself/);
  assert.equal(browser.navigate("example.com").url, "https://example.com");
  assert.equal(tabs[0].current.url, "https://example.com");
});

test("downloads keep their own names in the folder and never climb out of it", () => {
  const taken = new Set(["report.pdf", "report (2).pdf"]);
  assert.equal(downloadName("report.pdf", (n) => taken.has(n)), "report (3).pdf");
  assert.equal(downloadName("../../.ssh/id_rsa", () => false), "id_rsa");
  assert.equal(downloadName("..\\..\\boot.ini", () => false), "boot.ini");
  assert.equal(downloadName(".hidden", () => false), "hidden");
  assert.equal(downloadName("", () => false), "download");
  assert.equal(downloadName('a<b>:"c".txt', () => false), "a_b___c_.txt");
});
