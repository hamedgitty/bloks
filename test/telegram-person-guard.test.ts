import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPersonClaudeStatus, checkPersonCodexConfig, checkPersonCodexThread, checkPersonCodexTools, makePersonCodexHome, personReplyText, readPersonClaudeInstructions } from "../server/person-turn.ts";
import { MAX_PERSON_PROJECT_BYTES } from "../server/limits.ts";
import { knockTelegram, migrateTelegramPeople, telegramSender, telegramSenderCurrent } from "../server/telegram-people.ts";
import type { AgentTelegram } from "../server/telegram-bots.ts";
import { telegramStatus } from "../server/telegram-bots.ts";

test("a person reply has only text and never truncates", () => {
  assert.equal(personReplyText({ text: "Hello Lee" }), "Hello Lee");
  assert.equal(personReplyText({ text: "x".repeat(4096) }).length, 4096);
  for (const field of ["chat_id", "to", "agent", "file", "parse_mode", "reply_markup"]) assert.throws(() => personReplyText({ text: "Hello", [field]: "elsewhere" }));
  for (const input of [null, [], {}, { text: "" }, { text: 1 }, { text: "x".repeat(4097) }]) assert.throws(() => personReplyText(input));
});

test("a fresh Codex home links the file login, strips standing configuration and cleans only the link", () => {
  const root = mkdtempSync(join(tmpdir(), "bloks-file-login-"));
  const owner = join(root, "owner"); mkdirSync(owner);
  const auth = join(owner, "auth.json"); writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: "synthetic-key" }));
  writeFileSync(join(owner, "AGENTS.md"), "Synthetic owner-global instruction.\n");
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = owner;
  let home: ReturnType<typeof makePersonCodexHome> | undefined;
  try {
    for (const mode of ["auto", "keyring"]) assert.throws(() => makePersonCodexHome({ config: { cli_auth_credentials_store: mode } }, "proxy.js", process.execPath), /held/);
    assert.throws(() => makePersonCodexHome({ config: { cli_auth_credentials_store: "file", model_provider: "custom" } }, "proxy.js", process.execPath), /held/);
    assert.throws(() => makePersonCodexHome({ config: { cli_auth_credentials_store: "file", model_provider: "openai", model_providers: { openai: { base_url: "http://fixture.invalid" } } } }, "proxy.js", process.execPath), /held/);
    assert.throws(() => makePersonCodexHome({ config: { cli_auth_credentials_store: "file" } }, "proxy.js", process.execPath, tmpdir()), /narrower agent folder/);
    home = makePersonCodexHome({ config: { cli_auth_credentials_store: "file" } }, "proxy.js", process.execPath);
    assert.equal(lstatSync(home.path).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(home.path, "auth.json")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(home.path, "auth.json")), auth);
    assert.equal(existsSync(join(home.path, "AGENTS.md")), false);
    writeFileSync(join(home.path, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-refresh" }));
    assert.equal(JSON.parse(readFileSync(auth, "utf8")).OPENAI_API_KEY, "synthetic-refresh");
    const config = readFileSync(home.configFile, "utf8");
    assert.match(config, /sandbox_mode = "read-only"/);
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.match(config, /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(config, /rules|hooks|bloks_connectors/);
    home.close(); home = undefined;
    assert.equal(JSON.parse(readFileSync(auth, "utf8")).OPENAI_API_KEY, "synthetic-refresh");
  } finally {
    home?.close();
    if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude person's project text follows the hidden symlink and is reread without local files or imports", () => {
  const root = mkdtempSync(join(tmpdir(), "bloks-project-instructions-"));
  const project = join(root, "Planning"); mkdirSync(project); mkdirSync(join(project, ".claude")); mkdirSync(join(root, ".claude"));
  try {
    writeFileSync(join(project, "CLAUDE.md"), "ROOT_PROJECT_FACT\n@import.md\n");
    writeFileSync(join(project, "AGENTS.md"), "HIDDEN_PROJECT_FACT\n");
    symlinkSync("../AGENTS.md", join(project, ".claude", "CLAUDE.md"));
    writeFileSync(join(project, "import.md"), "IMPORTED_SECRET_FACT\n");
    writeFileSync(join(project, "CLAUDE.local.md"), "LOCAL_INSTRUCTION_FACT\n");
    writeFileSync(join(root, ".claude", "CLAUDE.md"), "GLOBAL_INSTRUCTION_FACT\n");
    writeFileSync(join(project, ".claude", "settings.json"), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    const first = readPersonClaudeInstructions(project);
    assert.match(first, /Owner's project instructions/);
    assert.match(first, /'the user' means the owner, not the Telegram sender/);
    assert.match(first, /ROOT_PROJECT_FACT/); assert.match(first, /HIDDEN_PROJECT_FACT/);
    assert.match(first, /@import\.md/);
    assert.doesNotMatch(first, /IMPORTED_SECRET_FACT|LOCAL_INSTRUCTION_FACT|GLOBAL_INSTRUCTION_FACT|bypassPermissions/);
    rmSync(join(project, "CLAUDE.md"));
    writeFileSync(join(project, "AGENTS.md"), "NEXT_TURN_PROJECT_FACT\n");
    const second = readPersonClaudeInstructions(project);
    assert.match(second, /NEXT_TURN_PROJECT_FACT/); assert.doesNotMatch(second, /ROOT_PROJECT_FACT|HIDDEN_PROJECT_FACT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude project instructions hold visibly instead of truncating or reading a non-file", () => {
  const root = mkdtempSync(join(tmpdir(), "bloks-project-bound-"));
  try {
    assert.equal(readPersonClaudeInstructions(root), "");
    writeFileSync(join(root, "CLAUDE.md"), "x".repeat(MAX_PERSON_PROJECT_BYTES));
    mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude", "CLAUDE.md"), "y");
    assert.throws(() => readPersonClaudeInstructions(root), /held:.*exceed.*Shorten/s);
    rmSync(join(root, "CLAUDE.md")); mkdirSync(join(root, "CLAUDE.md"));
    assert.throws(() => readPersonClaudeInstructions(root), /held:.*could not be read.*regular text file/s);
    rmSync(join(root, "CLAUDE.md"), { recursive: true }); symlinkSync("missing.md", join(root, "CLAUDE.md"));
    assert.throws(() => readPersonClaudeInstructions(root), /held:.*could not be read/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reported Codex permissions, tools and enabled configuration layers are checked", () => {
  const file = "/fixture/config.toml";
  const answer = { config: { approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "read-only", web_search: "disabled", cli_auth_credentials_store: "file", features: { apps: false, plugins: false }, mcp_servers: { bloks_reply: { default_tools_approval_mode: "approve" } } }, layers: [{ name: { type: "user", file }, config: { approval_policy: "on-request" } }, { name: { type: "system", file: "/fixture/system.toml" }, config: {} }] };
  assert.doesNotThrow(() => checkPersonCodexConfig(answer, file));
  const system = structuredClone(answer); system.layers[1].config = { approval_policy: "never" };
  assert.throws(() => checkPersonCodexConfig(system, file), /held/);
  const profile = structuredClone(answer) as any; profile.config.permissions = { permissive: {} };
  assert.throws(() => checkPersonCodexConfig(profile, file), /held/);
  const thread = { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null };
  assert.doesNotThrow(() => checkPersonCodexThread(thread));
  for (const change of [{ approvalPolicy: "never" }, { approvalsReviewer: "auto_review" }, { sandbox: { type: "workspaceWrite", networkAccess: false } }, { activePermissionProfile: "saved" }]) assert.throws(() => checkPersonCodexThread({ ...thread, ...change }), /held/);
  const tools = { data: [{ name: "bloks_reply", tools: { reply_to_sender: {} } }], nextCursor: null };
  assert.doesNotThrow(() => checkPersonCodexTools(tools));
  assert.throws(() => checkPersonCodexTools({ ...tools, data: [...tools.data, { name: "account", tools: { history: { annotations: { readOnlyHint: true } } } }] }), /held/);
});

test("an empty reported system layer cannot hide a rules folder or a standing file", () => {
  const root = mkdtempSync(join(tmpdir(), "bloks-system-guard-"));
  const file = join(root, "config.toml"), own = join(root, "person.toml");
  const answer = { config: { approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "read-only", web_search: "disabled", cli_auth_credentials_store: "file", features: { apps: false, plugins: false }, mcp_servers: { bloks_reply: { default_tools_approval_mode: "approve" } } }, layers: [{ name: { type: "user", file: own }, config: { approval_policy: "on-request" } }, { name: { type: "system", file }, config: {} }] };
  try {
    assert.doesNotThrow(() => checkPersonCodexConfig(answer, own));
    mkdirSync(join(root, "rules"));
    writeFileSync(join(root, "rules", "default.rules"), 'prefix_rule(pattern=["touch"], decision="allow")\n');
    assert.throws(() => checkPersonCodexConfig(answer, own), /held/);
    rmSync(join(root, "rules"), { recursive: true }); writeFileSync(file, "");
    assert.throws(() => checkPersonCodexConfig(answer, own), /held/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude startup reports default mode and only the expected connected tools", () => {
  const mounted = { mcpServers: [{ name: "bloks", status: "connected", tools: [{ name: "approve" }, { name: "reply_to_sender" }] }] };
  assert.equal(checkPersonClaudeStatus("default", mounted, ["bloks"], ["approve", "reply_to_sender"]), true);
  assert.equal(checkPersonClaudeStatus("default", { mcpServers: [{ name: "bloks", status: "pending" }] }, ["bloks"], []), false);
  assert.throws(() => checkPersonClaudeStatus("bypassPermissions", mounted, ["bloks"], ["approve", "reply_to_sender"]), /held/);
  assert.throws(() => checkPersonClaudeStatus("default", { mcpServers: [...mounted.mcpServers, { name: "inherited", status: "connected" }] }, ["bloks"], []), /held/);
});

test("a knock is bounded and does not change the owner or confer admission", () => {
  const state: AgentTelegram = { token: "fixture", generation: "transport", enabled: true, ownerUserId: 101, ownerChatId: 101 };
  const incoming = { chatId: 202, fromId: 202, fromBot: false, chatType: "private" as const, from: "Lee\nOwner", text: "Hello", updateId: 1, messageId: 10 };
  const first = knockTelegram(state, incoming);
  assert.equal(first.person?.state, "pending");
  assert.equal(first.person?.name, "Lee Owner");
  assert.equal(state.ownerUserId, 101);
  const saved = { ...state, people: { "202": first.person! } };
  assert.equal(knockTelegram(saved, incoming).fresh, false);
  const full = { ...state, admissionFull: true, people: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), { ...first.person!, id: String(i) }])) };
  assert.equal(telegramStatus(full).admissionFull, true);
  full.people["0"].state = "declined";
  assert.equal(telegramStatus(full).admissionFull, false, "a closed knock left a stale full warning");
  for (const bad of [{ fromBot: true }, { fromId: undefined }, { anonymous: true }, { chatType: "group" as const }]) assert.equal(knockTelegram(state, { ...incoming, ...bad }).person, undefined);
  const allowed = { ...first.person!, state: "allowed" as const };
  const granted = { ...state, people: { "202": allowed } };
  const sender = telegramSender("planning", granted, allowed, 10);
  assert.equal(sender.requester.length <= 64, true);
  assert.equal(telegramSenderCurrent(granted, sender), true);
  for (const next of [{ ...granted, generation: "rotated" }, { ...granted, people: { "202": { ...allowed, state: "removed" as const } } }, { ...granted, people: { "202": { ...allowed, grant: "readmitted" } } }]) assert.equal(telegramSenderCurrent(next, sender), false);
});

test("the people upgrade drops both old grants once and keeps notice jobs and a verified owner", () => {
  const before = { version: 1 as const, bots: { planning: { token: "fixture", generation: "old", chatIds: [101, 202, 101], offset: 41, enabled: true, ownerUserId: 101, ownerChatId: 101 } } };
  const migrated = migrateTelegramPeople(before);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.bots!.planning.chatIds, []);
  assert.equal(migrated.bots!.planning.ownerUserId, 101);
  assert.equal(migrated.bots!.planning.offset, 41);
  assert.notEqual(migrated.bots!.planning.generation, "old");
  assert.equal(migrated.bots!.planning.upgradeNotices!.length, 2);
  assert.equal(migrateTelegramPeople(migrated), migrated);
});
