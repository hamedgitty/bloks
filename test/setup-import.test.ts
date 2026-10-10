// Bring your setup (server/setup-import.ts): what is found in a person's
// other agent tools, what is never read or copied, and what an import
// does with the items that were ticked.
//
// Every home here is a fixture folder under the system's temp folder, and
// HOME points at a throwaway one before anything that reads it loads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { ImportDeps, McpEntry, Pick, Review, Scan } from "../server/setup-import.ts";
import type { Rule } from "../server/policy.ts";
import type { ProfileNote } from "../server/profile-notes.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-setup-import-"));
let mod: typeof import("../server/setup-import.ts");

before(async () => {
  // the workspace modules work out the data folder from HOME when loaded
  process.env.HOME = join(scratch, "bloks-home");
  process.env.USERPROFILE = process.env.HOME;
  mod = await import("../server/setup-import.ts");
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Things that must never come out of a scan, whatever else does. */
const SECRETS = [
  "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX0123456789",
  "sk-ant-oat01-SECRETSECRETSECRET123456",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "lin_api_SECRET1234567890abcdef",
  "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
  "sk-proj-CODEXSECRETCODEXSECRET1234",
  "tok_live_abcdefghijklmnop123456",
  "abcd1234efgh5678ijkl",
  "AKIAABCDEFGHIJKLMNOP",
  "hermes-env-secret-9f8e7d6c5b4a",
  "hunter2hunter2",
  "openclaw-weather-key-12345abcde",
];

let homes = 0;
function write(home: string, path: string, text: string) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A home with all four tools set up, and their credentials beside them. */
function fixtureHome(): string {
  const home = join(scratch, `home-${++homes}`);
  mkdirSync(home, { recursive: true });

  // Claude Code
  write(home, ".claude/CLAUDE.md", "# How I work\n\nUse pnpm. Never push without asking.\nMy key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX0123456789\n");
  write(
    home,
    ".claude/skills/release-notes/SKILL.md",
    "---\nname: Release notes\ndescription: |\n  Write release notes\n  from the merged pull requests\nallowed-tools: Bash\n---\n\n# Release notes\n\n1. Read the merged pull requests.\n2. Group them for users.\n",
  );
  write(home, ".claude/skills/release-notes/template.md", "a template the skill points at");
  write(home, ".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECRETSECRETSECRET123456" } }));
  write(
    home,
    ".claude.json",
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com" },
      userID: "user-123",
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_SECRET1234567890abcdef" } },
      },
      projects: { "/Users/me/app": { mcpServers: { "project-only": { command: "node", args: ["server.js"] } } } },
    }),
  );
  write(
    home,
    ".claude/settings.json",
    JSON.stringify({
      permissions: {
        allow: ["Bash(npm run test:*)", "Read(./src/**)", "WebFetch(domain:docs.example.com)"],
        deny: ["Bash(rm -rf:*)", "Read(./.env)", "Read(~/.ssh/**)"],
      },
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
    }),
  );

  // Codex
  write(home, ".codex/AGENTS.md", "Always write the test first.\n");
  write(home, ".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-proj-CODEXSECRETCODEXSECRET1234" }));
  write(
    home,
    ".codex/config.toml",
    [
      'model = "gpt-5"',
      "# servers",
      "[mcp_servers.docs]",
      'command = "npx"',
      "args = [",
      '  "-y",   # the package',
      '  "docs-mcp",',
      "]",
      'env = { DOCS_TOKEN = "tok_live_abcdefghijklmnop123456", LOG_LEVEL = "debug" }',
      "",
      '[mcp_servers."web search"]',
      'url = "https://search.example.com/mcp"',
      'bearer_token_env_var = "SEARCH_KEY"',
      "",
      "[mcp_servers.files]",
      "command = 'C:\\tools\\files.exe'",
      'args = ["--api-key", "abcd1234efgh5678ijkl"]',
      "[mcp_servers.files.env]",
      'NODE_OPTIONS = "--max-old-space-size=4096"',
      'FILES_ROOT = "/Users/me/files"',
      "",
    ].join("\n"),
  );

  // OpenClaw
  const ws = ".openclaw/workspace";
  write(home, `${ws}/SOUL.md`, "# Soul\n\nBe direct. Have opinions.\n");
  write(home, `${ws}/IDENTITY.md`, "# Identity\n\n- **Name:** Claw\n- **Vibe:** calm\n");
  write(home, `${ws}/MEMORY.md`, "# Memory\n\n- The deploy runs on Fridays.\n");
  write(home, `${ws}/memory/2026-01-02.md`, "Talked about the launch plan.\n");
  write(
    home,
    `${ws}/USER.md`,
    [
      "# USER.md - About Your Human",
      "",
      "- **Name:**",
      "- **What to call them:** Sam",
      "- **Timezone:** America/Toronto",
      "- Prefers short answers",
      "- password: hunter2hunter2",
      "_(What do they care about?)_",
      "",
    ].join("\n"),
  );
  write(home, `${ws}/skills/weather/SKILL.md`, "---\nname: Weather\ndescription: Look up the weather\n---\n\nUse the weather tool. key=openclaw-weather-key-12345abcde\n");
  write(home, ".aws/credentials", "[default]\naws_access_key_id = AKIAABCDEFGHIJKLMNOP\n");
  mkdirSync(join(home, ws, "skills", "creds"), { recursive: true });
  symlinkSync(join(home, ".aws", "credentials"), join(home, ws, "skills", "creds", "SKILL.md"));

  // Hermes
  write(home, ".hermes/memories/MEMORY.md", "The staging box is called kettle.\n§\nBackups run nightly.\n");
  write(home, ".hermes/memories/USER.md", "Works in product design\n§\nLikes tables over prose\n");
  write(home, ".hermes/skills/research/arxiv/SKILL.md", "---\nname: arXiv search\ndescription: Find papers\n---\n\nSearch arXiv first.\n");
  write(home, ".hermes/.env", "OPENROUTER_API_KEY=hermes-env-secret-9f8e7d6c5b4a\n");
  write(home, ".hermes/auth.json", JSON.stringify({ token: "hermes-env-secret-9f8e7d6c5b4a" }));
  return home;
}

