// Chrome extensions in a server's own browser (GitHub 510), against a
// fake Chrome in this process (helpers/fake-cdp-browser.mjs): loaded over
// the line each time Chrome starts, never a tab, refused to agents; the
// owner's popup and options page as a view of their own, pictured and
// driven through routes no agent reaches; and adding one by sending its
// folder, judged against Chrome before the owner's yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerBrowser, extensionLoadProblem, type CdpLine } from "../server/server-browser.ts";
import { browserExtensionRoute, stagedPath, sweepStaging, STAGING_DIR, STAGING_MS, type ExtensionRouteDeps } from "../server/browser-extension-routes.ts";
import { COPIES_DIR, addFromFolder, readList } from "../server/browser-extensions.mjs";
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

const VAULT = {
  manifest_version: 3,
  name: "Sample Vault",
  version: "1.0.0",
  permissions: ["storage", "tabs", "nativeMessaging", "alarms"],
  host_permissions: ["https://docs.example/*"],
  background: { service_worker: "background.js" },
  action: { default_popup: "popup.html" },
  options_ui: { page: "options.html" },
  content_scripts: [{ matches: ["https://docs.example/*"], js: ["content.js"] }],
};

const VAULT_FILES: Record<string, string> = {
  "manifest.json": JSON.stringify(VAULT),
  "background.js": "chrome.runtime.onMessage.addListener(() => true)",
  "content.js": "document.documentElement.dataset.vault = '1'",
  "popup.html": "<p>unlock</p>",
  "options.html": "<p>options</p>",
};

function vaultFolder(root: string) {
  const dir = join(root, "vault");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(VAULT_FILES)) writeFileSync(join(dir, name), body);
  return dir;
}

function world({ extensions = true }: { extensions?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-server-bext-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir);
  const fakes: FakeBrowser[] = [];
  const logs: string[] = [];
  const browser = new ServerBrowser({
    profileDir: join(dataDir, "browser-session"),
    downloadsDir: join(dataDir, "browser-downloads"),
    dataDir,
    log: (line) => logs.push(line),
    chrome: () => ({ binary: "/fake/chrome" }),
    connect: async (): Promise<CdpLine> => {
      const fake = fakeBrowser({ extensions });
      fakes.push(fake);
      return fake.line;
    },
    ownPorts: () => [8799],
    onChange: () => {},
    stateDelayMs: 1,
    watchMs: 400,
    idleMs: 60_000,
  });
  const fake = () => fakes[fakes.length - 1]!;
  return { home, dataDir, browser, fake, logs, done: () => rmSync(home, { recursive: true, force: true }) };
}

const IVY = { botId: "b_ivy", name: "Ivy" };

test("the owner's extensions load into the server's Chrome each time it starts, before any page", async (t) => {
  const w = world();
  t.after(w.done);
  const entry = addFromFolder(w.dataDir, vaultFolder(w.home), 1);
  assert.equal(w.browser.running, false);
  await w.browser.person("navigate", "docs.example");
  const fake = w.fake();
  const loadAt = fake.calls.findIndex((c) => c.method === "Extensions.loadUnpacked");
  const pageAt = fake.calls.findIndex((c) => c.method === "Target.createTarget");
  assert.ok(loadAt >= 0, "loaded over the line");
  assert.ok(loadAt < pageAt, "before the first page is made, so no page runs without it");
  assert.equal(fake.calls[loadAt]!.params.path, entry.dir, "the copy beside the workspace, never the folder it came from");
  const saved = readList(w.dataDir)[0]!;
  assert.match(saved.extensionId ?? "", /^[a-p]{32}$/);
  assert.equal(saved.problem, undefined);

  // Chrome forgets it at quit; the next start loads it again
  await w.browser.shutDown();
  await w.browser.person("navigate", "docs.example");
  assert.ok(w.fake() !== fake);
  assert.deepEqual([...w.fake().loaded.values()], [entry.dir]);
});

test("an extension's background worker, started paused, is let run before it is let go", async (t) => {
  const w = world();
  t.after(w.done);
  await w.browser.person("navigate", "docs.example");
  // the detach overtaking the word to run left a worker paused for good:
  // an extension's background never answered, nor a site's service worker
  const background = w.fake().worker("chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js");
  const site = w.fake().worker("https://docs.example/sw.js");
  await until(() => background.detachedWaiting !== null && site.detachedWaiting !== null);
  assert.equal(background.detachedWaiting, false, "running by the time it was let go");
  assert.equal(site.detachedWaiting, false);
  assert.equal(w.browser.state().tabs.length, 1, "a worker is never a tab");
});

