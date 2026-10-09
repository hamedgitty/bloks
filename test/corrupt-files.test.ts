// A store file that will not parse is kept, never written over.
//
// The loaders read a file that does not parse as nothing saved yet. After
// a save cut short, that made the very next save write the empty state
// over the only copy: every room gone, or every agent, or with
// config.json every key, the next time anything at all was saved (the
// Telegram offset moving was enough). Now the file goes aside first, as
// `<name>.corrupt-<time>`, and the next save starts a new one beside it.
//
// The stores keep their files under the data folder, so this points HOME
// at a scratch folder before loading any of them.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-corrupt-"));
const data = join(home, ".bloks");
let config: typeof import("../server/config.ts");
let bloks: typeof import("../server/bloks.ts");
let store: typeof import("../server/store.ts");

before(async () => {
  process.env.HOME = home;
  config = await import("../server/config.ts");
  assert.equal(config.DATA_DIR, data, "never the real ~/.bloks");
  bloks = await import("../server/bloks.ts");
  store = await import("../server/store.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true, mode: 0o700 });
});

/** What a crash part way through a save leaves: the start of the file. */
const cutShort = (whole: unknown) => {
  const text = JSON.stringify(whole, null, 2);
  return text.slice(0, Math.floor(text.length / 2));
};

const kept = (name: string) => readdirSync(data).filter((f) => f.startsWith(`${name}.corrupt-`));

test("a config.json cut short is kept, and the next save does not wipe its keys", { skip: process.platform === "win32" }, () => {
  const file = join(data, "config.json");
  const original = cutShort({
    providers: { anthropic: { key: "test-key-anthropic" }, openai: { key: "test-key-openai" } },
    telegram: { token: "test-telegram-token", offset: 41 },
  });
  writeFileSync(file, original, { mode: 0o600 });

  config.saveConfig({ telegram: { offset: 42 } });

  const aside = kept("config.json");
  assert.equal(aside.length, 1, "the unreadable config was moved aside");
  assert.equal(readFileSync(join(data, aside[0]), "utf8"), original, "byte for byte, keys and all");
  // the copy aside holds keys too, so it stays the owner's alone
  assert.equal(statSync(join(data, aside[0])).mode & 0o777, 0o600);
  // and the live file is a new, readable one with only what was saved
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { telegram: { offset: 42 } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("loading a config.json cut short keeps it aside once, and later saves leave it alone", () => {
  const file = join(data, "config.json");
  const original = cutShort({ providers: { anthropic: { key: "test-key-anthropic" } } });
  writeFileSync(file, original, { mode: 0o600 });

  config.loadConfig();
  config.loadConfig();
  config.saveConfig({ telegram: { offset: 1 } });
  config.saveConfig({ telegram: { offset: 2 } });

  const aside = kept("config.json");
  assert.equal(aside.length, 1, "one copy, not one per read");
  assert.equal(readFileSync(join(data, aside[0]), "utf8"), original);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { telegram: { offset: 2 } });
});

test("saying a config.json was kept aside never repeats what was in it", (t) => {
  // A hand edit that dropped the quotes round a key. V8's parse error
  // quotes the text around the fault, which here is the key itself.
  writeFileSync(join(data, "config.json"), '{"providers":{"anthropic":{"key":test-key-unquoted}}}', { mode: 0o600 });
  const warn = t.mock.method(console, "warn", () => {});
  config.loadConfig();
  const said = warn.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
  assert.match(said, /config\.json could not be read/);
  assert.doesNotMatch(said, /test-key/);
  assert.equal(kept("config.json").length, 1);
});

test("a config.json that is fine is never moved", () => {
  const file = join(data, "config.json");
  writeFileSync(file, JSON.stringify({ providers: { anthropic: { key: "test-key-anthropic" } } }), { mode: 0o600 });
  config.loadConfig();
  config.saveConfig({ telegram: { offset: 3 } });
  assert.deepEqual(kept("config.json"), []);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.providers.anthropic.key, "test-key-anthropic");
  assert.equal(saved.telegram.offset, 3);
});

test("rooms in a bloks.json cut short are kept, not overwritten by the next room", () => {
  const file = join(data, "bloks.json");
  const original = cutShort([{ id: "r1", name: "Launch", memberIds: ["a", "b"], createdAt: 1 }]);
  writeFileSync(file, original, { mode: 0o600 });

  const rooms = new bloks.BlokStore();
  assert.deepEqual(rooms.bloks, []);
  rooms.create("Fresh start", []);

  const aside = kept("bloks.json");
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(data, aside[0]), "utf8"), original);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.map((room: { name: string }) => room.name), ["Fresh start"]);
});

test("agents in a bots.json cut short are kept, not overwritten by the next hire", () => {
  const file = join(data, "bots.json");
  const original = cutShort([{ id: "b1", threadId: "t1", name: "Ivy", tasks: [], createdAt: 1 }]);
  writeFileSync(file, original);

  const agents = new store.Store(() => ({ instanceId: "claude", model: "default" }));
  assert.deepEqual(agents.bots, []);
  agents.createBot({ name: "Rae" });

  const aside = kept("bots.json");
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(data, aside[0]), "utf8"), original);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.map((bot: { name: string }) => bot.name), ["Rae"]);
});
