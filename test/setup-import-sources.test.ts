// Bring your setup, the tools it reads beyond instructions and skills:
// Claude Code's subagents, commands and rule files, Codex's prompts and
// model, Cursor's rules, servers and subagents, and OpenClaw's config and
// chat apps. Then what the review makes of them (groups, clashes, values
// to fill in), what an import writes, and how an undo takes it back.
//
// Every home is a fixture folder under the system's temp folder, written
// the way each tool writes its own files, odd and broken ones included.
// HOME points at a throwaway folder before anything that reads it loads,
// so nothing here can see the real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import type { AgentSettings, Engine, FoundItem, ImportDeps, McpEntry, Pick, Review, Scan } from "../server/setup-import.ts";
import type { Rule } from "../server/policy.ts";
import type { ProfileNote } from "../server/profile-notes.ts";
import { choicesFrom, groupReview, missingSecrets, pickFor, type SetupReview } from "../src/lib/setupReview.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-setup-sources-"));
let mod: typeof import("../server/setup-import.ts");
let undo: typeof import("../server/setup-undo.ts");
let json5: typeof import("../server/json5.ts");

before(async () => {
  process.env.HOME = join(scratch, "bloks-home");
  process.env.USERPROFILE = process.env.HOME;
  mod = await import("../server/setup-import.ts");
  undo = await import("../server/setup-undo.ts");
  json5 = await import("../server/json5.ts");
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Values that must never reach a scan, a review, a record or a log,
 * whatever an import does with them. */
const SECRETS = {
  claudeEnv: "ghp" + "_claudeclaudeclaudeclaude0123456789",
  claudeOauth: "sk-ant-oat01-NEVERNEVERNEVER0123456",
  agentKey: "sk-ant-api03-AGENTAGENTAGENTAGENT0123456789",
  codexEnv: "tok-literal-codex-9f8e7d6c5b4a3210",
  codexAuth: "sk-proj-CODEXAUTHCODEXAUTH1234",
  cursorEnv: "cursor-literal-1234567890abcdefXYZ",
  telegram: "123456789:AAH-literal-telegram-token-abcdef",
  slackBot: "xoxb" + "-1111111111-2222222222-slackliteraltokenabc",
  openclawEnv: "OPENCLAW_DOTENV_SECRET_77aa88bb",
  whatsappCreds: "whatsapp-creds-never-read-0042",
};

let homes = 0;
function write(home: string, path: string, text: string) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function claudeHome(home: string) {
  write(home, ".claude/CLAUDE.md", "# Me\n\nUse pnpm.\nSee @~/.claude/extra.md and @docs/guide.md. More\n\n```\n@not/an/import.md\n```\n");
  write(home, ".claude/rules/testing.md", "---\npaths:\n  - \"src/**/*.ts\"\n  - test/**\n---\n\nWrite the test first.\n");
  write(home, ".claude/rules/style.md", "Short sentences.\n");
  write(home, ".claude/rules/broken.md", "---\npaths: src/**\nWrite clearly.\n");
  write(
    home,
    ".claude/agents/reviewer.md",
    [
      "---",
      "name: code-reviewer",
      "description: Reviews code for quality and safety. Use it after every edit.",
      "tools: Read, Grep, Glob",
      "model: opus",
      "color: purple",
      "permissionMode: plan",
      "skills:",
      "  - standup",
      "  - missing-skill",
      "mcpServers:",
      "  - github",
      "  - slack:",
      "      type: http",
      "      url: https://slack.example.com/mcp",
      "---",
      "",
      "You review code. Never print keys like " + SECRETS.agentKey + ".",
      "",
    ].join("\n"),
  );
  write(
    home,
    ".claude/agents/runner.md",
    "---\nname: test-runner\ndescription: Runs the tests\ntools:\n  - Bash\n  - Read\ndisallowedTools: WebFetch, Bash(rm:*)\nmodel: haiku\neffort: high\n---\n\nRun the tests and report.\n",
  );
  write(home, ".claude/agents/empty.md", "---\nname: nothing\n---\n");
  write(home, ".claude/agents/odd.md", "---\nname: odd\nmodel: gpt-4\n---\nBe odd.\n");
  write(home, ".claude/agents/long.md", `---\nname: long\n---\n\n${"Explain it in full. ".repeat(260)}\n`);
  write(home, ".claude/commands/commit.md", "---\ndescription: Commit what changed\nargument-hint: [message]\n---\n\nCommit with the message $ARGUMENTS.\n!`git status`\n");
  write(home, ".claude/commands/frontend/component.md", "Make a component called $1.\n");
  write(home, ".claude/skills/standup/SKILL.md", "---\nname: standup\ndescription: Write the standup\n---\n\nList yesterday, today, blockers.\n");
  write(home, ".claude/.credentials.json", JSON.stringify({ accessToken: SECRETS.claudeOauth }));
  write(
    home,
    ".claude.json",
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com" },
      mcpServers: {
        github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: SECRETS.claudeEnv } },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_KEY}" } },
        socket: { type: "ws", url: "ws://localhost:9000" },
      },
    }),
  );
  write(
    home,
    ".claude/settings.json",
    JSON.stringify({ model: "opus", mcpServers: { extra: { command: "node", args: ["extra.js"] } }, permissions: { deny: ["Bash(git push --force:*)"] } }),
  );
}