test("a Chrome that does not take extensions over its line says so on the extension, and still browses", async (t) => {
  const w = world({ extensions: false });
  t.after(w.done);
  addFromFolder(w.dataDir, vaultFolder(w.home), 1);
  assert.deepEqual(await w.browser.person("navigate", "docs.example"), { ok: true, url: "https://docs.example" });
  assert.match(readList(w.dataDir)[0]!.problem ?? "", /does not take extensions from Bloks\. A recent Google Chrome or Chromium does/);
  assert.equal(extensionLoadProblem("something else broke"), "something else broke");
});

test("an extension's own page is never a tab: one it opens is closed, and a tab it moves is sent back to blank", async (t) => {
  const w = world();
  t.after(w.done);
  addFromFolder(w.dataDir, vaultFolder(w.home), 1);
  await w.browser.person("navigate", "docs.example");
  const fake = w.fake();
  const id = readList(w.dataDir)[0]!.extensionId!;
  await until(() => w.browser.state().tabs[0]?.url === "https://docs.example");

  // chrome.tabs.create of its own welcome page: closed, and not listed
  const welcome = fake.extensionOpens(`chrome-extension://${id}/welcome.html`);
  await until(() => !fake.targets.has(welcome.targetId));
  assert.equal(w.browser.state().tabs.length, 1);

  // chrome.tabs.update of the person's tab to its own page: not a request
  // the guard hears, so the tab is sent to the blank page instead
  const tabTarget = [...fake.targets.values()].find((x) => x.url === "https://docs.example")!;
  fake.extensionMoves(tabTarget.targetId, `chrome-extension://${id}/options.html`);
  await until(() => fake.targets.get(tabTarget.targetId)?.url === "about:blank");
});

test("its popup opens for the owner as a view of its own: pictured, driven, never among the tabs an agent sees", async (t) => {
  const w = world();
  t.after(w.done);
  addFromFolder(w.dataDir, vaultFolder(w.home), 1);
  const slug = readList(w.dataDir)[0]!.slug;
  await w.browser.person("navigate", "docs.example");
  await until(() => w.browser.state().tabs[0]?.url === "https://docs.example");
  const fake = w.fake();
  const id = readList(w.dataDir)[0]!.extensionId!;

  const opened = await w.browser.openExtensionPage(slug, "popup");
  assert.equal(opened.error, undefined);
  assert.deepEqual(opened.view, { slug, name: "Sample Vault", page: "popup", width: 400, height: 600 });
  const viewTarget = await until(() => [...fake.targets.values()].find((x) => x.url === `chrome-extension://${id}/popup.html`));
  assert.deepEqual(viewTarget.viewport, { width: 400, height: 600, scale: 1 });
  assert.ok(viewTarget.fetch?.length, "held to its own pages from its first request");
  const made = fake.calls.find((c) => c.method === "Target.createTarget" && String(c.params.url).startsWith("chrome-extension://"));
  assert.equal(made?.params.newWindow, true, "a window of its own, never behind the tab the panel keeps in front");

  // never a tab: not in the state, not in an agent's tab list
  assert.equal(w.browser.state().tabs.length, 1);
  assert.ok(!JSON.stringify(w.browser.state()).includes("chrome-extension"), "the state the panel, the phone and the agents hear names it nowhere");
  const listed = await w.browser.command({ action: "tabs" }, IVY);
  assert.ok(!JSON.stringify(listed).includes("chrome-extension"));
  // an agent's picture is of the tab, never of the view
  const shot = await w.browser.command({ action: "screenshot" }, IVY);
  assert.equal(Buffer.from(String(shot.image), "base64").toString(), "shot of https://docs.example");
  w.browser.browser.release(IVY.botId);

  // the owner's pictures of it, and their hands on it
  const first = await w.browser.extensionScreen(0, { waitMs: 2_000 });
  assert.equal(Buffer.from(first.frame!.jpeg, "base64").toString(), `frame 1 of chrome-extension://${id}/popup.html`);
  assert.equal(first.frame!.tab, `extension:${slug}`);
  await w.browser.extensionInput([{ t: "text", text: "master password" }]);
  assert.deepEqual(viewTarget.input.map((i) => i.method), ["Input.insertText"]);
  const tabTarget = [...fake.targets.values()].find((x) => x.url === "https://docs.example")!;
  assert.equal(tabTarget.input.length, 0, "nothing of it reaches the tab");

  // a link out of it opens as the person's tab, under the tab's rules
  const went = await fake.follow(viewTarget.targetId, "https://help.example/");
  assert.match(went?.errorText ?? "", /ABORTED/, "the view stays on its own page");
  await until(() => w.browser.state().tabs.some((tab) => tab.url === "https://help.example/" && tab.by.kind === "person"));
  const refused = await fake.follow(viewTarget.targetId, "http://127.0.0.1:8799/");
  assert.match(refused?.errorText ?? "", /ABORTED/);
  assert.ok(!w.browser.state().tabs.some((tab) => tab.url.includes("8799")), "and never to Bloks itself");

  // a popup that closes itself is closed for the owner
  await fake.line.send("Target.closeTarget", { targetId: viewTarget.targetId });
  assert.equal(w.browser.extensionView(), null);
  assert.equal((await w.browser.extensionScreen(first.frame!.seq, { waitMs: 50 })).closed, true);

  // the options page lays out at the panel's size; opening another closes the last
  await w.browser.resize({ width: 900, height: 700, scale: 1 });
  const options = await w.browser.openExtensionPage(slug, "options");
  assert.deepEqual(options.view, { slug, name: "Sample Vault", page: "options", width: 900, height: 700 });
  assert.equal((await w.browser.openExtensionPage(slug, "popup")).view?.page, "popup");
  assert.equal([...fake.targets.values()].filter((x) => x.url.startsWith("chrome-extension://")).length, 1, "one at a time");
  await w.browser.closeExtensionPage();
  assert.equal(w.browser.extensionView(), null);

  // only one the owner switched on, with the page it names
  assert.match((await w.browser.openExtensionPage("no-such", "popup")).error ?? "", /not on in this browser/);
});