function itemsOf(scan: Scan, source: string) {
  return scan.sources.find((s) => s.id === source)?.items ?? [];
}

describe("finding a setup", () => {
  test("each tool's instructions, skills, servers, rules and facts are found, grouped by tool", () => {
    const scan = mod.detectSetup(fixtureHome());
    assert.deepEqual(scan.sources.map((s) => s.id), ["claude", "codex", "openclaw", "hermes"]);

    const claude = itemsOf(scan, "claude");
    assert.deepEqual(
      claude.map((i) => [i.kind, i.title]),
      [
        ["instructions", "CLAUDE.md"],
        ["skill", "Release notes"],
        ["mcp", "github"],
        ["mcp", "linear"],
        ["rule", "Deny Bash(rm -rf:*)"],
        ["rule", "Deny Read(./.env)"],
        ["rule", "Deny Read(~/.ssh/**)"],
        ["rule", "Allow Bash(npm run test:*)"],
        ["rule", "Allow WebFetch(domain:docs.example.com)"],
      ],
    );
    const skill = claude.find((i) => i.kind === "skill")!;
    assert.equal(skill.skill!.description, "Write release notes from the merged pull requests", "a folded description reads as one line");
    assert.match(skill.notes.join(" "), /1 other file in its folder stays/);

    const codex = itemsOf(scan, "codex");
    assert.deepEqual(codex.map((i) => [i.kind, i.title]), [
      ["instructions", "AGENTS.md"],
      ["mcp", "docs"],
      ["mcp", "web search"],
      ["mcp", "files"],
    ]);

    const openclaw = scan.sources.find((s) => s.id === "openclaw")!;
    assert.equal(openclaw.agentName, "Claw", "a new agent takes the name IDENTITY.md gives");
    assert.deepEqual(
      openclaw.items.map((i) => [i.kind, i.title]),
      [
        ["instructions", "SOUL.md"],
        ["instructions", "IDENTITY.md"],
        ["memory", "MEMORY.md"],
        ["memory", "memory/2026-01-02.md"],
        ["skill", "Weather"],
        ["fact", "What to call them: Sam"],
        ["fact", "Timezone: America/Toronto"],
        ["fact", "Prefers short answers"],
      ],
    );
    assert.equal(openclaw.items.find((i) => i.title === "memory/2026-01-02.md")!.topic, "2026-01-02.md");

    const hermes = itemsOf(scan, "hermes");
    assert.deepEqual(hermes.map((i) => [i.kind, i.title]), [
      ["memory", "memories/MEMORY.md"],
      ["skill", "arXiv search"],
      ["fact", "Works in product design"],
      ["fact", "Likes tables over prose"],
    ]);
  });

  test("a tool that is not installed is not listed, and an empty home finds nothing", () => {
    const home = join(scratch, `home-${++homes}`);
    mkdirSync(home, { recursive: true });
    assert.deepEqual(mod.detectSetup(home).sources, []);
    write(home, ".codex/AGENTS.md", "Only Codex here.\n");
    assert.deepEqual(mod.detectSetup(home).sources.map((s) => s.id), ["codex"]);
  });

  test("credential files are never read, and nothing key-shaped survives into what is shown", () => {
    const home = fixtureHome();
    const scan = mod.detectSetup(home);
    const everything = JSON.stringify(scan);
    for (const secret of SECRETS) assert.equal(everything.includes(secret), false, `${secret} came out of the scan`);
    // nor anything else those files held
    assert.equal(everything.includes("me@example.com"), false);
    assert.equal(everything.includes("user-123"), false);
    assert.equal(everything.includes("project-only"), false, "a server tied to one project is not the person's");

    const linked = scan.sources.find((s) => s.id === "openclaw")!.skipped.find((s) => s.from.includes("creds"));
    assert.ok(linked, "a SKILL.md that is a link to a credentials file is named as left out");
    assert.match(linked.why, /sign-in or a key/);

    const instructions = itemsOf(scan, "claude")[0];
    assert.match(instructions.text, /My key is \[removed\]/);
    assert.match(instructions.notes.join(" "), /1 thing that looked like a key or a password was taken out/);
  });

  test("MCP servers come across with names to fill in and no values", () => {
    const scan = mod.detectSetup(fixtureHome());
    const server = (source: string, name: string) => [...itemsOf(scan, source)].find((i) => i.kind === "mcp" && i.title === name)!;

    const github = server("claude", "github");
    assert.deepEqual(github.mcp, {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    });
    assert.match(github.notes.join(" "), /GITHUB_PERSONAL_ACCESS_TOKEN was not copied\. Fill it in/);

    assert.deepEqual(server("claude", "linear").mcp, {
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "" },
    });

    // every value goes, not only the ones that look like keys
    assert.deepEqual(server("codex", "docs").mcp!.env, { DOCS_TOKEN: "", LOG_LEVEL: "" });
    assert.deepEqual(server("codex", "docs").mcp!.args, ["-y", "docs-mcp"]);
    assert.deepEqual(server("codex", "web search").mcp!.headers, { Authorization: "" });

    const files = server("codex", "files");
    assert.equal(files.mcp!.command, "C:\\tools\\files.exe", "a literal string keeps its backslashes");
    assert.deepEqual(files.mcp!.args, ["--api-key", ""], "the value after --api-key is left out");
    assert.deepEqual(files.mcp!.env, { FILES_ROOT: "" }, "NODE_OPTIONS changes how programs start, so it is not carried");
    assert.match(files.notes.join(" "), /NODE_OPTIONS was not carried/);
  });

  test("files past the size caps are left alone and said so", () => {
    const home = join(scratch, `home-${++homes}`);
    write(home, ".claude/CLAUDE.md", "x".repeat(mod.MAX_TEXT_FILE_BYTES + 1));
    write(home, ".claude/skills/huge/SKILL.md", `---\nname: Huge\n---\n${"word ".repeat(5_000)}`);
    const scan = mod.detectSetup(home);
    const claude = scan.sources.find((s) => s.id === "claude")!;
    assert.equal(claude.items.length, 0);
    assert.deepEqual(claude.skipped.map((s) => s.from), ["~/.claude/CLAUDE.md", "~/.claude/skills/huge/SKILL.md"]);
    assert.match(claude.skipped[0].why, /larger than 256 KB/);
    assert.match(claude.skipped[1].why, /longer than a skill holds/);
  });

  test("instructions too long for an agent's instructions are offered for memory only", () => {
    const home = join(scratch, `home-${++homes}`);
    write(home, ".codex/AGENTS.md", "Write it down. ".repeat(400));
    const [item] = mod.detectSetup(home).sources[0].items;
    assert.deepEqual(item.destinations, ["memory"]);
    assert.match(item.notes.join(" "), /goes to memory/);
  });
});

