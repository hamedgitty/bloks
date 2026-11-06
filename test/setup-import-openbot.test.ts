// Bring your setup, from OpenBot: its agents' folders, its database read
// only for the one table its guide names, and a transfer file the person
// picked, hostile ones included. Then what the review makes of an agent
// and its parts, what an import writes, again, and how an undo takes it
// back.
//
// Every home is a fixture folder under the system's temp folder, laid out
// the way OpenBot documents its own, with a database built here with
// node:sqlite and zip files built byte by byte (test/helpers/zip.ts).
// HOME points at a throwaway folder before anything that reads it loads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { after, before, describe, test } from "node:test";

import type { AgentSettings, Engine, ImportDeps, McpEntry, Pick, Review, Scan } from "../server/setup-import.ts";
import type { Rule } from "../server/policy.ts";
import type { ProfileNote } from "../server/profile-notes.ts";
import { choicesFrom, groupReview, ownerMissing, type SetupReview } from "../src/lib/setupReview.ts";
import { makeZip, type ZipInput } from "./helpers/zip.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-setup-openbot-"));
let mod: typeof import("../server/setup-import.ts");
let undo: typeof import("../server/setup-undo.ts");
let zip: typeof import("../server/zip-read.ts");

before(async () => {
  process.env.HOME = join(scratch, "bloks-home");
  process.env.USERPROFILE = process.env.HOME;
  mod = await import("../server/setup-import.ts");
  undo = await import("../server/setup-undo.ts");
  zip = await import("../server/zip-read.ts");
});
after(() => rmSync(scratch, { recursive: true, force: true }));

type Sqlite = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
/** node:sqlite where this Node has it (22.13 and newer, and Electron's
 * own); the database tests are skipped where it does not. */
const sqlite = (() => {
  try {
    return process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
  } catch {
    return undefined;
  }
})();
const noSqlite = sqlite?.DatabaseSync ? false : "this Node has no node:sqlite";

/** Values that must never reach a scan, a review, a record or a log. */
const SECRETS = {
  memory: "sk-ant-api03-OPENBOTMEMORYOPENBOT0123456789",
  instructions: "ghp" + "_openbotopenbotopenbotopenbot01234",
  envFile: "OPENBOT_ENV_FILE_SECRET_5566",
  tokenFile: "openbot-token-file-never-read-77",
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really the rest of a picture")]);

let homes = 0;
function write(home: string, path: string, text: string | Buffer) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const newHome = () => {
  const home = join(scratch, `home-${++homes}`);
  mkdirSync(home, { recursive: true });
  return home;
};

const DATA = "Library/Application Support/OpenBot";

/** OpenBot's database, with one JSON document per agent in the table its
 * guide names, and whatever else a real one has beside it. */
function database(file: string, agents: unknown[]) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new sqlite!.DatabaseSync(file);
  db.exec("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
  db.exec("CREATE TABLE projection_threads (id TEXT, body TEXT)");
  db.exec("INSERT INTO projection_threads VALUES ('t1', 'a private chat that never leaves OpenBot')");
  const insert = db.prepare("INSERT INTO projection_agents VALUES (?, ?)");
  agents.forEach((agent, i) => insert.run(`row-${i}`, typeof agent === "string" ? agent : JSON.stringify(agent)));
  db.close();
}

/** Agents' folders, as OpenBot lays them out. */
function folders(home: string) {
  const ada = "OpenBot/Agents/ada";
  write(home, `${ada}/AGENTS.md`, `# Ada\n\nResearch carefully. My token is ${SECRETS.instructions}\n`);
  write(home, `${ada}/.agents/skills/summarise/SKILL.md`, "---\nname: Summarise\ndescription: Short summaries\n---\n\nSay it in three lines.\n");
  write(home, `${ada}/.claude/skills/browser-tools/SKILL.md`, "---\nname: Browser tools\n---\n\nOpenBot's own.\n");
  write(home, `${ada}/.claude/skills/browser-tools/.openbot-managed.json`, "{}");
  write(home, `${ada}/notes/plan.md`, "The plan.\n");
  write(home, `${ada}/data.csv`, "a,b\n1,2\n");
  write(home, `${ada}/.env`, `KEY=${SECRETS.envFile}\n`);
  write(home, `${ada}/credentials.json`, JSON.stringify({ token: SECRETS.tokenFile }));
  write(home, `${ada}/MEMORY.md`, "Where Bloks keeps memory.\n");
  symlinkSync("/etc/hosts", join(home, ada, "hosts-link"));
  write(home, "OpenBot/Agents/kit/CLAUDE.md", "# Kit\n\nHelp with code.\n");
  write(home, "OpenBot/Agents/nameless/AGENTS.md", "No heading, only words.\n");
  write(home, "OpenBot/Shared/readme.txt", "shared between agents\n");
}

function folderHome(withDatabase = true): string {
  const home = newHome();
  folders(home);
  if (withDatabase) {
    database(join(home, DATA, "openbot.db"), [
      { id: "ada", name: "Ada Lovelace", title: "Research partner", provider: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high" },
      { id: "kit", name: "Kit", provider: "GitHub Copilot", model: "gpt-x" },
      { id: "ghost", name: "Ghost", provider: "muse", instructions: "Only in the database." },
      "{ not json",
    ]);
  } else mkdirSync(join(home, DATA), { recursive: true });
  return home;
}

/** A transfer file as OpenBot's settings write one. */
function transferEntries(): ZipInput[] {
  const json = {
    format: "openbot-instance-transfer",
    version: 1,
    agents: [
      {
        key: "ada",
        name: "Ada",
        title: "Research partner",
        instructions: "From the transfer file.",
        provider: "codex",
        model: "gpt-6-sol",
        reasoningEffort: "max",
        memories: [
          { text: "Prefers British spelling", essential: true },
          { content: "The launch is in March", kind: "searchable" },
          "Unmarked memory",
          { text: `Uses the key ${SECRETS.memory}`, type: "essential" },
        ],
        routines: [
          { name: "Morning brief", prompt: "Summarise the news", cron: "30 8 * * 1-5" },
          { name: "Odd one", prompt: "Check things", schedule: "every few hours" },
          { name: "Silent" },
        ],
        mcpServers: { github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "" } } },
      },
      { key: "bo", name: 42, instructions: ["not a string"], provider: "hermes" },
    ],
  };
  return [
    { name: "openbot-transfer.json", data: JSON.stringify(json), deflate: true },
    { name: "agents/ada/" },
    { name: "agents/ada/avatar.png", data: PNG },
    { name: "agents/ada/skills/summarise/SKILL.md", data: "---\nname: Summarise\ndescription: Short summaries\n---\n\nSay it in three lines.\n", deflate: true },
    { name: "agents/ada/skills/summarise/example.md", data: "an example" },
    { name: "agents/ada/skills/auto/SKILL.md", data: "---\nname: Auto\n---\n\nOpenBot's own.\n" },
    { name: "agents/ada/skills/auto/.openbot-managed.json", data: "{}" },
    { name: "agents/ada/workspace/AGENTS.md", data: "# Ada\n\nThe file version.\n" },
    { name: "agents/ada/workspace/notes/plan.md", data: "The plan, from the transfer.\n", deflate: true },
    { name: "agents/ada/workspace/.secret", data: "hidden" },
    { name: "agents/ada/workspace/token.txt", data: SECRETS.tokenFile },
    { name: "agents/bo/picture.txt", data: "not an image" },
    { name: "agents/cy/workspace/AGENTS.md", data: "# Cy\n\nHelps with chores.\n" },
    { name: "shared/common.txt", data: "for everyone" },
    { name: "extra/unknown.bin", data: "?" },
  ];
}