function codexHome(home: string) {
  write(home, ".codex/AGENTS.override.md", "The override wins.\n");
  write(home, ".codex/AGENTS.md", "Not read while the override has something in it.\n");
  write(
    home,
    ".codex/config.toml",
    [
      'model = "gpt-6-sol"',
      'model_reasoning_effort = "ultra"',
      "",
      "[mcp_servers.search]",
      'url = "https://search.example.com/mcp"',
      'bearer_token_env_var = "SEARCH_KEY"',
      "",
      "[mcp_servers.local]",
      'command = "local-mcp"',
      `env = { API_TOKEN = "${SECRETS.codexEnv}" }`,
      'env_vars = ["HOME_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]',
      "",
    ].join("\n"),
  );
  write(home, ".codex/prompts/review.md", "---\ndescription: Review a file\nargument-hint: FILE=<path>\n---\nReview $FILE, then $1.\n");
  write(home, ".codex/prompts/sub/deep.md", "Not read: Codex reads prompts at the top only.\n");
  write(home, ".agents/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship it\n---\nRun the deploy.\n");
  write(home, ".codex/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: The older one\n---\nRun the old deploy.\n");
  write(home, ".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: SECRETS.codexAuth }));
}

function cursorHome(home: string) {
  write(
    home,
    ".cursor/mcp.json",
    [
      "{",
      "  // Cursor's own file, with a comment someone left in it",
      '  "mcpServers": {',
      '    "github": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "' + SECRETS.cursorEnv + '" } },',
      '    "figma": { "url": "https://figma.example.com/mcp", "headers": { "X-Api-Key": "${env:FIGMA_KEY}" } },',
      '    "tools": { "command": "${userHome}/bin/tools", "args": ["--root", "${workspaceFolder}"], "envFile": "${workspaceFolder}/.env" },',
      "  },",
      "}",
    ].join("\n"),
  );
  write(home, ".cursor/rules/always.mdc", "---\ndescription: House rules\nalwaysApply: true\n---\n\nAlways answer in English.\n");
  write(home, ".cursor/rules/react.mdc", "---\ndescription: React components\nglobs: \"**/*.tsx, **/*.jsx\"\nalwaysApply: false\n---\n\nUse function components.\n");
  write(home, ".cursor/rules/broken.mdc", "---\nglobs: *.ts\nNo end to this header.\n");
  write(home, ".cursor/rules/notes.md", "Prefer small pull requests.\n");
  write(home, ".cursor/agents/planner.md", "---\nname: planner\ndescription: Plans the work\nmodel: claude-4.5-sonnet\nreadonly: true\n---\n\nPlan before anyone codes.\n");
  write(home, ".cursor/commands/fix.md", "Fix the failing test.\n");
  mkdirSync(join(home, ".cursor", "skills"), { recursive: true });
  symlinkSync(join(home, ".claude", "skills", "standup"), join(home, ".cursor", "skills", "standup"));
  write(home, ".cursor/extensions/some.ext/package.json", "{}");
}

function openclawHome(home: string) {
  write(
    home,
    ".openclaw/openclaw.json",
    [
      "// OpenClaw writes JSON5",
      "{",
      "  agents: { defaults: { model: { primary: 'anthropic/claude-opus-5-5', fallbacks: [] }, }, },",
      "  channels: {",
      `    telegram: { botToken: '${SECRETS.telegram}', dmPolicy: 'pairing', allowFrom: ['tg:42'], },`,
      "    discord: { token: '${DISCORD_BOT_TOKEN}', },",
      `    slack: { botToken: "${SECRETS.slackBot}", appToken: { source: 'env', provider: 'default', id: 'SLACK_APP_TOKEN' }, },`,
      "    whatsapp: { enabled: true, allowFrom: ['+15550001111'] },",
      "    signal: { account: '+15550002222' },",
      "  },",
      "}",
    ].join("\n"),
  );
  const ws = ".openclaw/workspace";
  write(home, `${ws}/AGENTS.md`, "# Operating\n\nRead memory first.\n");
  write(home, `${ws}/SOUL.md`, "Warm, direct, curious.\n");
  write(home, `${ws}/MEMORY.md`, "- The garden needs water on Sundays.\n");
  write(home, `${ws}/USER.md`, "- Lives in Porto\n");
  write(home, ".openclaw/skills/weather/SKILL.md", "---\nname: weather\ndescription: The weather\n---\nLook outside.\n");
  write(home, ".openclaw/.env", `OPENAI_API_KEY=${SECRETS.openclawEnv}\n`);
  write(home, ".openclaw/credentials/whatsapp/default/creds.json", JSON.stringify({ key: SECRETS.whatsappCreds }));
}

/** A home with all four tools in it. */
function fixtureHome(): string {
  const home = join(scratch, `home-${++homes}`);
  mkdirSync(home, { recursive: true });
  claudeHome(home);
  codexHome(home);
  cursorHome(home);
  openclawHome(home);
  return home;
}

const itemsOf = (scan: Scan, source: string) => scan.sources.find((s) => s.id === source)?.items ?? [];
const skippedOf = (scan: Scan, source: string) => scan.sources.find((s) => s.id === source)?.skipped ?? [];
const byKey = (scan: Scan, key: string) => scan.sources.flatMap((s) => s.items).find((i) => i.key === key)!;

// ── the fake rest of Bloks ─────────────────────────────────────────────

type FakeAgent = AgentSettings & { id: string; name: string; busy: boolean; archived?: boolean; talked?: boolean };

interface World {
  deps: ImportDeps;
  agents: Map<string, FakeAgent>;
  memory: Map<string, string>;
  skills: Array<{ id: string; source: "builtin" | "user"; name: string; description: string; body: string }>;
  mcp: McpEntry[];
  rules: Rule[];
  notes: ProfileNote[];
  channels: Map<string, Record<string, string>>;
  engines: Partial<Record<Engine, { instanceId: string; model: string }>>;
  goodTokens: Set<string>;
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
    skills: [{ id: "code-review", source: "builtin", name: "Code review", description: "", body: "x" }],
    mcp: [],
    rules: [],
    notes: [],
    channels: new Map(),
    engines: { claude: { instanceId: "claude", model: "claude-sonnet-5" }, codex: { instanceId: "codex", model: "gpt-6-luna" } },
    goodTokens: new Set([SECRETS.telegram, SECRETS.slackBot, "xapp-1-A0000000000-typed-by-the-person", "typed-discord-token-123456"]),
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
  const channelKey = (platform: string, botId?: string) => (platform === "telegram" ? `telegram:${botId}` : platform);
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
    notes: () => w.notes,
    suggestNote: (text, by) => {
      const note: ProfileNote = { id: `note-${++n}`, text, state: "suggested", by, at: 0 };
      w.notes.push(note);
      return note;
    },
    removeNote: (id) => {
      const had = w.notes.length;
      w.notes = w.notes.filter((x) => x.id !== id);
      return w.notes.length < had;
    },
    channel: (platform, botId) => {
      const tokens = w.channels.get(channelKey(platform, botId));
      return tokens ? { tokenHash: mod.tokenHash(tokens.botToken ?? tokens.token) } : null;
    },
    connectChannel: async ({ platform, botId, tokens }) => {
      for (const token of Object.values(tokens)) if (!w.goodTokens.has(token)) throw new Error("that token was refused");
      w.channels.set(channelKey(platform, botId), tokens);
    },
    disconnectChannel: (platform, botId) => {
      w.channels.delete(channelKey(platform, botId));
    },
    // pictures, workspace files and routines come only from OpenBot,
    // whose own tests (test/setup-import-openbot.test.ts) fake them in full
    avatarHash: () => null,
    setAvatar: () => {},
    clearAvatar: () => {},
    writeWorkspaceFile: () => "written",
    readWorkspaceFile: () => null,
    removeWorkspaceFile: () => false,
    addRoutine: () => null,
    routine: () => null,
    removeRoutine: () => false,
  };
  return w;
}

