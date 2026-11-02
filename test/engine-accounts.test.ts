// More than one sign-in for an engine (GitHub 465): which account a turn
// starts on, what an added account's folder gets, and what a lane does
// with a session from another account. No CLI and no real account here;
// engine-accounts-turns.test.ts drives the real server with fake engines.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

// Store paths are fixed when config loads: a home of this test's own.
const fixtureHome = mkdtempSync(join(tmpdir(), "bloks-accounts-"));
const previousHome = process.env.HOME;
const previousData = process.env.BLOKS_DATA_DIR;
process.env.HOME = fixtureHome;
delete process.env.BLOKS_DATA_DIR;
const { Store } = await import("../server/store.ts");
const { turnEnvironment } = await import("../server/drivers/claude.ts");
const { leftOutBecause } = await import("../server/backup.ts");
const { freshTurnText } = await import("../server/turn-context.ts");
const { Cooldowns } = await import("../server/failover.ts");
const { usageReport, UsageStore } = await import("../server/usage.ts");
const {
  ACCOUNT_ENGINES,
  EngineAccounts,
  MAIN_ACCOUNT,
  MAX_ACCOUNTS,
  checkLabel,
  linkSetup,
  mainFolder,
  planBlockedUntil,
  signInCommand,
  takesAccounts,
} = await import("../server/engine-accounts.ts");
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousData !== undefined) process.env.BLOKS_DATA_DIR = previousData;
  rmSync(fixtureHome, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 1, 12);
const MINUTE = 60_000;
const none = () => null;
const fresh = () => {
  const root = mkdtempSync(join(fixtureHome, "accounts-"));
  return { root, accounts: new EngineAccounts({ file: join(root, "engine-accounts.json"), root: join(root, "engine-accounts") }) };
};
const spentPlan = (resetsAt: number | null, at = NOW) => ({ windows: [{ id: "five_hour", minutes: 300, used: 1, resetsAt }], plan: null, at });

describe("the list of accounts", () => {
  test("only Claude Code and Codex take accounts, each with its own folder variable", () => {
    assert.equal(takesAccounts("claudeAgent"), true);
    assert.equal(takesAccounts("codex"), true);
    for (const other of ["geminiCli", "openai", "boxAgent", "", undefined]) assert.equal(takesAccounts(other), false);
    assert.equal(ACCOUNT_ENGINES.claudeAgent.env, "CLAUDE_CONFIG_DIR");
    assert.equal(ACCOUNT_ENGINES.codex.env, "CODEX_HOME");
    assert.equal(mainFolder("claudeAgent", {}, "/home/p"), "/home/p/.claude");
    assert.equal(mainFolder("codex", { CODEX_HOME: "/elsewhere" }, "/home/p"), "/elsewhere");
    // set but empty is not set
    assert.equal(mainFolder("claudeAgent", { CLAUDE_CONFIG_DIR: " " }, "/home/p"), "/home/p/.claude");
  });

  test("an added account gets a private folder, survives a reload, and goes whole when removed", () => {
    const { root, accounts } = fresh();
    const work = accounts.add("claude", "Work", NOW);
    assert.match(work.id, /^[a-f0-9]{12}$/);
    const dir = accounts.dir(work.id);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(accounts.order("claude"), [MAIN_ACCOUNT, work.id]);
    assert.equal(accounts.has("claude"), true);
    assert.equal(accounts.has("codex"), false);
    assert.equal(statSync(join(root, "engine-accounts.json")).mode & 0o777, 0o600);
    // the file holds names and ids, nothing about a sign-in
    const saved = JSON.parse(readFileSync(join(root, "engine-accounts.json"), "utf8"));
    assert.deepEqual(Object.keys(saved.accounts[0]).sort(), ["addedAt", "id", "instanceId", "label"]);
    const again = new EngineAccounts({ file: join(root, "engine-accounts.json"), root: join(root, "engine-accounts") });
    assert.equal(again.get(work.id)?.label, "Work");
    writeFileSync(join(dir, "auth.json"), "{}");
    accounts.choose("claude", work.id);
    accounts.remove(work.id);
    assert.equal(existsSync(dir), false, "the folder, sign-in and all, went with it");
    assert.equal(accounts.current("claude"), MAIN_ACCOUNT, "the account in use went back to the main sign-in");
    assert.equal(accounts.has("claude"), false);
  });

  test("names are checked, and an engine holds a bounded number of accounts", () => {
    assert.deepEqual(checkLabel("  Work \n laptop "), { label: "Work laptop" });
    assert.ok("error" in checkLabel(""));
    assert.ok("error" in checkLabel("   "));
    assert.ok("error" in checkLabel(42));
    assert.ok("error" in checkLabel("x".repeat(41)));
    assert.deepEqual(checkLabel("a\u0007b"), { label: "ab" });
    const { accounts } = fresh();
    for (let i = 0; i < MAX_ACCOUNTS; i++) accounts.add("codex", `Account ${i + 2}`);
    assert.throws(() => accounts.add("codex", "One more"), (e: Error & { status?: number }) => e.status === 409);
    // another engine has its own allowance
    assert.ok(accounts.add("claude", "Work"));
  });

  test("a hand-edited file keeps only whole accounts, and an account in use that is gone is the main sign-in", () => {
    const root = mkdtempSync(join(fixtureHome, "edited-"));
    const file = join(root, "engine-accounts.json");
    writeFileSync(file, JSON.stringify({
      accounts: [{ id: "aaaaaaaaaaaa", instanceId: "claude", label: "Kept" }, { id: "../escape", instanceId: "claude", label: "Bad" }, { id: "bbbbbbbbbbbb", label: "No engine" }],
      current: { claude: "cccccccccccc", codex: "aaaaaaaaaaaa" },
    }));
    const accounts = new EngineAccounts({ file, root: join(root, "engine-accounts") });
    assert.deepEqual(accounts.order("claude"), [MAIN_ACCOUNT, "aaaaaaaaaaaa"]);
    assert.equal(accounts.current("claude"), MAIN_ACCOUNT);
    assert.equal(accounts.current("codex"), MAIN_ACCOUNT, "an account is only ever in use under its own engine");
  });
});