describe("taking secrets out", () => {
  test("key shapes, bearer tokens, passwords and secrets in addresses are removed and counted", () => {
    const { text, removed } = mod.scrubSecrets(
      [
        "anthropic sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
        "github ghp_0123456789abcdefghijABCDEFGHIJ0123",
        "slack xoxb-1234567890-abcdefghij",
        "aws AKIAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abc123def456ghi789jkl",
        'api_key = "zx81spectrum128k2026"',
        "password: correcthorse",
        "https://sam:s3cretpass@example.com/repo.git",
        "https://api.example.com/v1?api_key=abc123xyz789&format=json",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ].join("\n"),
    );
    assert.equal(removed, 10);
    for (const gone of ["AAAAAAAAAAAA", "ghp_", "xoxb-", "AKIA", "abc123def456", "zx81spectrum", "correcthorse", "s3cretpass", "abc123xyz789", "OPENSSH"]) {
      assert.equal(text.includes(gone), false, `${gone} is still there`);
    }
    // what said what it was stays, so the sentence still reads
    assert.match(text, /Bearer \[removed\]/);
    assert.match(text, /https:\/\/sam:\[removed\]@example\.com/);
    assert.match(text, /\?api_key=\[removed\]&format=json/);
  });

  test("ordinary writing about keys and tokens is left as it is", () => {
    const prose = [
      "Set max_tokens=4096 for long answers.",
      "Read the token from $GITHUB_TOKEN, never paste it.",
      "Token authentication is handled by the CLI.",
      "Use the api_key: <your key here> placeholder in docs.",
      "The commit is 3f2a9c1.",
    ].join("\n");
    assert.deepEqual(mod.scrubSecrets(prose), { text: prose, removed: 0 });
  });
});