function transferFile(entries: ZipInput[] = transferEntries(), name = "openbot-transfer.zip") {
  const path = join(scratch, `transfer-${++homes}.zip`);
  writeFileSync(path, makeZip(entries));
  return { path, name };
}

const darwin = { platform: "darwin" as NodeJS.Platform };
const itemsOf = (scan: Scan) => scan.sources.find((s) => s.id === "openbot")?.items ?? [];
const skippedOf = (scan: Scan) => scan.sources.find((s) => s.id === "openbot")?.skipped ?? [];
const byKey = (scan: Scan, key: string) => {
  const item = itemsOf(scan).find((i) => i.key === key);
  assert.ok(item, `no item ${key}: ${itemsOf(scan).map((i) => i.key).join(", ")}`);
  return item;
};

// ── the fake rest of Bloks ─────────────────────────────────────────────

type FakeAgent = AgentSettings & { id: string; name: string; busy: boolean; archived?: boolean; talked?: boolean; photo?: Buffer };

interface World {
  deps: ImportDeps;
  agents: Map<string, FakeAgent>;
  memory: Map<string, string>;
  skills: Array<{ id: string; source: "builtin" | "user"; name: string; description: string; body: string }>;
  mcp: McpEntry[];
  rules: Rule[];
  files: Map<string, Buffer>;
  routines: Array<{ id: string; botId: string; name?: string; prompt: string; time: string; days: number[]; enabled: boolean }>;
  engines: Partial<Record<Engine, { instanceId: string; model: string }>>;
}