const recordFile = () => join(scratch, `record-${++homes}.json`);

/** A pick the way the window sends one: the review's suggestion, plus
 * whatever the test says about clashes and values. */
function pick(review: Review, key: string, extra: Partial<Pick> = {}): Pick {
  const item = review.sources.flatMap((s) => s.items).find((i) => i.key === key);
  assert.ok(item, `no item ${key}`);
  return { key, digest: item.digest, to: item.suggested.to, ...(item.suggested.botId ? { botId: item.suggested.botId } : {}), ...extra };
}

// ── finding ────────────────────────────────────────────────────────────

describe("Claude Code", () => {
  test("subagents become agents with their prompt, model, colour, skills, servers and refusals", () => {
    const scan = mod.detectSetup(fixtureHome());
    const reviewer = byKey(scan, "claude:agent:reviewer");
    assert.equal(reviewer.kind, "agent");
    assert.deepEqual(reviewer.destinations, ["agent"]);
    const a = reviewer.agent!;
    assert.equal(a.name, "code-reviewer");
    assert.equal(a.title, "Reviews code for quality and safety.");
    assert.deepEqual(a.model, { engine: "claude", model: "opus" });
    assert.equal(a.color, "purple");
    assert.deepEqual(a.skills, ["standup", "missing-skill"]);
    assert.deepEqual(a.servers, ["github"], "a server it defines inline is not one Bloks has");
    // Read, Grep and Glob only: every acting tool is refused, for it alone
    assert.deepEqual(
      a.deny.map((d) => d.value),
      ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
    );
    assert.match(a.instructions, /^You review code\. Never print keys like \[removed\]\.$/);
    const notes = reviewer.notes.join(" ");
    assert.match(notes, /defines a server of its own/);
    assert.match(notes, /permission mode is not carried/);
    assert.match(notes, /1 thing that looked like a key/);

    const runner = byKey(scan, "claude:agent:runner").agent!;
    assert.deepEqual(runner.model, { engine: "claude", model: "haiku" });
    assert.equal(runner.effort, "high");
    // a block list of tools, and the disallowed ones as written
    assert.deepEqual(
      runner.deny.map((d) => [d.field, d.op, d.value]),
      [
        ["tool", "equals", "Edit"],
        ["tool", "equals", "Write"],
        ["tool", "equals", "NotebookEdit"],
        ["tool", "equals", "WebFetch"],
        ["tool", "equals", "WebSearch"],
        ["command", "contains", "rm"],
      ],
    );

    assert.match(byKey(scan, "claude:agent:odd").notes.join(" "), /gpt-4, is not one Bloks knows/);
    assert.match(byKey(scan, "claude:agent:long").notes.join(" "), /goes to the agent's memory/);
    assert.ok(skippedOf(scan, "claude").some((s) => s.from === "~/.claude/agents/empty.md" && /no prompt/.test(s.why)));
  });

  test("commands become skills that say what their placeholders were", () => {
    const scan = mod.detectSetup(fixtureHome());
    const commit = byKey(scan, "claude:command:commit");
    assert.equal(commit.kind, "skill");
    assert.equal(commit.title, "/commit");
    assert.equal(commit.skill!.id, "commit");
    assert.equal(commit.skill!.description, "Commit what changed");
    assert.match(commit.skill!.body, /^Written as the \/commit command for Claude Code\. Where it says \$ARGUMENTS/);
    assert.match(commit.skill!.body, /Commit with the message \$ARGUMENTS\./);
    assert.match(commit.notes.join(" "), /ran a command first/);

    const component = byKey(scan, "claude:command:frontend/component");
    assert.equal(component.title, "/frontend:component", "a folder is a namespace, as Claude Code names it");
    assert.equal(component.skill!.id, "frontend-component");
  });

  test("rule files, CLAUDE.md's imports, servers from both files, and the default model", () => {
    const scan = mod.detectSetup(fixtureHome());
    const claude = itemsOf(scan, "claude");
    const testing = claude.find((i) => i.title === "rules/testing.md")!;
    assert.equal(testing.text, "Write the test first.");
    assert.match(testing.notes.join(" "), /only for files matching src\/\*\*\/\*\.ts, test\/\*\*/);
    assert.ok(claude.some((i) => i.title === "rules/style.md"));
    assert.ok(skippedOf(scan, "claude").some((s) => s.from === "~/.claude/rules/broken.md" && /never closed/.test(s.why)));

    const md = claude.find((i) => i.title === "CLAUDE.md")!;
    assert.match(md.notes.join(" "), /pulls in @~\/\.claude\/extra\.md, @docs\/guide\.md, which are not brought over/);
    assert.equal(md.notes.join(" ").includes("not/an/import"), false, "a path in a code block is not an import");

    assert.deepEqual(
      claude.filter((i) => i.kind === "mcp").map((i) => [i.title, i.from]),
      [
        ["github", "~/.claude.json"],
        ["linear", "~/.claude.json"],
        ["extra", "~/.claude/settings.json"],
      ],
    );
    assert.match(byKey(scan, "claude:mcp:extra").notes.join(" "), /does not read servers from settings\.json/);
    assert.ok(skippedOf(scan, "claude").some((s) => s.from === "~/.claude.json: socket"), "a websocket server is left out");
    const setting = byKey(scan, "claude:setting:model");
    assert.deepEqual(setting.setting, { engine: "claude", model: "opus" });
  });
});

describe("Codex", () => {
  test("the override wins over AGENTS.md, and the model and effort are offered", () => {
    const scan = mod.detectSetup(fixtureHome());
    const codex = itemsOf(scan, "codex");
    assert.equal(codex[0].title, "AGENTS.override.md");
    assert.equal(codex[0].text, "The override wins.");
    assert.ok(skippedOf(scan, "codex").some((s) => s.from === "~/.codex/AGENTS.md" && /override/.test(s.why)));
    assert.deepEqual(byKey(scan, "codex:setting:model").setting, { engine: "codex", model: "gpt-6-sol", effort: "max" });
  });

  test("prompts become skills, only from the top of the folder, and both skills folders are read", () => {
    const scan = mod.detectSetup(fixtureHome());
    const review = byKey(scan, "codex:prompt:review");
    assert.equal(review.title, "/prompts:review");
    assert.match(review.skill!.body, /in Codex \$1 was the first thing they gave/);
    assert.match(review.notes.join(" "), /now suggests skills/);
    assert.equal(itemsOf(scan, "codex").some((i) => i.key.includes("deep")), false);
    const deploys = itemsOf(scan, "codex").filter((i) => i.kind === "skill" && i.skill!.id === "deploy");
    assert.deepEqual(deploys.map((d) => [d.key, d.from]), [
      ["codex:skill:agents/deploy", "~/.agents/skills/deploy/SKILL.md"],
      ["codex:skill:deploy", "~/.codex/skills/deploy/SKILL.md"],
    ]);
  });

  test("a server's values are slots: literal ones can be copied, the rest name their variable", () => {
    const scan = mod.detectSetup(fixtureHome());
    const local = byKey(scan, "codex:mcp:local");
    assert.deepEqual(local.mcp!.env, { API_TOKEN: "", HOME_TOKEN: "", REMOTE_TOKEN: "" });
    assert.deepEqual(local.secrets, [
      { id: "env:API_TOKEN", name: "API_TOKEN", where: "env", copyFrom: "~/.codex/config.toml" },
      { id: "env:HOME_TOKEN", name: "HOME_TOKEN", where: "env", ref: "HOME_TOKEN" },
      { id: "env:REMOTE_TOKEN", name: "REMOTE_TOKEN", where: "env", ref: "REMOTE_TOKEN" },
    ]);
    assert.equal(mod.secretValue(local, "env:API_TOKEN"), SECRETS.codexEnv, "known to the server, for an import that is told to copy it");
    assert.deepEqual(byKey(scan, "codex:mcp:search").secrets, [{ id: "header:Authorization", name: "Authorization", where: "header", ref: "SEARCH_KEY" }]);
  });
});

describe("Cursor", () => {
  test("rules: always-on ones are instructions, the rest are skills, and a broken one is named", () => {
    const scan = mod.detectSetup(fixtureHome());
    const cursor = itemsOf(scan, "cursor");
    const always = cursor.find((i) => i.title === "rules/always.mdc")!;
    assert.equal(always.kind, "instructions");
    assert.equal(always.text, "Always answer in English.");
    const react = byKey(scan, "cursor:rule-file:react");
    assert.equal(react.kind, "skill");
    assert.equal(react.skill!.description, "React components");
    assert.match(react.notes.join(" "), /files matching \*\*\/\*\.tsx, \*\*\/\*\.jsx/);
    assert.equal(byKey(scan, "cursor:rule-file:notes").kind, "skill", "a plain .md rule reads too");
    const skipped = skippedOf(scan, "cursor");
    assert.ok(skipped.some((s) => s.from === "~/.cursor/rules/broken.mdc" && /never closed/.test(s.why)));
    assert.ok(skipped.some((s) => s.from === "Cursor Settings, Rules" && /not in a file|rather than in a file/.test(s.why)), "user rules are said to live in Cursor's settings");
  });

  test("a read-only subagent is refused the acting tools, and Cursor's model is not guessed at", () => {
    const scan = mod.detectSetup(fixtureHome());
    const planner = byKey(scan, "cursor:agent:planner");
    assert.deepEqual(planner.agent!.deny.map((d) => d.value), ["Bash", "Edit", "Write", "NotebookEdit"]);
    assert.equal(planner.agent!.model, undefined);
    assert.match(planner.notes.join(" "), /claude-4\.5-sonnet is not carried/);
  });

  test("mcp.json with a comment in it, Cursor's own variables, and the copies of Claude Code's", () => {
    const scan = mod.detectSetup(fixtureHome());
    const home = scan.home;
    const figma = byKey(scan, "cursor:mcp:figma");
    assert.deepEqual(figma.secrets, [{ id: "header:X-Api-Key", name: "X-Api-Key", where: "header", ref: "FIGMA_KEY" }]);
    const tools = byKey(scan, "cursor:mcp:tools");
    assert.equal(tools.mcp!.command, `${home}/bin/tools`, "the home folder is this one");
    assert.match(tools.notes.join(" "), /read its environment from a file/);
    assert.match(tools.notes.join(" "), /names the project folder/);
    // the same server and skill as Claude Code's wait, unticked, saying so
    // values are never compared, only what the server is: the same command
    // asking for the same names is the same server
    assert.equal(byKey(scan, "cursor:mcp:github").sameAs, "Claude Code's github");
    const standup = byKey(scan, "cursor:skill:standup");
    assert.equal(standup.sameAs, "Claude Code's standup");
  });
});

describe("OpenClaw", () => {
  test("its JSON5 config gives the model and the chat apps Bloks also has", () => {
    const scan = mod.detectSetup(fixtureHome());
    assert.deepEqual(byKey(scan, "openclaw:setting:model").setting, { engine: "claude", model: "claude-opus-5-5" });
    const telegram = byKey(scan, "openclaw:channel:telegram");
    assert.deepEqual(telegram.channel, { platform: "telegram" });
    assert.deepEqual(telegram.secrets, [{ id: "token:botToken", name: "Bot token", where: "token", required: true, copyFrom: "~/.openclaw/openclaw.json" }]);
    assert.equal(mod.secretValue(telegram, "token:botToken"), SECRETS.telegram);
    assert.deepEqual(byKey(scan, "openclaw:channel:discord").secrets, [{ id: "token:token", name: "Bot token", where: "token", required: true, ref: "DISCORD_BOT_TOKEN" }]);
    const slack = byKey(scan, "openclaw:channel:slack");
    assert.deepEqual(
      slack.secrets!.map((s) => [s.id, Boolean(s.copyFrom)]),
      [
        ["token:botToken", true],
        ["token:appToken", false],
      ],
    );
    assert.match(slack.notes.join(" "), /App-level token is in OpenClaw's secret store/);
    assert.match(slack.notes.join(" "), /saved switched off/);
    const skipped = skippedOf(scan, "openclaw").map((s) => s.from);
    assert.ok(skipped.includes("~/.openclaw/openclaw.json: channels.whatsapp"));
    assert.ok(skipped.includes("~/.openclaw/openclaw.json: channels.signal"));
  });

  test("the workspace's AGENTS.md, SOUL.md, memory and facts, and the managed skills", () => {
    const scan = mod.detectSetup(fixtureHome());
    const titles = itemsOf(scan, "openclaw").map((i) => [i.kind, i.title]);
    for (const want of [
      ["instructions", "SOUL.md"],
      ["instructions", "AGENTS.md"],
      ["memory", "MEMORY.md"],
      ["fact", "Lives in Porto"],
      ["skill", "weather"],
    ]) {
      assert.ok(titles.some(([k, t]) => k === want[0] && t === want[1]), `missing ${want.join(" ")}`);
    }
    assert.equal(byKey(scan, "openclaw:skill:managed/weather").from, "~/.openclaw/skills/weather/SKILL.md");
  });

  test("a config it cannot read is named, and the workspace is still read", () => {
    const home = join(scratch, `home-${++homes}`);
    write(home, ".openclaw/openclaw.json", "{ channels: { telegram: { botToken: 'x' }, ");
    write(home, ".openclaw/workspace/SOUL.md", "Still here.\n");
    write(home, ".cursor/mcp.json", "{ not json at all");
    const scan = mod.detectSetup(home);
    assert.ok(skippedOf(scan, "openclaw").some((s) => /not JSON5 Bloks can read/.test(s.why)));
    assert.deepEqual(itemsOf(scan, "openclaw").map((i) => i.title), ["SOUL.md"]);
    assert.ok(skippedOf(scan, "cursor").some((s) => s.from === "~/.cursor/mcp.json" && /not JSON/.test(s.why)));
  });

  test("a workspace the config points outside the home folder is not followed", () => {
    const home = join(scratch, `home-${++homes}`);
    write(home, ".openclaw/openclaw.json", "{ agents: { defaults: { workspace: '/etc' } } }");
    write(home, ".openclaw/workspace/SOUL.md", "The usual place.\n");
    const scan = mod.detectSetup(home);
    assert.deepEqual(itemsOf(scan, "openclaw").map((i) => i.text), ["The usual place."]);
    assert.ok(skippedOf(scan, "openclaw").some((s) => /outside your home folder/.test(s.why)));
  });
});

describe("what is never read or shown", () => {
  test("no value from any tool reaches a scan, a review or a dry run, and credential files are not opened", () => {
    const home = fixtureHome();
    const scan = mod.detectSetup(home);
    const review = mod.reviewOf(scan, new mod.ImportRecord(recordFile()), world().deps);
    for (const shown of [JSON.stringify(scan), JSON.stringify(review), mod.dryRunReport(scan)]) {
      for (const [name, secret] of Object.entries(SECRETS)) assert.equal(shown.includes(secret), false, `${name} was shown`);
      assert.equal(shown.includes("me@example.com"), false);
    }
  });

  test("one tool at a time, and an empty home finds nothing", () => {
    const home = fixtureHome();
    assert.deepEqual(mod.detectSetup(home, "cursor").sources.map((s) => s.id), ["cursor"]);
    const empty = join(scratch, `home-${++homes}`);
    mkdirSync(empty);
    assert.deepEqual(mod.detectSetup(empty).sources, []);
    assert.match(mod.dryRunReport(mod.detectSetup(empty)), /Nothing to bring over/);
  });
});

// ── the review ─────────────────────────────────────────────────────────

describe("the review", () => {
  test("groups by what each becomes; copies, rules and chat apps wait unticked", () => {
    const home = fixtureHome();
    const w = world();
    const review = mod.reviewOf(mod.detectSetup(home), new mod.ImportRecord(recordFile()), w.deps) as SetupReview;
    const groups = groupReview(review);
    assert.deepEqual(
      groups.map((g) => g.label),
      ["Agents", "Instructions and memory", "Skills", "MCP servers", "Models", "Rules", "About you", "Chat apps"],
    );
    const agents = groups[0].entries.map((e) => `${e.source.id}:${e.item.title}`);
    assert.deepEqual(agents, ["claude:long", "claude:odd", "claude:code-reviewer", "claude:test-runner", "cursor:planner"], "by file name, as each tool lists them");
    const all = review.sources.flatMap((s) => s.items);
    assert.ok(all.filter((i) => i.kind === "channel").every((i) => !i.picked));
    assert.equal(all.find((i) => i.key === "cursor:skill:standup")!.picked, false);
    assert.ok(all.filter((i) => i.kind === "agent").every((i) => i.picked));
  });

  test("a name already here is a clash for the person to settle, and Bloks's own skills are never replaced", () => {
    const home = fixtureHome();
    const w = world();
    w.skills.push({ id: "standup", source: "user", name: "My standup", description: "", body: "mine" });
    w.skills.push({ id: "commit", source: "builtin", name: "Commit", description: "", body: "ships with Bloks" });
    w.agents.set("rev", { ...w.agents.get("nova")!, id: "rev", name: "Code-Reviewer" });
    w.mcp.push({ id: "gh", name: "GitHub", transport: "stdio", command: "gh-mcp" });
    const review = mod.reviewOf(mod.detectSetup(home), new mod.ImportRecord(recordFile()), w.deps);
    const item = (key: string) => review.sources.flatMap((s) => s.items).find((i) => i.key === key)!;
    assert.deepEqual(item("claude:skill:standup").conflict, { kind: "skill", name: "My standup", canReplace: true });
    assert.deepEqual(item("claude:command:commit").conflict, { kind: "skill", name: "Commit", canReplace: false });
    assert.deepEqual(item("claude:agent:reviewer").conflict, { kind: "agent", name: "Code-Reviewer", canReplace: true });
    assert.deepEqual(item("claude:mcp:github").conflict, { kind: "mcp", name: "GitHub", canReplace: false });
    // the window starts every clash at keep both
    assert.equal(choicesFrom(review as SetupReview)["claude:skill:standup"].conflict, "both");
  });

  test("what the window sends: a copy only when ticked, a typed value only when there is one", () => {
    const home = fixtureHome();
    const review = mod.reviewOf(mod.detectSetup(home), new mod.ImportRecord(recordFile()), world().deps) as SetupReview;
    const telegram = review.sources.flatMap((s) => s.items).find((i) => i.key === "openclaw:channel:telegram")!;
    const choice = { ...choicesFrom(review)[telegram.key], on: true };
    assert.deepEqual(missingSecrets(telegram, choice).map((s) => s.id), ["token:botToken"]);
    assert.equal(pickFor(telegram, choice).secrets, undefined);
    assert.deepEqual(pickFor(telegram, { ...choice, copy: { "token:botToken": true } }).secrets, { "token:botToken": { copy: true } });
    assert.deepEqual(pickFor(telegram, { ...choice, typed: { "token:botToken": "  typed  " } }).secrets, { "token:botToken": { value: "typed" } });
    assert.deepEqual(missingSecrets(telegram, { ...choice, typed: { "token:botToken": "typed" } }), []);
  });
});

// ── importing ──────────────────────────────────────────────────────────

describe("importing", () => {
  test("a subagent arrives as an agent, with the skills and servers this import brought, and its own refusals", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const outcome = await mod.applyImport(
      mod.detectSetup(home),
      [pick(review, "claude:agent:reviewer"), pick(review, "claude:skill:standup"), pick(review, "claude:mcp:github")],
      w.deps,
      record,
    );
    assert.deepEqual(outcome.results.map((r) => [r.key, r.ok, r.did]), [
      ["claude:skill:standup", true, "added"],
      ["claude:mcp:github", true, "added"],
      ["claude:agent:reviewer", true, "added"],
    ]);
    const agent = [...w.agents.values()].find((a) => a.name === "code-reviewer")!;
    assert.equal(agent.title, "Reviews code for quality and safety.");
    assert.match(agent.description, /^You review code\./);
    assert.deepEqual(agent.modelSelection, { instanceId: "claude", model: "opus" });
    assert.equal(agent.color, "purple");
    assert.deepEqual(agent.skillIds, ["standup"]);
    assert.deepEqual(agent.mcpServers, [w.mcp[0].id]);
    assert.match(outcome.results[2].note!, /no skill called missing-skill/);
    const mine = w.rules.filter((r) => r.botId === agent.id);
    assert.deepEqual(mine.map((r) => [r.effect, r.field, r.value]).slice(0, 2), [
      ["deny", "tool", "Bash"],
      ["deny", "tool", "Edit"],
    ]);
    assert.ok(w.rules.every((r) => r.botId === agent.id), "nobody else's rules");

    // again: the same agent, nothing new
    const again = await mod.applyImport(mod.detectSetup(home), [pick(mod.reviewOf(mod.detectSetup(home), record, w.deps), "claude:agent:reviewer")], w.deps, record);
    assert.equal(again.results[0].did, "unchanged");
    assert.equal([...w.agents.values()].filter((a) => a.name === "code-reviewer").length, 1);
    assert.equal(w.rules.length, mine.length);
  });

  test("a prompt too long for instructions goes whole to the new agent's memory", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    await mod.applyImport(mod.detectSetup(home), [pick(review, "claude:agent:long")], w.deps, record);
    const agent = [...w.agents.values()].find((a) => a.name === "long")!;
    assert.ok(agent.description.length <= 4_000);
    assert.match(agent.description, /under "Instructions from Claude Code"/);
    assert.match(w.memory.get(`${agent.id}/MEMORY.md`)!, /^## Instructions from Claude Code\n\nExplain it in full\./);
  });

  test("a model setting goes to the agent made for that tool, or says the engine is missing", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const outcome = await mod.applyImport(mod.detectSetup(home), [pick(review, "codex:instructions:AGENTS.override.md"), pick(review, "codex:setting:model")], w.deps, record);
    assert.deepEqual(outcome.created.length, 1, "one agent for Codex, holding both");
    const agent = w.agents.get(outcome.created[0])!;
    assert.deepEqual(agent.modelSelection, { instanceId: "codex", model: "gpt-6-sol" });
    assert.equal(agent.effort, "max");

    const none = world();
    delete none.engines.codex;
    const failed = await mod.applyImport(mod.detectSetup(home), [pick(review, "codex:setting:model")], none.deps, new mod.ImportRecord(recordFile()));
    assert.match(failed.results[0].error!, /Codex is not set up in Bloks yet/);
    assert.equal(none.agents.size, 1, "no agent made for a setting that could not land");
  });

  test("clashes: keep both renames, replace writes over a person's skill or updates an agent, and undo puts them back", async () => {
    const home = fixtureHome();
    const w = world();
    w.skills.push({ id: "standup", source: "user", name: "My standup", description: "mine", body: "my own steps" });
    w.agents.set("rev", { ...w.agents.get("nova")!, id: "rev", name: "code-reviewer", description: "Old prompt.", title: "Old" });
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);

    const both = await mod.applyImport(mod.detectSetup(home), [pick(review, "claude:skill:standup", { conflict: "both" })], w.deps, record);
    assert.match(both.results[0].note!, /Added as standup-claude/);
    assert.equal(w.skills.find((s) => s.id === "standup")!.body, "my own steps");

    const record2 = new mod.ImportRecord(recordFile());
    const review2 = mod.reviewOf(mod.detectSetup(home), record2, w.deps);
    const replaced = await mod.applyImport(
      mod.detectSetup(home),
      [pick(review2, "claude:skill:standup", { conflict: "replace" }), pick(review2, "claude:agent:reviewer", { conflict: "replace" })],
      w.deps,
      record2,
    );
    assert.ok(replaced.results.every((r) => r.ok), JSON.stringify(replaced.results));
    assert.match(w.skills.find((s) => s.id === "standup")!.body, /List yesterday/);
    assert.match(w.agents.get("rev")!.description, /^You review code/);
    assert.equal(w.agents.get("rev")!.title, "Reviews code for quality and safety.");

    const runs = new undo.ImportRuns(join(scratch, `runs-${++homes}.json`));
    const run = runs.add(replaced, Date.now())!;
    const back = undo.undoRun(run, w.deps, record2);
    assert.deepEqual(back.kept, []);
    assert.equal(w.skills.find((s) => s.id === "standup")!.body, "my own steps");
    assert.equal(w.agents.get("rev")!.description, "Old prompt.");
    assert.equal(w.agents.get("rev")!.title, "Old");
    assert.ok(!w.agents.get("rev")!.archived, "an agent that was here before is never archived by an undo");
    assert.equal(w.rules.length, 0, "and the refusals it brought are gone");
  });

  test("a value is copied only for a slot the person said to, typed values land as typed, and none is ever kept elsewhere", async () => {
    const home = fixtureHome();
    const w = world();
    const file = recordFile();
    const record = new mod.ImportRecord(file);
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const outcome = await mod.applyImport(
      mod.detectSetup(home),
      [
        pick(review, "codex:mcp:local", { secrets: { "env:API_TOKEN": { copy: true }, "env:HOME_TOKEN": { value: "typed-home-token" } } }),
        pick(review, "claude:mcp:github"),
      ],
      w.deps,
      record,
    );
    assert.ok(outcome.results.every((r) => r.ok));
    const local = w.mcp.find((s) => s.name === "local")!;
    assert.deepEqual(local.env, { API_TOKEN: SECRETS.codexEnv, HOME_TOKEN: "typed-home-token", REMOTE_TOKEN: "" });
    assert.match(outcome.results.find((r) => r.key === "codex:mcp:local")!.note!, /Still needs REMOTE_TOKEN/);
    assert.deepEqual(w.mcp.find((s) => s.name === "github")!.env, { GITHUB_TOKEN: "" }, "not copied when nobody said to");

    const runsFile = join(scratch, `runs-${++homes}.json`);
    new undo.ImportRuns(runsFile).add(outcome, Date.now());
    for (const kept of [readFileSync(file, "utf8"), readFileSync(runsFile, "utf8"), JSON.stringify(outcome)]) {
      assert.equal(kept.includes(SECRETS.codexEnv), false, "a value was kept outside the server list");
      assert.equal(kept.includes("typed-home-token"), false);
    }
  });

  test("asking to copy a value that is not there, or a chat app with no token, says why and makes nothing", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const outcome = await mod.applyImport(
      mod.detectSetup(home),
      [
        pick(review, "codex:mcp:local", { secrets: { "env:HOME_TOKEN": { copy: true } } }),
        pick(review, "openclaw:channel:discord"),
      ],
      w.deps,
      record,
    );
    assert.match(outcome.results[0].error!, /no HOME_TOKEN in ~\/\.codex\/config\.toml to copy/);
    assert.match(outcome.results[1].error!, /needs its bot token\. Paste it\./);
    assert.equal(w.mcp.length, 0);
    assert.equal(w.channels.size, 0);
  });

  test("a chat app connects switched off with the token said yes to, once, and a refused token leaves nothing behind", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const outcome = await mod.applyImport(
      mod.detectSetup(home),
      [
        pick(review, "openclaw:channel:telegram", { secrets: { "token:botToken": { copy: true } } }),
        pick(review, "openclaw:channel:slack", { secrets: { "token:botToken": { copy: true }, "token:appToken": { value: "xapp-1-A0000000000-typed-by-the-person" } } }),
      ],
      w.deps,
      record,
    );
    assert.ok(outcome.results.every((r) => r.ok), JSON.stringify(outcome.results));
    assert.match(outcome.results[0].note!, /Saved switched off/);
    const agentId = outcome.results[0].botId!;
    assert.deepEqual(w.channels.get(`telegram:${agentId}`), { botToken: SECRETS.telegram });
    assert.deepEqual(w.channels.get("slack"), { botToken: SECRETS.slackBot, appToken: "xapp-1-A0000000000-typed-by-the-person" });

    // the same again: already connected, said plainly
    const again = await mod.applyImport(
      mod.detectSetup(home),
      [pick(mod.reviewOf(mod.detectSetup(home), record, w.deps), "openclaw:channel:slack", { secrets: { "token:botToken": { copy: true }, "token:appToken": { value: "xapp-1-A0000000000-typed-by-the-person" } } })],
      w.deps,
      record,
    );
    assert.match(again.results[0].error!, /Slack is already connected/);

    // a token the app refuses: the agent made only to hold it goes too
    const w2 = world();
    const record2 = new mod.ImportRecord(recordFile());
    const refused = await mod.applyImport(
      mod.detectSetup(home),
      [pick(mod.reviewOf(mod.detectSetup(home), record2, w2.deps), "openclaw:channel:telegram", { secrets: { "token:botToken": { value: "999:refused-by-the-fake" } } })],
      w2.deps,
      record2,
    );
    assert.match(refused.results[0].error!, /refused/);
    assert.deepEqual([...w2.agents.values()].filter((a) => !a.archived).map((a) => a.id), ["nova"]);
    assert.deepEqual(refused.created, []);
    assert.deepEqual(refused.steps, []);
  });
});