describe("reading TOML", () => {
  test("tables, quoted keys, every kind of string, lists over lines and inline tables", () => {
    const parsed = mod.parseToml(
      [
        'title = "a \\"quoted\\" word\\tand a tab \\u00e9"',
        "path = 'C:\\no\\escapes'",
        'multi = """',
        "first line",
        'second line"""',
        "raw = '''",
        "kept \\as is'''",
        "count = 1_000",
        "ratio = 0.5",
        "on = true",
        "list = [ 1, 2, # a comment",
        "  3, ]",
        "inline = { a = \"x\", b.c = 'y' }",
        "",
        '[server."with space".env]',
        "KEY = \"value\"",
        "",
        "[[skipped]]",
        'name = "not kept"',
      ].join("\n"),
    );
    assert.equal(parsed.title, 'a "quoted" word\tand a tab \u00e9');
    assert.equal(parsed.path, "C:\\no\\escapes");
    assert.equal(parsed.multi, "first line\nsecond line");
    assert.equal(parsed.raw, "kept \\as is");
    assert.equal(parsed.count, 1000);
    assert.equal(parsed.ratio, 0.5);
    assert.equal(parsed.on, true);
    assert.deepEqual(parsed.list, [1, 2, 3]);
    assert.deepEqual(parsed.inline, { a: "x", b: { c: "y" } });
    assert.deepEqual(parsed.server, { "with space": { env: { KEY: "value" } } });
    assert.equal("skipped" in parsed, false, "an array of tables is skipped, with its keys");
  });

  test("a line it cannot read is left out, and the rest of the file still reads", () => {
    const parsed = mod.parseToml(
      ["good = 1", "bad = = 2", "[broken", "lost = true", "[fine]", "kept = 'yes'", "__proto__ = 'no'", "[a.__proto__]", "x = 1"].join("\n"),
    );
    assert.equal(parsed.good, 1);
    assert.equal("bad" in parsed, false);
    assert.equal("lost" in parsed, false, "a key under a table that could not be read does not land in the one before it");
    assert.deepEqual(parsed.fine, { kept: "yes" });
    assert.equal(({} as Record<string, unknown>).x, undefined, "nothing reached the prototype");
  });
});