function world(): World {
  let n = 0;
  const fresh = (id: string, name: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
    id,
    name,
    busy: false,
    title: "",
    description: "",
    effort: null,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    skillIds: [],
    mcpServers: [],
    ...extra,
  });
  const w: World = {
    agents: new Map([["nova", fresh("nova", "Nova", { description: "Be brief." })]]),
    memory: new Map(),
    skills: [],
    mcp: [],
    rules: [],
    files: new Map(),
    routines: [],
    engines: { claude: { instanceId: "claude", model: "claude-sonnet-5" }, codex: { instanceId: "codex", model: "gpt-6-luna" } },
    deps: undefined as unknown as ImportDeps,
  };
  const live = (id: string) => {
    const a = w.agents.get(id);
    return a && !a.archived ? a : undefined;
  };
  const settingsOf = (a: FakeAgent): AgentSettings => ({
    title: a.title,
    description: a.description,
    color: a.color,
    effort: a.effort ?? null,
    modelSelection: { ...a.modelSelection! },
    skillIds: [...a.skillIds],
    mcpServers: [...a.mcpServers],
  });
  w.deps = {
    agent: (id) => {
      const a = live(id);
      return a ? { id: a.id, name: a.name, description: a.description, busy: a.busy } : null;
    },
    agents: () => [...w.agents.values()].filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })),
    agentSettings: (id) => {
      const a = live(id);
      return a ? settingsOf(a) : null;
    },
    patchAgent: (id, patch) => {
      const a = w.agents.get(id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = v;
    },
    createAgent: ({ name, title, settings }) => {
      const id = `made-${++n}`;
      w.agents.set(id, fresh(id, name, { title }));
      if (settings) w.deps.patchAgent(id, settings);
      return id;
    },
    retireAgent: (id) => {
      const a = live(id);
      if (!a) return "gone";
      if (a.talked) return "talked";
      a.archived = true;
      return "archived";
    },
    engine: (engine) => w.engines[engine] ?? null,
    setInstructions: (botId, text) => {
      w.agents.get(botId)!.description = text;
    },
    readMemory: (botId, file) => w.memory.get(`${botId}/${file}`) ?? null,
    writeMemory: (botId, file, _before, after) => {
      w.memory.set(`${botId}/${file}`, after);
    },
    skills: () => w.skills.map((s) => ({ id: s.id, source: s.source, name: s.name })),
    skill: (id) => {
      const s = w.skills.find((x) => x.id === id);
      return s ? { name: s.name, description: s.description, body: s.body, source: s.source } : null;
    },
    installSkill: (input) => {
      w.skills = [...w.skills.filter((s) => s.id !== input.id), { ...input, source: "user" }];
      return input.id;
    },
    removeSkill: (id) => {
      const had = w.skills.length;
      w.skills = w.skills.filter((s) => s.id !== id || s.source !== "user");
      return w.skills.length < had;
    },
    mcpServers: () => w.mcp,
    saveMcpServers: (list) => {
      w.mcp = list;
    },
    newId: () => `server-${++n}`,
    rules: () => w.rules,
    addRule: (rule) => {
      const made = { ...rule, id: `rule-${++n}`, createdAt: 0 };
      w.rules.push(made);
      return made;
    },
    removeRule: (id) => {
      const had = w.rules.length;
      w.rules = w.rules.filter((r) => r.id !== id);
      return w.rules.length < had;
    },
    notes: () => [] as ProfileNote[],
    suggestNote: () => null,
    removeNote: () => false,
    channel: () => null,
    connectChannel: async () => {},
    disconnectChannel: () => {},
    defaultEngine: () => "Claude Code",
    avatarHash: (botId) => {
      const photo = live(botId)?.photo;
      return photo ? mod.avatarHashOf(photo) : null;
    },
    setAvatar: (botId, _mime, bytes) => {
      w.agents.get(botId)!.photo = bytes;
    },
    clearAvatar: (botId) => {
      delete w.agents.get(botId)!.photo;
    },
    writeWorkspaceFile: (botId, path, bytes) => {
      const there = w.files.get(`${botId}/${path}`);
      if (there) return there.equals(bytes) ? "same" : "taken";
      w.files.set(`${botId}/${path}`, bytes);
      return "written";
    },
    readWorkspaceFile: (botId, path) => w.files.get(`${botId}/${path}`) ?? null,
    removeWorkspaceFile: (botId, path) => w.files.delete(`${botId}/${path}`),
    addRoutine: ({ botId, name, prompt, time, days }) => {
      const id = `routine-${++n}`;
      w.routines.push({ id, botId, ...(name ? { name } : {}), prompt, time, days, enabled: false });
      return id;
    },
    routine: (id) => {
      const r = w.routines.find((x) => x.id === id);
      return r ? { enabled: r.enabled } : null;
    },
    removeRoutine: (id) => {
      const had = w.routines.length;
      w.routines = w.routines.filter((r) => r.id !== id);
      return w.routines.length < had;
    },
  };
  return w;
}

const recordFile = () => join(scratch, `record-${++homes}.json`);

function pick(review: Review, key: string, extra: Partial<Pick> = {}): Pick {
  const item = review.sources.flatMap((s) => s.items).find((i) => i.key === key);
  assert.ok(item, `no item ${key}`);
  return { key, digest: item.digest, to: item.suggested.to, ...(item.suggested.botId ? { botId: item.suggested.botId } : {}), ...extra };
}

// ── reading zip files ──────────────────────────────────────────────────