// ── undoing ────────────────────────────────────────────────────────────

describe("undoing an import", () => {
  test("everything it made goes back, and the review offers it all again", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const scan = mod.detectSetup(home);
    const review = mod.reviewOf(scan, record, w.deps);
    const picks = review.sources.flatMap((s) => s.items).filter((i) => i.picked).map((i) => pick(review, i.key));
    picks.push(pick(review, "claude:rule:deny:Bash(git push --force:*)"));
    picks.push(pick(review, "openclaw:channel:telegram", { secrets: { "token:botToken": { copy: true } } }));
    const outcome = await mod.applyImport(scan, picks, w.deps, record);
    assert.deepEqual(outcome.results.filter((r) => !r.ok), []);
    assert.ok(w.skills.some((s) => s.source === "user") && w.mcp.length && w.rules.length && w.notes.length && w.channels.size && w.memory.size);

    const runs = new undo.ImportRuns(join(scratch, `runs-${++homes}.json`));
    const run = runs.add(outcome, Date.now())!;
    assert.equal(runs.latest()!.id, run.id);
    const back = undo.undoRun(run, w.deps, record);
    runs.markUndone(run.id, Date.now());
    assert.deepEqual(back.kept, []);
    assert.equal(runs.latest(), undefined);

    assert.deepEqual([...w.agents.values()].filter((a) => !a.archived).map((a) => a.id), ["nova"], "every agent it made is archived");
    assert.equal(w.agents.get("nova")!.description, "Be brief.");
    assert.deepEqual(w.skills.map((s) => s.id), ["code-review"]);
    assert.deepEqual(w.mcp, []);
    assert.deepEqual(w.rules, []);
    assert.deepEqual(w.notes, []);
    assert.equal(w.channels.size, 0);
    const again = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    assert.ok(again.sources.flatMap((s) => s.items).every((i) => i.status === "new"), "nothing still says brought over");
  });

  test("what changed since stays and says why; an agent talked with is kept", async () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(recordFile());
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const fact = review.sources.flatMap((s) => s.items).find((i) => i.kind === "fact")!.key;
    const outcome = await mod.applyImport(
      mod.detectSetup(home),
      [
        pick(review, "claude:skill:standup"),
        pick(review, fact),
        pick(review, "claude:agent:runner"),
        pick(review, "codex:instructions:AGENTS.override.md", { to: "brief", botId: "nova" }),
      ],
      w.deps,
      record,
    );
    assert.deepEqual(outcome.results.filter((r) => !r.ok), []);
    w.skills.find((s) => s.id === "standup")!.body = "edited by the person";
    w.notes[0].state = "kept";
    [...w.agents.values()].find((a) => a.name === "test-runner")!.talked = true;
    w.agents.get("nova")!.description += "\n\nAnd one more thing.";

    const run = new undo.ImportRuns(join(scratch, `runs-${++homes}.json`)).add(outcome, Date.now())!;
    const back = undo.undoRun(run, w.deps, record);
    const why = back.kept.map((k) => k.why).join(" | ");
    assert.match(why, /edited since/);
    assert.match(why, /kept it in About you/);
    assert.match(why, /talked with test-runner since/);
    assert.match(why, /Nova's instructions have changed since/);
    assert.ok(w.skills.some((s) => s.id === "standup"));
    assert.ok([...w.agents.values()].some((a) => a.name === "test-runner" && !a.archived));
    // the refusals that came with test-runner go, the agent stays
    assert.equal(w.rules.length, 0);
    // a kept item still says it came over
    assert.ok(record.get("claude:skill:standup"));
  });

  test("an import that changed nothing is not kept, and only the newest few are", () => {
    const runs = new undo.ImportRuns(join(scratch, `runs-${++homes}.json`));
    const empty = { results: [], created: [], steps: [], records: [], touched: {} } as unknown as Parameters<typeof runs.add>[0];
    assert.equal(runs.add(empty, 1), null);
    const one = { ...empty, steps: [{ kind: "rule-added", key: "k", title: "t", id: "r" }] } as unknown as Parameters<typeof runs.add>[0];
    for (let i = 0; i < undo.MAX_RUNS + 5; i++) runs.add(one, i);
    const file = (runs as unknown as { file: string }).file;
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as unknown[]).length, undo.MAX_RUNS);
  });
});