describe("permission rules", () => {
  const home = "/Users/sam";
  const rule = (pattern: string, effect: "allow" | "deny") => mod.ruleFromPermission(pattern, effect, home);

  test("rules that can be said exactly become Bloks rules", () => {
    assert.deepEqual(rule("Bash(npm run test:*)", "allow"), {
      rule: { effect: "allow", field: "command", op: "starts-with", value: "npm run test" },
      notes: ["Bloks compares the start of the command, so anything added after these words is allowed too."],
    });
    assert.deepEqual((rule("Bash(git status)", "allow") as { rule: unknown }).rule, { effect: "allow", field: "command", op: "equals", value: "git status" });
    assert.deepEqual((rule("Edit(~/projects/**)", "allow") as { rule: unknown }).rule, {
      effect: "allow",
      field: "path",
      op: "starts-with",
      value: "/Users/sam/projects/",
    });
    assert.deepEqual((rule("WebFetch(domain:docs.example.com)", "allow") as { rule: unknown }).rule, {
      effect: "allow",
      field: "url",
      op: "starts-with",
      value: "https://docs.example.com/",
    });
    assert.deepEqual((rule("mcp__github__create_issue", "allow") as { rule: unknown }).rule, {
      effect: "allow",
      field: "tool",
      op: "contains",
      value: "github__create_issue",
    });
    assert.deepEqual((rule("WebSearch", "deny") as { rule: unknown }).rule, { effect: "deny", field: "tool", op: "equals", value: "WebSearch" });
  });

  test("a deny may catch more than it did, never less", () => {
    assert.deepEqual((rule("Bash(rm -rf:*)", "deny") as { rule: unknown }).rule, { effect: "deny", field: "command", op: "contains", value: "rm -rf" });
    assert.deepEqual((rule("Read(./.env)", "deny") as { rule: unknown }).rule, { effect: "deny", field: "path", op: "ends-with", value: "/.env" });
    assert.deepEqual((rule("Read(~/.ssh/**)", "deny") as { rule: unknown }).rule, {
      effect: "deny",
      field: "path",
      op: "starts-with",
      value: "/Users/sam/.ssh/",
    });
    assert.deepEqual((rule("Edit(**/*.pem)", "deny") as { rule: unknown }).rule, { effect: "deny", field: "path", op: "ends-with", value: ".pem" });
  });

  test("an allow that would let agents do more than it did is left out, and says why", () => {
    assert.match((rule("Read(./src/**)", "allow") as { skip: string }).skip, /change files there too/);
    assert.match((rule("Edit(./src/**)", "allow") as { skip: string }).skip, /project folder/);
    assert.match((rule("Bash(git * --force)", "allow") as { skip: string }).skip, /wildcard in the middle/);
    assert.match((rule("AskUserQuestion", "allow") as { skip: string }).skip, /question/);
    assert.match((rule("Task(subagent)", "allow") as { skip: string }).skip, /cannot read that kind/);
  });
});

describe("facts about the person", () => {
  test("template labels, questions and placeholders are left out; a line with a secret is dropped whole", () => {
    assert.deepEqual(
      mod.factsFrom(
        [
          "# About",
          "- **Name:**",
          "- **Pronouns:** they/them",
          "* Works at a small studio",
          "_(What projects are they working on?)_",
          "[add more here]",
          "Do they like long answers?",
          "- token: zx81spectrum128k2026",
          "```",
          "- inside a code block",
          "```",
          "- Works at a small studio",
          `- ${"x".repeat(250)}`,
        ].join("\n"),
      ),
      ["Pronouns: they/them", "Works at a small studio"],
    );
  });
});

// ── importing, against a workspace held in memory ──────────────────────