describe("reading a zip file", () => {
  const limits = { entries: 100, total: 10 * 1024 * 1024, entry: 1024 * 1024 };
  const at = (entries: ZipInput[]) => {
    const path = join(scratch, `zip-${++homes}.zip`);
    writeFileSync(path, makeZip(entries));
    return path;
  };

  test("stored and deflated entries read back exactly, folders listed as folders", () => {
    const path = at([{ name: "a/" }, { name: "a/one.txt", data: "one" }, { name: "a/two.txt", data: "two ".repeat(500), deflate: true }]);
    const entries = zip.listZip(path, limits);
    assert.deepEqual(entries.map((e) => e.name), ["a/", "a/one.txt", "a/two.txt"]);
    assert.equal(zip.readZipEntry(path, entries[1]).toString(), "one");
    assert.equal(zip.readZipEntry(path, entries[2]).toString(), "two ".repeat(500));
  });

  test("a name that climbs out, an absolute one, a link, an encrypted entry, a name twice or a lie about size refuses the whole file", () => {
    const cases: Array<[ZipInput[], RegExp]> = [
      [[{ name: "../evil.txt", data: "x" }], /climbs out/],
      [[{ name: "a/../../evil.txt", data: "x" }], /climbs out/],
      [[{ name: "/etc/passwd", data: "x" }], /absolute path/],
      [[{ name: "C:/Windows/evil", data: "x" }], /absolute path/],
      [[{ name: "a\\b.txt", data: "x" }], /backslash/],
      [[{ name: "link", data: "/etc/passwd", link: true }], /a link/],
      [[{ name: "locked", data: "x", encrypted: true }], /encrypted/],
      [[{ name: "same", data: "1" }, { name: "SAME", data: "2" }], /names one entry twice/],
      [[{ name: "huge", data: "x", deflate: true, claims: 2 * 1024 * 1024 }], /larger than 1 MB/],
      [Array.from({ length: 101 }, (_, i) => ({ name: `f${i}`, data: "x" })), /more than 100 entries/],
    ];
    for (const [entries, why] of cases) {
      assert.throws(() => zip.listZip(at(entries), limits), (e: Error) => e instanceof zip.ZipRefused && why.test(e.message), `${entries[0].name} was read`);
    }
    const path = join(scratch, "not-a-zip.zip");
    writeFileSync(path, "just some text that is long enough to look");
    assert.throws(() => zip.listZip(path, limits), /not a zip file/);
  });

  test("an entry that unpacks past what it claims stops at its size and is refused", () => {
    const bomb = deflateRawSync(Buffer.alloc(5 * 1024 * 1024));
    const path = join(scratch, `bomb-${++homes}.zip`);
    // a real deflated stream, with a directory that claims it is tiny
    const zipped = makeZip([{ name: "bomb.txt", data: "z", deflate: true }]);
    const small = deflateRawSync(Buffer.from("z"));
    const header = zipped.subarray(0, 30 + "bomb.txt".length);
    const rest = zipped.subarray(30 + "bomb.txt".length + small.length);
    header.writeUInt32LE(bomb.length, 18);
    rest.writeUInt32LE(bomb.length, 20);
    const directoryAt = 30 + "bomb.txt".length + bomb.length;
    rest.writeUInt32LE(directoryAt, rest.length - 6);
    writeFileSync(path, Buffer.concat([header, bomb, rest]));
    const [entry] = zip.listZip(path, limits);
    assert.equal(entry.size, 1);
    assert.throws(() => zip.readZipEntry(path, entry), /does not unpack to what the file says/);
  });
});

// ── finding ────────────────────────────────────────────────────────────