describe("which account a turn starts on", () => {
  test("an engine with no added account is always its own sign-in, whatever its plan says", () => {
    const { accounts } = fresh();
    const pick = accounts.pick("claude", () => spentPlan(NOW + 60 * MINUTE), NOW);
    assert.deepEqual(pick, { id: MAIN_ACCOUNT, label: "the main sign-in", dir: null, eligible: true });
  });

  test("an account out on a turn is left for the next, which stays in use after the first resets", () => {
    const { accounts } = fresh();
    const work = accounts.add("claude", "Work");
    assert.equal(accounts.pick("claude", none, NOW).id, MAIN_ACCOUNT);
    const rest = accounts.markOut("claude", MAIN_ACCOUNT, "limit", `usage limit reached|${Math.floor((NOW + 60 * MINUTE) / 1000)}`, NOW);
    assert.equal(rest.until, NOW + 60 * MINUTE);
    const moved = accounts.pick("claude", none, NOW + MINUTE);
    assert.equal(moved.id, work.id);
    assert.equal(moved.dir, accounts.dir(work.id));
    assert.equal(moved.eligible, true);
    assert.equal(moved.from?.id, MAIN_ACCOUNT);
    assert.equal(moved.from?.blocked.why, "rest");
    assert.equal(accounts.current("claude"), work.id);
    // the main sign-in is back, and nothing moves for it
    const later = accounts.pick("claude", none, NOW + 2 * 60 * MINUTE);
    assert.equal(later.id, work.id);
    assert.equal(later.from, undefined);
  });

  test("a plan the engine said is at its limit is left before any turn fails on it", () => {
    const { accounts } = fresh();
    const work = accounts.add("codex", "Work");
    const plans: Record<string, ReturnType<typeof spentPlan> | null> = { [MAIN_ACCOUNT]: spentPlan(NOW + 30 * MINUTE) };
    const pick = accounts.pick("codex", (id) => plans[id] ?? null, NOW);
    assert.equal(pick.id, work.id);
    assert.equal(pick.from?.blocked.why, "plan");
    assert.equal(pick.from?.blocked.until, NOW + 30 * MINUTE);
  });

  test("with none able, the turn goes to the account back soonest, and the one in use stays", () => {
    const { accounts } = fresh();
    const a = accounts.add("claude", "A");
    const b = accounts.add("claude", "B");
    accounts.markOut("claude", MAIN_ACCOUNT, "limit", "usage limit, try again in 3h", NOW);
    accounts.markOut("claude", a.id, "limit", "usage limit, try again in 2h", NOW);
    accounts.markOut("claude", b.id, "limit", "usage limit, try again in 1h", NOW);
    const pick = accounts.pick("claude", none, NOW + MINUTE);
    assert.equal(pick.eligible, false);
    assert.equal(pick.id, b.id);
    assert.equal(pick.backAt, NOW + 60 * MINUTE);
    assert.equal(accounts.current("claude"), MAIN_ACCOUNT, "a turn that nothing can take moves nothing");
    assert.equal(accounts.anotherEligible("claude", b.id, none, NOW + MINUTE), false);
    assert.equal(accounts.firstBack("claude", none, NOW + MINUTE), NOW + 60 * MINUTE);
  });

  test("the next account is tried in order from the one in use, round to the start", () => {
    const { accounts } = fresh();
    const a = accounts.add("claude", "A");
    const b = accounts.add("claude", "B");
    accounts.choose("claude", b.id);
    accounts.markOut("claude", b.id, "limit", "usage limit reached", NOW);
    assert.equal(accounts.pick("claude", none, NOW).id, MAIN_ACCOUNT);
    accounts.markOut("claude", MAIN_ACCOUNT, "limit", "usage limit reached", NOW);
    assert.equal(accounts.pick("claude", none, NOW).id, a.id);
  });

  test("a sign-in that lapsed is left, and signing in again brings it back", () => {
    const { accounts } = fresh();
    const work = accounts.add("claude", "Work");
    accounts.choose("claude", work.id);
    accounts.noteSignedIn("claude", work.id, false);
    assert.equal(accounts.pick("claude", none, NOW).id, MAIN_ACCOUNT);
    accounts.choose("claude", work.id);
    accounts.markOut("claude", work.id, "signedOut", "Please run /login", NOW);
    assert.equal(accounts.blocked("claude", work.id, none, NOW)?.why, "signedOut");
    accounts.noteSignedIn("claude", work.id, true, NOW);
    assert.equal(accounts.blocked("claude", work.id, none, NOW), null, "the rest for a lapsed sign-in ended with the new one");
    // the main sign-in's own status is the engine's to say, not this list's
    accounts.noteSignedIn("claude", MAIN_ACCOUNT, false);
    assert.equal(accounts.blocked("claude", MAIN_ACCOUNT, none, NOW), null);
  });

  test("an answer begun after the account ran out ends its rest; one already under way does not", () => {
    const { accounts } = fresh();
    accounts.add("claude", "Work");
    accounts.markOut("claude", MAIN_ACCOUNT, "limit", "usage limit reached", NOW);
    accounts.answered("claude", MAIN_ACCOUNT, NOW - MINUTE, NOW);
    assert.ok(accounts.restOf("claude", MAIN_ACCOUNT, NOW));
    accounts.answered("claude", MAIN_ACCOUNT, NOW + MINUTE, NOW + MINUTE);
    assert.equal(accounts.restOf("claude", MAIN_ACCOUNT, NOW + 2 * MINUTE), undefined);
  });

  test("a plan is at its limit only while a spent window has not reset", () => {
    assert.equal(planBlockedUntil(null, NOW), null);
    assert.equal(planBlockedUntil(spentPlan(NOW + MINUTE), NOW), NOW + MINUTE);
    assert.equal(planBlockedUntil(spentPlan(NOW - MINUTE), NOW), null, "a reset that passed says nothing now");
    assert.equal(planBlockedUntil({ windows: [{ id: "w", minutes: 300, used: 0.95, resetsAt: NOW + MINUTE }], plan: null, at: NOW }, NOW), null);
    assert.equal(planBlockedUntil({ windows: [{ id: "w", minutes: 300, used: 0.5, resetsAt: NOW + MINUTE, status: "rejected" }], plan: null, at: NOW }, NOW), NOW + MINUTE);
    // no reset named: believed for half an hour after it was heard
    assert.equal(planBlockedUntil(spentPlan(null, NOW), NOW + 10 * MINUTE), NOW + 30 * MINUTE);
    assert.equal(planBlockedUntil(spentPlan(null, NOW), NOW + 31 * MINUTE), null);
  });

  test("an engine resting on every account rests until the first of them is back", () => {
    const c = new Cooldowns();
    const rest = c.rest("claude", "limit", "usage limit reached", NOW, NOW + 90 * MINUTE);
    assert.equal(rest.until, NOW + 90 * MINUTE);
    // never longer than any rest may be, and a time already past is ignored
    assert.equal(c.rest("codex", "limit", "", NOW, NOW + 30 * 60 * MINUTE).until, NOW + 12 * 60 * MINUTE);
    assert.equal(c.rest("other", "limit", "usage limit, try again in 20m", NOW, NOW - 1).until, NOW + 20 * MINUTE);
  });
});