interface World {
  deps: ImportDeps;
  agents: Map<string, { id: string; name: string; title: string; description: string; busy: boolean }>;
  memory: Map<string, string>;
  journal: Array<{ botId: string; file: string; before: string | null; after: string }>;
  skills: Array<{ id: string; source: "builtin" | "user"; name: string; description: string; body: string }>;
  mcp: McpEntry[];
  rules: Rule[];
  notes: ProfileNote[];
}

function world(): World {
  let n = 0;
  const w: World = {
    agents: new Map([["nova", { id: "nova", name: "Nova", title: "", description: "Be brief.", busy: false }]]),
    memory: new Map(),
    journal: [],
    skills: [{ id: "code-review", source: "builtin", name: "Code review", description: "", body: "x" }],
    mcp: [],
    rules: [],
    notes: [],
    deps: undefined as unknown as ImportDeps,
  };
  w.deps = {
    agent: (id) => {
      const a = w.agents.get(id);
      return a ? { id: a.id, name: a.name, description: a.description, busy: a.busy } : null;
    },
    createAgent: ({ name, title }) => {
      const id = `made-${++n}`;
      w.agents.set(id, { id, name, title, description: "", busy: false });
      return id;
    },
    setInstructions: (botId, text) => {
      w.agents.get(botId)!.description = text;
    },
    readMemory: (botId, file) => w.memory.get(`${botId}/${file}`) ?? null,
    writeMemory: (botId, file, before, after) => {
      w.journal.push({ botId, file, before, after });
      w.memory.set(`${botId}/${file}`, after);
    },
    skills: () => w.skills.map((s) => ({ id: s.id, source: s.source })),
    installSkill: (input) => {
      w.skills = [...w.skills.filter((s) => s.id !== input.id), { ...input, source: "user" }];
      return input.id;
    },
    mcpServers: () => w.mcp,
    saveMcpServers: (list) => {
      w.mcp = list;
    },
    newId: () => `id-${++n}`,
    rules: () => w.rules,
    addRule: (rule) => {
      const made = { ...rule, id: `rule-${++n}`, createdAt: 0 };
      w.rules.push(made);
      return made;
    },
    notes: () => w.notes,
    suggestNote: (text, by) => {
      const note: ProfileNote = { id: `note-${++n}`, text, state: "suggested", by, at: 0 };
      w.notes.push(note);
      return note;
    },
  };
  return w;
}

/** What the review ticks and suggests, as the window would send it. */
function picksFrom(review: Review, also: (key: string) => boolean = () => false): Pick[] {
  return review.sources.flatMap((s) =>
    s.items
      .filter((i) => i.picked || also(i.key))
      .map((i) => ({ key: i.key, digest: i.digest, to: i.suggested.to, ...(i.suggested.botId ? { botId: i.suggested.botId } : {}) })),
  );
}