test("adding one sends its folder from the owner's device, judged against Chrome, kept only on their yes", async (t) => {
  const w = world();
  t.after(w.done);
  const query = new URLSearchParams();
  const deps = (): ExtensionRouteDeps => ({ dataDir: w.dataDir, own: w.browser, query });
  const call = async (method: string, path: string, body?: unknown, bytes?: Buffer) =>
    (await browserExtensionRoute(method, path, async () => body, async (max) => {
      if ((bytes?.length ?? 0) > max) throw new Error("too big");
      return bytes ?? Buffer.alloc(0);
    }, deps()))!;

  // never an agent's, and never for the desktop app's browser
  assert.equal((await browserExtensionRoute("GET", "/api/browser/extensions", async () => null, async () => Buffer.alloc(0), { ...deps(), agent: true }))!.status, 403);
  assert.equal((await browserExtensionRoute("GET", "/api/browser/extensions", async () => null, async () => Buffer.alloc(0), { dataDir: w.dataDir, own: null }))!.status, 409);
  assert.equal(await browserExtensionRoute("GET", "/api/browser/settings", async () => null, async () => Buffer.alloc(0), deps()), null);

  const staged = await call("POST", "/api/browser/extensions/staging");
  assert.equal(staged.status, 201);
  const id = String(staged.body.id);
  for (const [name, body] of Object.entries(VAULT_FILES)) {
    query.set("path", name);
    assert.equal((await call("PUT", `/api/browser/extensions/staging/${id}/files`, undefined, Buffer.from(body))).status, 200, name);
  }
  // nothing climbs out of the staging folder, and nothing is sent twice
  for (const sneaky of ["../escape.js", "a/../../escape.js", "/etc/passwd", "a\\b.js", "a//b.js", ""]) {
    query.set("path", sneaky);
    assert.equal((await call("PUT", `/api/browser/extensions/staging/${id}/files`, undefined, Buffer.from("x"))).status, 400, sneaky);
  }
  assert.equal(existsSync(join(w.dataDir, COPIES_DIR, "escape.js")), false);
  query.set("path", "popup.html");
  assert.equal((await call("PUT", `/api/browser/extensions/staging/${id}/files`, undefined, Buffer.from("again"))).status, 409);
  query.set("path", "huge.bin");
  assert.equal((await call("PUT", `/api/browser/extensions/staging/${id}/files`, undefined, Buffer.alloc(26 * 1024 * 1024))).status, 413);

  // the look: what it is and what of it works on the server's Chrome
  const look = await call("POST", `/api/browser/extensions/staging/${id}/look`);
  assert.equal(look.status, 200);
  assert.equal(look.body.path, id);
  const fit = look.body.compatibility as { verdict: string; works: string[]; missing: string[] };
  assert.ok(fit.works.includes("chrome.alarms"), "a server's Chrome has what Electron lacks");
  assert.ok(fit.works.includes("Its toolbar popup, opened from the extensions button in the Bloks browser"));
  assert.match(fit.missing.join("\n"), /no password manager's desktop app there/);
  assert.equal(readList(w.dataDir).length, 0, "nothing kept before the owner's yes");

  // the yes: copied in, the staging gone, listed with its pages
  const added = await call("POST", "/api/browser/extensions", { staging: id });
  assert.equal(added.status, 200);
  const rows = added.body.extensions as Array<{ slug: string; name: string; enabled: boolean; from: string; pages: { popup: boolean; options: boolean } }>;
  assert.equal(rows[0]!.name, "Sample Vault");
  assert.deepEqual(rows[0]!.pages, { popup: true, options: true });
  assert.match(rows[0]!.from, /^Sent from your device: Sample Vault 1\.0\.0$/);
  assert.equal(readdirSync(join(w.dataDir, COPIES_DIR, STAGING_DIR)).length, 0);
  assert.equal((await call("POST", "/api/browser/extensions", { staging: id })).status, 404, "a yes counts once");

  // opened, pictured and driven through the owner's routes
  const slug = rows[0]!.slug;
  await w.browser.person("navigate", "docs.example");
  const open = await call("POST", `/api/browser/extensions/${slug}/open`, { page: "popup" });
  assert.equal(open.status, 200);
  assert.equal((open.body.view as { page: string }).page, "popup");
  query.set("after", "0");
  const screen = await call("GET", "/api/browser/extensions/view/screen");
  assert.match(Buffer.from(String(screen.body.jpeg), "base64").toString(), /^frame \d+ of chrome-extension:\/\/[a-p]{32}\/popup\.html$/);
  assert.equal((await call("POST", "/api/browser/extensions/view/input", { events: [{ t: "script", code: "x" }] })).status, 400, "input is checked as the tab's is");
  assert.equal((await call("POST", "/api/browser/extensions/view/input", { events: [{ t: "text", text: "pw" }] })).status, 200);
  assert.equal((await call("POST", `/api/browser/extensions/${slug}/open`, { page: "devtools" })).status, 400);
  assert.equal((await call("GET", "/api/browser/extensions")).body.view !== null, true);

  // switched off closes its view and takes it out of Chrome; removed, its copy goes
  const off = await call("PATCH", `/api/browser/extensions/${slug}`, { enabled: false });
  assert.equal((off.body.extensions as Array<{ enabled: boolean }>)[0]!.enabled, false);
  assert.equal(w.browser.extensionView(), null);
  assert.equal(w.fake().loaded.size, 0);
  const gone = await call("DELETE", `/api/browser/extensions/${slug}`);
  assert.deepEqual(gone.body.extensions, []);

  // a staged folder nobody added is gone within the hour
  const left = String((await call("POST", "/api/browser/extensions/staging")).body.id);
  assert.ok(existsSync(join(w.dataDir, COPIES_DIR, STAGING_DIR, left)));
  sweepStaging(w.dataDir, Date.now() + STAGING_MS + 1);
  assert.equal(existsSync(join(w.dataDir, COPIES_DIR, STAGING_DIR, left)), false);
  assert.equal((await call("POST", `/api/browser/extensions/staging/${left}/look`)).status, 404);
});

test("a sent file's path is plain parts inside the folder, or nothing", () => {
  assert.equal(stagedPath("popup/index.html"), "popup/index.html");
  assert.equal(stagedPath(".DS_Store"), ".DS_Store");
  for (const bad of ["", "../x", "a/../b", "/abs", "a\\b", "a//b", "./a", "a\u0000b", "x".repeat(401), 42]) assert.equal(stagedPath(bad), null, String(bad));
});