// ── the pieces ─────────────────────────────────────────────────────────

describe("reading JSON5", () => {
  test("comments, trailing commas, bare keys, single quotes, hex and the odd number", () => {
    assert.deepEqual(json5.parseJson5("// top\n{ a: 1, 'b': 'two', \"c\": [1, 2,], /* in */ d: { e: +0x1F, f: .5, g: -Infinity }, }"), {
      a: 1,
      b: "two",
      c: [1, 2],
      d: { e: 31, f: 0.5, g: -Infinity },
    });
    assert.equal(json5.parseJson5("'it\\'s \\x41\\u0042'"), "it's AB");
  });

  test("anything it cannot read throws, and a prototype key is refused", () => {
    for (const bad of ["{ a: 1", "{ a: }", "{ a: 1 } trailing", "{ __proto__: { polluted: true } }", "'open", "[".repeat(100)]) {
      assert.throws(() => json5.parseJson5(bad), `${bad} was read`);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("from the terminal", () => {
  test("bloks-server import --dry-run lists what would come over and writes nothing", () => {
    const home = fixtureHome();
    const bin = fileURLToPath(new URL("../bin/bloks-server.mjs", import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home, BLOKS_PORT: "1" };
    const run = spawnSync(process.execPath, [bin, "import", "cursor", "--dry-run"], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Cursor \(~\/\.cursor\)/);
    assert.match(run.stdout, /  Agents\n    planner/);
    assert.match(run.stdout, /  MCP servers\n    github \(needs GITHUB_TOKEN\)/);
    assert.match(run.stdout, /Left out\n/);
    assert.match(run.stdout, /Nothing was imported/);
    for (const secret of Object.values(SECRETS)) assert.equal(run.stdout.includes(secret), false);

    const json = spawnSync(process.execPath, [bin, "import", "--dry-run", "--json"], { env, encoding: "utf8" });
    assert.equal(json.status, 0, json.stderr);
    const scan = JSON.parse(json.stdout) as { sources: Array<{ id: string; items: FoundItem[] }> };
    assert.deepEqual(scan.sources.map((s) => s.id), ["claude", "codex", "cursor", "openclaw"]);
    for (const secret of Object.values(SECRETS)) assert.equal(json.stdout.includes(secret), false);

    const refused = spawnSync(process.execPath, [bin, "import", "claude"], { env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Only a look from here/);
    const unknown = spawnSync(process.execPath, [bin, "import", "vim", "--dry-run"], { env, encoding: "utf8" });
    assert.match(unknown.stderr, /Which tool/);
  });
});