describe("an added account's folder and sign-in", () => {
  test("the person's setup is linked in; the sign-in and the sessions never are", () => {
    const main = mkdtempSync(join(fixtureHome, "main-claude-"));
    for (const name of ["settings.json", "CLAUDE.md", ".credentials.json", ".claude.json", "history.jsonl"]) writeFileSync(join(main, name), "{}");
    for (const name of ["skills", "plugins", "projects", "sessions"]) mkdirSync(join(main, name));
    const dir = join(fixtureHome, "added-claude", "abcdefabcdef");
    const linked = linkSetup("claudeAgent", dir, main);
    assert.deepEqual(linked.sort(), ["CLAUDE.md", "plugins", "settings.json", "skills"]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const name of linked) assert.equal(readlinkSync(join(dir, name)), join(main, name));
    for (const name of [".credentials.json", ".claude.json", "history.jsonl", "projects", "sessions"]) {
      assert.equal(existsSync(join(dir, name)), false, `${name} must stay the main sign-in's`);
    }
    // again: nothing new, and what the engine wrote itself is left alone
    rmSync(join(dir, "CLAUDE.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "its own");
    assert.deepEqual(linkSetup("claudeAgent", dir, main), []);
    assert.equal(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink(), false);
  });

  test("Codex shares its config and instructions, never auth.json or its sessions", () => {
    const main = mkdtempSync(join(fixtureHome, "main-codex-"));
    for (const name of ["config.toml", "AGENTS.md", "auth.json"]) writeFileSync(join(main, name), "x");
    mkdirSync(join(main, "sessions"));
    const dir = join(fixtureHome, "added-codex", "abcdefabcdef");
    assert.deepEqual(linkSetup("codex", dir, main).sort(), ["AGENTS.md", "config.toml"]);
    assert.equal(existsSync(join(dir, "auth.json")), false);
    assert.equal(existsSync(join(dir, "sessions")), false);
    // an engine that takes no accounts gets nothing
    assert.deepEqual(linkSetup("geminiCli", join(fixtureHome, "nothing"), main), []);
  });

  test("the sign-in command is the engine's own login, pointed at the account's folder", () => {
    assert.equal(signInCommand("claudeAgent", "claude", "/data/engine-accounts/abc", "darwin"), "CLAUDE_CONFIG_DIR='/data/engine-accounts/abc' claude");
    assert.equal(signInCommand("codex", "codex", "/data/engine-accounts/abc", "linux"), "CODEX_HOME='/data/engine-accounts/abc' codex login");
    // a folder or a CLI path with spaces or a quote stays one word
    assert.equal(
      signInCommand("codex", "/Users/p/my tools/codex", "/Users/p/Bloks Data/it's", "darwin"),
      "CODEX_HOME='/Users/p/Bloks Data/it'\\''s' '/Users/p/my tools/codex' login",
    );
    assert.equal(signInCommand("claudeAgent", "claude", "C:\\Bloks\\a", "win32"), '$env:CLAUDE_CONFIG_DIR="C:\\Bloks\\a"; claude');
    assert.equal(signInCommand("geminiCli", "gemini", "/x"), null);
  });

  test("a turn on an added account points Claude Code at its folder, and nothing can point it back", () => {
    const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/p/.claude", CLAUDE_CODE_OAUTH_TOKEN: "main-token", ANTHROPIC_AUTH_TOKEN: "main-auth" };
    const env = turnEnvironment(base, { env: { CLAUDE_CONFIG_DIR: "/somewhere/else", BLOKS_TOKEN: "t" }, account: { id: "abcdefabcdef", dir: "/data/engine-accounts/abcdefabcdef" } });
    assert.equal(env.CLAUDE_CONFIG_DIR, "/data/engine-accounts/abcdefabcdef");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the main sign-in's token would run it on the account it left");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.BLOKS_TOKEN, "t");
    // the main sign-in is the machine's, as it always was
    const own = turnEnvironment(base, {});
    assert.equal(own.CLAUDE_CONFIG_DIR, "/home/p/.claude");
    assert.equal(own.CLAUDE_CODE_OAUTH_TOKEN, "main-token");
  });

  test("backups and workspace moves leave the accounts' folders behind", () => {
    assert.match(leftOutBecause("engine-accounts", true, false) ?? "", /sign-ins/);
    assert.equal(leftOutBecause("engine-accounts.json", false, false), null, "the list of names is kept");
  });
});

describe("a lane on another account", () => {
  const by = { instanceId: "claude", model: "claude-sonnet-5" };
  test("the session of that engine is left, told the conversation so far; another engine's stays", () => {
    const store = new Store(() => by);
    const bot = store.createBot({ name: "Accounts" });
    const lane = bot.tasks[0];
    store.setResumeCursor(lane.id, "claude", "session-main");
    store.setResumeCursor(lane.id, "codex", "thread-codex");
    store.markTaskDispatched(bot.id, lane.id, "claude");
    store.noteReading(lane.id, by, { used: 1000, window: 200_000 });
    // the same account: nothing moves
    assert.equal(store.moveTaskAccount(lane.id, "claude", MAIN_ACCOUNT, MAIN_ACCOUNT), false);
    assert.equal(lane.resumeCursors.claude, "session-main");
    // another account: the session goes, and the next turn is told the story
    assert.equal(store.moveTaskAccount(lane.id, "claude", "abcdefabcdef", MAIN_ACCOUNT), true);
    assert.equal(lane.resumeCursors.claude, undefined);
    assert.equal(lane.resumeCursors.codex, "thread-codex");
    assert.equal(lane.lastInstanceId, "");
    assert.equal(lane.reading, undefined);
    assert.deepEqual(lane.sessionAccounts, { claude: "abcdefabcdef" });
    // a session made on it is that account's; back to the main sign-in
    // leaves it in turn
    store.setResumeCursor(lane.id, "claude", "session-work");
    assert.equal(store.moveTaskAccount(lane.id, "claude", "abcdefabcdef", MAIN_ACCOUNT), false);
    assert.equal(store.moveTaskAccount(lane.id, "claude", MAIN_ACCOUNT, MAIN_ACCOUNT), true);
    assert.equal(lane.sessionAccounts, undefined);
    // with no session to leave, the move is only noted
    assert.equal(store.moveTaskAccount(lane.id, "claude", "abcdefabcdef", MAIN_ACCOUNT), false);
    assert.deepEqual(lane.sessionAccounts, { claude: "abcdefabcdef" });
  });

  test("the new session hears why it is new, and never that it is the same session", () => {
    const said = freshTurnText([{ role: "user", text: "remember heron" }, { role: "assistant", text: "Noted." }], "what bird?", { why: "account" });
    assert.match(said, /new session, on another account of the same engine and the same model/);
    assert.match(said, /remember heron/);
    assert.match(said, /--- the new message ---\n\nwhat bird\?$/);
  });
});

describe("usage by account", () => {
  test("turns keep the account they ran on, and the report splits an engine by it", () => {
    const store = new UsageStore(join(mkdtempSync(join(fixtureHome, "usage-")), "usage.json"));
    const today = new Date();
    store.noteTokens("bot", "claude", 100, 10);
    store.recordTurn("bot", "claude", 0.5, today, true, false, undefined, true, MAIN_ACCOUNT);
    store.noteTokens("bot", "claude", 200, 20);
    store.recordTurn("bot", "claude", 0.25, today, true, false, undefined, true, "abcdefabcdef");
    store.noteTokens("bot", "codex", 50, 5);
    store.recordTurn("bot", "codex", null, today, true);
    const report = usageReport(store.since(30), "30d", {}, today);
    const engine = report.byEngine.find((r) => r.id === "claude")!;
    assert.equal(engine.turns, 2, "the engine's own row is the sum of its accounts");
    assert.equal(engine.input, 300);
    assert.deepEqual(report.byAccount.map((r) => [r.id, r.turns, r.input]).sort(), [["claude/abcdefabcdef", 1, 200], ["claude/main", 1, 100]]);
    assert.ok(!report.byAccount.some((r) => r.id.startsWith("codex")), "an engine with one account has no account rows");
    store.flush();
  });
});