describe("finding OpenBot", { skip: noSqlite }, () => {
  test("each folder is an agent, named and set up from the database, with its skills and files", () => {
    const home = folderHome();
    const scan = mod.detectSetup(home, "openbot", darwin);
    assert.deepEqual(scan.sources.map((s) => [s.id, s.name, s.folder]), [["openbot", "OpenBot", "~/OpenBot"]]);
    const agents = itemsOf(scan).filter((i) => i.kind === "agent");
    assert.deepEqual(agents.map((a) => a.title), ["Ada Lovelace", "Kit", "OpenBot agent 3", "Ghost"]);

    const ada = byKey(scan, "openbot:agent:ada");
    assert.equal(ada.agent!.title, "Research partner");
    assert.deepEqual(ada.agent!.model, { engine: "claude", model: "claude-opus-5-5" });
    assert.equal(ada.agent!.effort, "high");
    assert.match(ada.agent!.instructions, /^# Ada\n\nResearch carefully\. My token is \[removed\]$/, "the database has none, so the folder's file stands in");
    assert.deepEqual(ada.agent!.skills, ["summarise"]);
    assert.equal(byKey(scan, "openbot:skill:ada/summarise").owner?.name, "Ada Lovelace");

    const kit = byKey(scan, "openbot:agent:kit");
    assert.equal(kit.agent!.model, undefined, "no engine of that family here, and no model carried");
    assert.equal(kit.agent!.ranOn, "GitHub Copilot");
    assert.match(kit.notes.join(" "), /Ran on GitHub Copilot in OpenBot; uses your default engine here\. Change it after import\./);
    assert.equal(byKey(scan, "openbot:agent:ghost").agent!.instructions, "Only in the database.");

    const files = byKey(scan, "openbot:files:ada");
    assert.deepEqual(files.files!.files.map((f) => f.path), ["data.csv", "notes/plan.md"]);
    const said = files.notes.join(" ");
    assert.match(said, /Copied into Ada Lovelace's workspace/);
    assert.match(said, /1 file looks like it holds a sign-in/);
    assert.match(said, /Hidden files and folders stay in OpenBot/);
    assert.match(said, /1 link was not followed/);

    const skipped = skippedOf(scan);
    assert.ok(skipped.some((s) => /1 skill OpenBot installed itself was left out/.test(s.why)));
    assert.ok(skipped.some((s) => s.from === "~/OpenBot/Shared"));
  });

  test("the app data folder is where each system keeps it", () => {
    for (const [platform, folder] of [["linux", ".config/OpenBot"], ["win32", "AppData/Roaming/OpenBot"]] as const) {
      const home = newHome();
      database(join(home, folder, "openbot.db"), [{ id: "solo", name: "Solo", instructions: "Alone." }]);
      const scan = mod.detectSetup(home, "openbot", { platform });
      assert.deepEqual(itemsOf(scan).map((i) => i.title), ["Solo"], platform);
      assert.equal(scan.sources[0].folder, `~/${folder}`);
      // and a folder on another system's place is not looked at
      assert.deepEqual(mod.detectSetup(home, "openbot", darwin).sources, []);
    }
  });

  test("a database OpenBot holds is said, never waited on, and the folders still read", () => {
    const home = folderHome();
    const writer = new sqlite!.DatabaseSync(join(home, DATA, "openbot.db"));
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const scan = mod.detectSetup(home, "openbot", darwin);
      assert.ok(skippedOf(scan).some((s) => s.from === `~/${DATA}/openbot.db` && /OpenBot is using its database right now/.test(s.why)));
      assert.deepEqual(itemsOf(scan).filter((i) => i.kind === "agent").map((i) => i.title), ["Ada", "Kit", "OpenBot agent 3"], "named from their files instead");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("a database with another layout, or none, still leaves the folders", () => {
    const home = folderHome(false);
    const odd = new sqlite!.DatabaseSync(join(home, DATA, "openbot.db"));
    odd.exec("CREATE TABLE agents (json TEXT)");
    odd.close();
    const scan = mod.detectSetup(home, "openbot", darwin);
    assert.ok(skippedOf(scan).some((s) => /not where OpenBot's guide says/.test(s.why)));
    assert.equal(itemsOf(scan).filter((i) => i.kind === "agent").length, 3);
  });
});

describe("a transfer file", () => {
  test("its agents come with names, settings, picture, skills, memories, routines, servers and files", () => {
    const home = newHome();
    const scan = mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transferFile() });
    assert.equal(scan.sources[0].folder, "openbot-transfer.zip");
    assert.deepEqual(itemsOf(scan).filter((i) => i.kind === "agent").map((i) => i.title), ["Ada", "OpenBot agent 2", "Cy"]);

    const ada = byKey(scan, "openbot:agent:ada");
    assert.equal(ada.agent!.instructions, "From the transfer file.", "the JSON's own instructions win over the file");
    assert.deepEqual(ada.agent!.model, { engine: "codex", model: "gpt-6-sol" });
    assert.equal(ada.agent!.effort, "max");
    assert.equal(ada.agent!.avatar?.mime, "image/png");
    assert.ok(mod.avatarBytes(ada)?.equals(PNG));
    assert.deepEqual(ada.agent!.skills, ["summarise"]);
    assert.match(byKey(scan, "openbot:skill:ada/summarise").notes.join(" "), /1 other file in its folder stays in the transfer file/);
    assert.match(ada.notes.join(" "), /Its MCP server comes over attached to nothing/);

    const essential = byKey(scan, "openbot:memory:ada/essential");
    assert.equal(essential.text, "- Prefers British spelling\n- Uses the key [removed]");
    assert.equal(essential.topic, undefined, "standing memory is MEMORY.md");
    const searchable = byKey(scan, "openbot:memory:ada/searchable");
    assert.equal(searchable.text, "- The launch is in March\n- Unmarked memory");
    assert.equal(searchable.topic, "From OpenBot.md");
    assert.match(searchable.notes.join(" "), /1 memory did not say which kind it was/);

    const brief = byKey(scan, "openbot:routine:ada/morning-brief");
    assert.deepEqual(brief.routine, { name: "Morning brief", prompt: "Summarise the news", time: "08:30", days: [1, 2, 3, 4, 5], scheduled: true });
    assert.match(brief.text, /^Weekdays at 08:30/);
    const odd = byKey(scan, "openbot:routine:ada/odd-one");
    assert.equal(odd.routine!.scheduled, false);
    assert.match(odd.notes.join(" "), /could not be read, so it is set to every day at 09:00/);

    const github = byKey(scan, "openbot:mcp:github");
    assert.deepEqual(github.mcp!.env, { GITHUB_TOKEN: "" });
    assert.match(github.notes.join(" "), /Ada used it in OpenBot/);

    assert.deepEqual(byKey(scan, "openbot:files:ada").files!.files.map((f) => f.path), ["notes/plan.md"]);

    // a name that is not a string is not a name, and a picture that is
    // not an image is said
    const bo = byKey(scan, "openbot:agent:bo");
    assert.equal(bo.agent!.instructions, "");
    assert.match(bo.notes.join(" "), /Ran on Hermes in OpenBot/);
    assert.match(bo.notes.join(" "), /picture is not a PNG, JPEG or WebP image/);
    assert.equal(byKey(scan, "openbot:agent:cy").agent!.instructions, "# Cy\n\nHelps with chores.");

    const skipped = skippedOf(scan);
    assert.ok(skipped.some((s) => /auto|OpenBot installed itself/.test(s.why)));
    assert.ok(skipped.some((s) => s.from === "openbot-transfer.zip: shared" && /1 file shared between agents/.test(s.why)));
    assert.ok(skipped.some((s) => /1 other entry was not read/.test(s.why)));
    assert.ok(skipped.some((s) => /Silent/.test(s.from) && /nothing to say/.test(s.why)));
  });

  test("it wins over a folder for the same agent, and the other folders still come", { skip: noSqlite }, () => {
    const home = folderHome();
    const scan = mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transferFile() });
    const agents = itemsOf(scan).filter((i) => i.kind === "agent");
    assert.deepEqual(agents.map((a) => a.key), ["openbot:agent:ada", "openbot:agent:bo", "openbot:agent:cy", "openbot:agent:kit", "openbot:agent:nameless", "openbot:agent:ghost"]);
    assert.equal(byKey(scan, "openbot:agent:ada").agent!.instructions, "From the transfer file.");
  });

  test("a hostile or wrong file is refused whole, before anything in it is read", () => {
    const json = (value: unknown): ZipInput => ({ name: "openbot-transfer.json", data: JSON.stringify(value) });
    const good = { format: "openbot-instance-transfer", version: 1, agents: [] };
    const cases: Array<[ZipInput[], RegExp]> = [
      [[json(good), { name: "agents/../../evil", data: "x" }], /climbs out/],
      [[json(good), { name: "agents/a/workspace/link", data: "/etc/passwd", link: true }], /link/],
      [[json(good), { name: "agents/a/workspace/huge.bin", data: "x", deflate: true, claims: 100 * 1024 * 1024 }], /larger than 64 MB/],
      [[{ name: "notes.txt", data: "hello" }], /no openbot-transfer\.json/],
      [[json({ agents: [] })], /not an OpenBot transfer file/],
      [[json([1, 2, 3])], /not an OpenBot transfer file/],
      [[{ name: "openbot-transfer.json", data: "{ not json" }], /not an OpenBot transfer file/],
      [[json({ ...good, version: 2 })], /newer OpenBot/],
    ];
    for (const [entries, why] of cases) {
      const file = transferFile(entries);
      assert.match(mod.transferProblem(file.path) ?? "", why, entries.map((e) => e.name).join(", "));
      const scan = mod.detectSetup(newHome(), "openbot", { ...darwin, openbotTransfer: file });
      assert.deepEqual(itemsOf(scan), []);
      assert.ok(skippedOf(scan).some((s) => s.from === "openbot-transfer.zip" && why.test(s.why) && /nothing in it was read/.test(s.why)));
    }
    assert.equal(mod.transferProblem(transferFile().path), null);
  });

  test("no value reaches a scan, a review or a dry run, and no file holding one is listed", () => {
    const home = newHome();
    folders(home);
    const scan = mod.detectSetup(home, undefined, { ...darwin, openbotTransfer: transferFile() });
    const review = mod.reviewOf(scan, new mod.ImportRecord(recordFile()), world().deps);
    for (const shown of [JSON.stringify(scan), JSON.stringify(review), mod.dryRunReport(scan)]) {
      for (const [name, secret] of Object.entries(SECRETS)) assert.equal(shown.includes(secret), false, `${name} was shown`);
      assert.equal(shown.includes("a private chat"), false, "chat history stays in OpenBot");
    }
    assert.match(mod.dryRunReport(scan), /Stays in OpenBot: chat history and channels/);
  });
});

// ── the review ─────────────────────────────────────────────────────────

describe("the review", () => {
  test("an agent's parts go with it; files and routines wait unticked; the default engine is named", () => {
    const home = newHome();
    const scan = mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transferFile() });
    const review = mod.reviewOf(scan, new mod.ImportRecord(recordFile()), world().deps) as SetupReview;
    assert.deepEqual(
      groupReview(review).map((g) => g.label),
      ["Agents", "Instructions and memory", "Workspace files", "Skills", "MCP servers", "Routines"],
    );
    const item = (key: string) => review.sources[0].items.find((i) => i.key === key)!;
    assert.deepEqual(item("openbot:memory:ada/essential").suggested, { to: "memory", botId: "owner" });
    assert.deepEqual(item("openbot:files:ada").suggested, { to: "files", botId: "owner" });
    assert.deepEqual(item("openbot:memory:ada/essential").owner, { key: "openbot:agent:ada", name: "Ada" });
    assert.equal(item("openbot:files:ada").picked, false);
    assert.equal(item("openbot:routine:ada/morning-brief").picked, false);
    assert.equal(item("openbot:agent:ada").picked, true);
    assert.equal(item("openbot:agent:ada").agent!.photo, true);
    assert.deepEqual(item("openbot:files:ada").files, { count: 1, bytes: 29 });
    assert.deepEqual(item("openbot:routine:ada/morning-brief").routine, { summary: "Weekdays at 08:30", scheduled: true });
    assert.match(item("openbot:agent:bo").notes.join(" "), /uses Claude Code here/);

    // a part whose agent is unticked says so in the window
    const choices = choicesFrom(review);
    choices["openbot:agent:ada"].on = false;
    choices["openbot:memory:ada/essential"].on = true;
    assert.equal(ownerMissing(item("openbot:memory:ada/essential"), choices["openbot:memory:ada/essential"], choices), "Ada");
    choices["openbot:agent:ada"].on = true;
    assert.equal(ownerMissing(item("openbot:memory:ada/essential"), choices["openbot:memory:ada/essential"], choices), null);
  });
});