describe("importing", () => {
  test("only ticked items are written, each where it belongs, and nothing is attached or switched on", () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    const scan = mod.detectSetup(home);
    const review = mod.reviewOf(scan, record, w.deps);

    assert.equal(review.fresh, scan.sources.flatMap((s) => s.items).length);
    const rules = review.sources.flatMap((s) => s.items).filter((i) => i.kind === "rule");
    assert.ok(rules.length > 0 && rules.every((i) => !i.picked), "rules wait for the person to tick them");

    const picks = picksFrom(review, (key) => key === "claude:rule:deny:Bash(rm -rf:*)");
    const outcome = mod.applyImport(scan, picks, w.deps, record);
    assert.deepEqual(outcome.results.filter((r) => !r.ok), []);
    assert.equal(outcome.results.length, picks.length);

    // one new agent for each tool that had instructions or memory
    assert.equal(outcome.created.length, 4);
    const claw = [...w.agents.values()].find((a) => a.name === "Claw")!;
    assert.equal(claw.title, "Brought over from OpenClaw");
    assert.match(claw.description, /Be direct\. Have opinions\.[\s\S]*Name:\*\* Claw/);
    assert.equal(w.agents.get("nova")!.description, "Be brief.", "an agent nobody chose is not touched");

    // memory goes through the journal, as a block that says where it came from
    const memory = w.memory.get(`${claw.id}/MEMORY.md`)!;
    assert.match(memory, /^## From OpenClaw: MEMORY\.md\n\n# Memory\n\n- The deploy runs on Fridays\.\n$/);
    assert.equal(w.memory.get(`${claw.id}/memory/2026-01-02.md`), "Talked about the launch plan.\n");
    assert.equal(w.journal.length, 3, "OpenClaw's two files and Hermes' one");

    // skills land in the library and no agent has them
    assert.deepEqual(w.skills.filter((s) => s.source === "user").map((s) => s.id).sort(), ["arxiv", "release-notes", "weather"]);
    assert.equal(w.skills.find((s) => s.id === "weather")!.body.includes("openclaw-weather-key"), false);

    // servers are registered with names to fill in, on no agent
    assert.deepEqual(w.mcp.map((s) => s.name), ["github", "linear", "docs", "web search", "files"]);
    assert.deepEqual(w.mcp[0].env, { GITHUB_PERSONAL_ACCESS_TOKEN: "" });

    // the one rule that was ticked, and the facts as suggestions
    assert.deepEqual(w.rules.map((r) => [r.effect, r.field, r.op, r.value, r.enabled]), [["deny", "command", "contains", "rm -rf", true]]);
    assert.deepEqual(w.notes.map((n) => [n.text, n.state, n.by.name]), [
      ["What to call them: Sam", "suggested", "your OpenClaw setup"],
      ["Timezone: America/Toronto", "suggested", "your OpenClaw setup"],
      ["Prefers short answers", "suggested", "your OpenClaw setup"],
      ["Works in product design", "suggested", "your Hermes setup"],
      ["Likes tables over prose", "suggested", "your Hermes setup"],
    ]);

    const everything = JSON.stringify(w);
    for (const secret of SECRETS) assert.equal(everything.includes(secret), false, `${secret} was imported`);
  });

  test("importing again updates what the first import added instead of adding it twice", () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    mod.applyImport(mod.detectSetup(home), picksFrom(mod.reviewOf(mod.detectSetup(home), record, w.deps)), w.deps, record);
    const agents = w.agents.size;
    const counts = () => [w.agents.size, w.skills.length, w.mcp.length, w.notes.length, w.journal.length];
    const first = counts();

    // the same files again: everything is already there
    const again = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    assert.equal(again.fresh, 5, "only Claude Code's five rules, never ticked, are still new");
    const repeat = mod.applyImport(mod.detectSetup(home), picksFrom(again, () => true).filter((p) => !p.key.includes(":rule:")), w.deps, record);
    assert.ok(repeat.results.every((r) => r.ok && r.did === "unchanged"), JSON.stringify(repeat.results));
    assert.deepEqual(counts(), first);

    // a changed file replaces its own earlier text, in the same agent
    write(home, ".claude/CLAUDE.md", "# How I work\n\nUse bun now.\n");
    write(home, ".openclaw/workspace/MEMORY.md", "# Memory\n\n- The deploy moved to Thursdays.\n");
    const changed = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const claudeMd = changed.sources[0].items[0];
    assert.equal(claudeMd.status, "changed");
    assert.notEqual(claudeMd.suggested.botId, "new", "it goes back where it went last time");
    const update = mod.applyImport(
      mod.detectSetup(home),
      picksFrom(changed).filter((p) => p.key === "claude:instructions:CLAUDE.md" || p.key === "openclaw:memory:MEMORY.md"),
      w.deps,
      record,
    );
    assert.deepEqual(update.results.map((r) => r.did), ["updated", "updated"]);
    assert.equal(w.agents.size, agents, "no new agent the second time");
    const claudeAgent = w.agents.get(claudeMd.suggested.botId!)!;
    assert.equal(claudeAgent.description, "# How I work\n\nUse bun now.");
    const claw = [...w.agents.values()].find((a) => a.name === "Claw")!;
    const memory = w.memory.get(`${claw.id}/MEMORY.md`)!;
    assert.match(memory, /Thursdays/);
    assert.equal(memory.includes("Fridays"), false);
    assert.equal(memory.match(/## From OpenClaw/g)!.length, 1);
  });

  test("a file that changed after the review is refused rather than imported unseen", () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    write(home, ".codex/AGENTS.md", "Something nobody looked at.\n");
    const pick = picksFrom(review).filter((p) => p.key === "codex:instructions:AGENTS.md");
    const outcome = mod.applyImport(mod.detectSetup(home), pick, w.deps, record);
    assert.equal(outcome.results[0].ok, false);
    assert.match(outcome.results[0].error!, /changed since you looked/);
    assert.equal(w.agents.size, 1, "and nothing was made for it");
  });

  test("a library skill by the same name is somebody's, and is not written over", () => {
    const home = fixtureHome();
    const w = world();
    w.skills.push({ id: "weather", source: "user", name: "My weather", description: "", body: "mine" });
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    mod.applyImport(mod.detectSetup(home), picksFrom(review).filter((p) => p.key === "openclaw:skill:weather"), w.deps, record);
    assert.equal(w.skills.find((s) => s.id === "weather")!.body, "mine");
    assert.match(w.skills.find((s) => s.id === "weather-openclaw")!.body, /Use the weather tool/);
  });

  test("what the person filled in for a server survives a second import", () => {
    const home = fixtureHome();
    const w = world();
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    const only = (review: Review) => picksFrom(review).filter((p) => p.key === "claude:mcp:github");
    mod.applyImport(mod.detectSetup(home), only(mod.reviewOf(mod.detectSetup(home), record, w.deps)), w.deps, record);
    w.mcp[0].env = { GITHUB_PERSONAL_ACCESS_TOKEN: "filled-in-by-the-person" };

    const config = JSON.parse(`${JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--read-only"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "x" } } } })}`);
    write(home, ".claude.json", JSON.stringify(config));
    const outcome = mod.applyImport(mod.detectSetup(home), only(mod.reviewOf(mod.detectSetup(home), record, w.deps)), w.deps, record);
    assert.equal(outcome.results[0].did, "updated");
    assert.equal(w.mcp.length, 1);
    assert.deepEqual(w.mcp[0].args, ["-y", "@modelcontextprotocol/server-github", "--read-only"]);
    assert.deepEqual(w.mcp[0].env, { GITHUB_PERSONAL_ACCESS_TOKEN: "filled-in-by-the-person" });
  });

  test("instructions that would not fit, a busy agent, and a full server list each say why", () => {
    const home = fixtureHome();
    const w = world();
    w.agents.get("nova")!.description = "y".repeat(3_990);
    w.agents.set("busy", { id: "busy", name: "Rex", title: "", description: "", busy: true });
    w.mcp = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, name: `server ${i}`, transport: "stdio" as const, command: "x" }));
    const record = new mod.ImportRecord(join(scratch, `record-${++homes}.json`));
    const review = mod.reviewOf(mod.detectSetup(home), record, w.deps);
    const by = new Map(review.sources.flatMap((s) => s.items).map((i) => [i.key, i]));
    const pick = (key: string, to: Pick["to"], botId?: string): Pick => ({ key, digest: by.get(key)!.digest, to, ...(botId ? { botId } : {}) });
    const outcome = mod.applyImport(
      mod.detectSetup(home),
      [
        pick("codex:instructions:AGENTS.md", "brief", "nova"),
        pick("openclaw:memory:MEMORY.md", "memory", "busy"),
        pick("claude:mcp:github", "mcp"),
        pick("claude:skill:release-notes", "brief", "nova"),
        pick("codex:instructions:AGENTS.md", "brief"),
      ],
      w.deps,
      record,
    );
    const error = (key: string) => outcome.results.find((r) => r.key === key)?.error ?? "";
    assert.match(error("codex:instructions:AGENTS.md"), /would pass 4,000 characters\. Send this to its memory instead/);
    assert.match(error("openclaw:memory:MEMORY.md"), /Rex is working right now/);
    assert.match(error("claude:mcp:github"), /holds 16 MCP servers/);
    assert.match(error("claude:skill:release-notes"), /not somewhere this can go/);
    assert.equal(outcome.results.length, 4, "the same item twice is one pick");
    assert.equal(w.agents.get("nova")!.description.length, 3_990);
  });
});