// ── importing ──────────────────────────────────────────────────────────

describe("importing", () => {
  const everything = (review: Review) =>
    review.sources.flatMap((s) => s.items).filter((i) => i.picked || i.kind === "files" || i.kind === "routine").map((i) => pick(review, i.key));

  test("an agent arrives with its engine, picture, skills, memories, files and paused routines, and again changes nothing", async () => {
    const home = newHome();
    const transfer = transferFile();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const scan = () => mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transfer });
    const review = mod.reviewOf(scan(), record, w.deps);
    const outcome = await mod.applyImport(scan(), everything(review), w.deps, record);
    assert.deepEqual(outcome.results.filter((r) => !r.ok), []);

    const ada = [...w.agents.values()].find((a) => a.name === "Ada")!;
    assert.equal(ada.description, "From the transfer file.");
    assert.equal(ada.title, "Research partner");
    assert.deepEqual(ada.modelSelection, { instanceId: "codex", model: "gpt-6-sol" });
    assert.equal(ada.effort, "max");
    assert.ok(ada.photo?.equals(PNG));
    assert.deepEqual(ada.skillIds, ["summarise"]);
    assert.deepEqual(ada.mcpServers, [], "its servers come over attached to nothing");
    assert.equal(w.mcp[0].name, "github");
    assert.match(w.memory.get(`${ada.id}/MEMORY.md`)!, /^## From OpenBot: Essential memories\n\n- Prefers British spelling\n- Uses the key \[removed\]\n$/);
    assert.equal(w.memory.get(`${ada.id}/memory/From OpenBot.md`), "- The launch is in March\n- Unmarked memory\n");
    assert.equal(w.files.get(`${ada.id}/notes/plan.md`)?.toString(), "The plan, from the transfer.\n");
    assert.deepEqual(
      w.routines.map((r) => [r.botId, r.name, r.time, r.days, r.enabled]),
      [
        [ada.id, "Morning brief", "08:30", [1, 2, 3, 4, 5], false],
        [ada.id, "Odd one", "09:00", [], false],
      ],
    );
    // the agent that ran on Hermes runs on the default engine, as made
    const bo = [...w.agents.values()].find((a) => a.name === "OpenBot agent 2")!;
    assert.deepEqual(bo.modelSelection, { instanceId: "claude", model: "claude-sonnet-5" });

    const again = await mod.applyImport(scan(), everything(mod.reviewOf(scan(), record, w.deps)), w.deps, record);
    assert.ok(again.results.every((r) => r.ok && r.did === "unchanged"), JSON.stringify(again.results.filter((r) => r.did !== "unchanged")));
    assert.equal(again.steps.length, 0);
    assert.equal(w.routines.length, 2);
    assert.equal([...w.agents.values()].filter((a) => a.name === "Ada").length, 1);
  });

  test("a part whose agent is not brought over says so, or goes to the agent chosen instead", async () => {
    const home = newHome();
    const transfer = transferFile();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const scan = () => mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transfer });
    const review = mod.reviewOf(scan(), record, w.deps);
    const outcome = await mod.applyImport(
      scan(),
      [pick(review, "openbot:memory:ada/essential"), pick(review, "openbot:routine:ada/morning-brief", { botId: "nova" })],
      w.deps,
      record,
    );
    assert.match(outcome.results.find((r) => r.key === "openbot:memory:ada/essential")!.error!, /bring Ada over too, or choose another agent/);
    assert.equal(outcome.results.find((r) => r.key === "openbot:routine:ada/morning-brief")!.ok, true);
    assert.equal(w.routines[0].botId, "nova");
    assert.equal(w.agents.size, 1, "no agent made for a part on its own");
  });

  test("a file already in the workspace is left as it is, and a picture the agent has is kept", async () => {
    const home = newHome();
    const transfer = transferFile();
    const w = world();
    w.agents.set("ada-here", { ...w.agents.get("nova")!, id: "ada-here", name: "Ada", photo: Buffer.from("their own photo") });
    w.files.set("ada-here/notes/plan.md", Buffer.from("their own plan"));
    const record = new mod.ImportRecord(recordFile());
    const scan = () => mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transfer });
    const review = mod.reviewOf(scan(), record, w.deps);
    assert.deepEqual(review.sources[0].items.find((i) => i.key === "openbot:agent:ada")!.conflict, { kind: "agent", name: "Ada", canReplace: true });
    const outcome = await mod.applyImport(
      scan(),
      [pick(review, "openbot:agent:ada", { conflict: "replace" }), pick(review, "openbot:files:ada")],
      w.deps,
      record,
    );
    assert.deepEqual(outcome.results.map((r) => [r.key, r.ok, r.did]), [
      ["openbot:agent:ada", true, "updated"],
      ["openbot:files:ada", true, "unchanged"],
    ]);
    assert.match(outcome.results[1].note!, /1 file was already in Ada's workspace and was left as it is/);
    assert.equal(w.files.get("ada-here/notes/plan.md")?.toString(), "their own plan");
    assert.equal(w.agents.get("ada-here")!.photo?.toString(), "their own photo");
  });

  test("a transfer file changed after the review is refused rather than imported unseen", async () => {
    const home = newHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const first = transferFile();
    const review = mod.reviewOf(mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: first }), record, w.deps);
    const entries = transferEntries().map((e) => (e.name === "agents/ada/workspace/notes/plan.md" ? { ...e, data: "A different plan." } : e));
    const second = transferFile(entries);
    const outcome = await mod.applyImport(mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: second }), [pick(review, "openbot:files:ada"), pick(review, "openbot:agent:ada")], w.deps, record);
    assert.match(outcome.results.find((r) => r.key === "openbot:files:ada")!.error!, /changed since you looked/);
    assert.equal(outcome.results.find((r) => r.key === "openbot:agent:ada")!.ok, true, "what did not change still comes");
  });
});

// ── undoing ────────────────────────────────────────────────────────────

describe("undoing an OpenBot import", () => {
  test("everything goes back; a file the person changed and a routine they switched on stay", async () => {
    const home = newHome();
    const transfer = transferFile();
    const w = world();
    w.agents.set("ada-here", { ...w.agents.get("nova")!, id: "ada-here", name: "Ada" });
    const record = new mod.ImportRecord(recordFile());
    const scan = () => mod.detectSetup(home, "openbot", { ...darwin, openbotTransfer: transfer });
    const review = mod.reviewOf(scan(), record, w.deps);
    const picks = review.sources[0].items
      .filter((i) => i.picked || i.kind === "files" || i.kind === "routine")
      .map((i) => pick(review, i.key, i.key === "openbot:agent:ada" ? { conflict: "replace" } : {}));
    // one moment for the import and its run, as the server keeps them
    const now = Date.now();
    const outcome = await mod.applyImport(scan(), picks, w.deps, record, now);
    assert.deepEqual(outcome.results.filter((r) => !r.ok), []);
    assert.ok(w.agents.get("ada-here")!.photo, "a picture on an agent that had none");

    const runs = new undo.ImportRuns(join(scratch, `runs-${++homes}.json`));
    const run = runs.add(outcome, now)!;
    const back = undo.undoRun(run, w.deps, record);
    assert.deepEqual(back.kept, []);
    assert.equal(w.agents.get("ada-here")!.photo, undefined);
    assert.equal(w.agents.get("ada-here")!.description, "Be brief.", "the agent that was here before is as it was");
    assert.deepEqual([...w.agents.values()].filter((a) => !a.archived).map((a) => a.id), ["nova", "ada-here"]);
    assert.equal(w.files.size, 0);
    assert.equal(w.routines.length, 0);
    assert.deepEqual(w.mcp, []);
    assert.deepEqual(w.skills, []);
    assert.ok(back.touched.routines);
    assert.deepEqual(mod.reviewOf(scan(), record, w.deps).sources[0].items.filter((i) => i.status !== "new").map((i) => i.key), []);

    // once more, and this time the person makes some of it theirs first
    const review2 = mod.reviewOf(scan(), record, w.deps);
    const outcome2 = await mod.applyImport(scan(), review2.sources[0].items.filter((i) => i.picked || i.kind === "files" || i.kind === "routine").map((i) => pick(review2, i.key)), w.deps, record);
    const made = outcome2.created.map((id) => w.agents.get(id)!).find((a) => a.name.startsWith("Ada"))!;
    w.files.set(`${made.id}/notes/plan.md`, Buffer.from("edited by the person"));
    w.routines[0].enabled = true;
    const back2 = undo.undoRun(new undo.ImportRuns(join(scratch, `runs-${++homes}.json`)).add(outcome2, Date.now())!, w.deps, record);
    const why = back2.kept.map((k) => k.why).join(" | ");
    assert.match(why, /1 of its files has changed since, so it was kept/);
    assert.match(why, /you switched it on since, so it stays/);
    assert.equal(w.routines.length, 1);
  });
});

// ── from the terminal ──────────────────────────────────────────────────

describe("from the terminal", () => {
  test("the dry run reads a transfer file named on the line, and writes nothing", () => {
    const home = newHome();
    const bin = fileURLToPath(new URL("../bin/bloks-server.mjs", import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home, BLOKS_PORT: "1" };
    const file = transferFile();
    const run = spawnSync(process.execPath, [bin, "import", "openbot", "--dry-run", "--transfer", file.path], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^OpenBot \(transfer-\d+\.zip\)/);
    assert.match(run.stdout, /  Agents\n    Ada\n/);
    assert.match(run.stdout, /  Routines\n    Morning brief/);
    assert.match(run.stdout, /Stays in OpenBot/);
    for (const secret of Object.values(SECRETS)) assert.equal(run.stdout.includes(secret), false);
    const missing = spawnSync(process.execPath, [bin, "import", "openbot", "--dry-run", "--transfer", join(home, "nope.zip")], { env, encoding: "utf8" });
    assert.match(missing.stderr, /There is no file at/);
  });
});

