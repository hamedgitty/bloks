// The security checkup: what it says about each setting, the one fix it
// makes itself (file modes), and that only the person at this computer
// can read it or use it. A phone, a paired browser and an agent's turn
// are all turned away, since the report is a map of what reaches the
// person's keys and screen.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { checkup, filePermissions, names, tightenPermissions, type SecurityFacts } from "../server/security.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const agent = (name: string, more: Partial<SecurityFacts["agents"][number]> = {}) => ({
  id: name.toLowerCase(),
  name,
  approvals: "ask",
  browser: false,
  thisMachine: false,
  refusesUnlistedMail: false,
  ...more,
});

const quiet = (): SecurityFacts => ({
  agents: [agent("Ada"), agent("Linus")],
  remote: { enabled: false, relay: false, devices: 0, memberDevices: 0 },
  email: { enabled: false, allowFrom: 0 },
  rooms: [],
  secrets: [],
  files: [{ name: "~/.bloks", path: "/h/.bloks", mode: "0700", want: "0700", open: false }],
  webhooks: 0,
  signedOut: [],
  platform: "darwin",
});

const find = (facts: SecurityFacts, id: string) => checkup(facts).find((f) => f.id === id)!;

describe("what the checkup says", () => {
  test("a quiet workspace is all ok, and says what it looked at", () => {
    const findings = checkup(quiet());
    assert.deepEqual(
      findings.map((f) => f.id).sort(),
      ["browser-computer", "email", "engines", "files", "full-access", "remote", "secrets", "shared-rooms", "webhooks"],
    );
    assert.ok(findings.every((f) => f.level === "ok"), JSON.stringify(findings.filter((f) => f.level !== "ok")));
    assert.ok(findings.every((f) => !f.fix), "nothing to fix offers a fix");
    for (const f of findings) {
      // one sentence of why, in the house style
      assert.match(f.why, /^[A-Z][^.]*[^.\s]\.$/, `${f.id}: ${f.why}`);
      assert.doesNotMatch(f.summary + f.why, /[\u2013\u2014]/);
    }
  });

  test("an agent in full access is risky, named, and offered Auto", () => {
    const facts = quiet();
    facts.agents[1].approvals = "full";
    const f = find(facts, "full-access");
    assert.equal(f.level, "risky");
    assert.equal(f.summary, "Linus runs in full access.");
    assert.deepEqual(f.items, [{ id: "linus", name: "Linus" }]);
    assert.equal(f.fix?.kind, "full-access");
    assert.equal(checkup(facts)[0].id, "full-access", "the risky come first");
  });

  test("pairing on is worth a look, with how many devices reach in", () => {
    const facts = quiet();
    facts.remote = { enabled: true, relay: true, devices: 2, memberDevices: 1 };
    const f = find(facts, "remote");
    assert.equal(f.level, "look");
    assert.match(f.summary, /Pairing is on, through Bloks Cloud too, and 2 devices of yours can reach this Mac\./);
    assert.match(f.summary, /1 more device belongs|1 more device belong/);
    assert.deepEqual(f.fix, { kind: "page", page: "devices", label: "Review devices" });
    assert.match(find(quiet(), "remote").summary, /Pairing is off/);
    assert.match(find({ ...quiet(), platform: "win32" }, "remote").summary, /this PC/);
  });

  test("email open to anyone names the agents that would refuse it", () => {
    const facts = quiet();
    facts.email = { enabled: true, allowFrom: 0 };
    facts.agents[0].refusesUnlistedMail = true;
    const f = find(facts, "email");
    assert.equal(f.level, "look");
    assert.match(f.summary, /^Anyone who has one of your agents' addresses can write to it\. Ada runs on an engine whose tools cannot be switched off, so it refuses mail/);
    assert.deepEqual(f.items?.map((i) => i.name), ["Ada"]);
    assert.equal(f.fix?.kind, "page");
    facts.email.allowFrom = 2;
    assert.equal(find(facts, "email").level, "ok");
    assert.match(find(facts, "email").summary, /Only the 2 addresses and domains you listed/);
    assert.equal(find(quiet(), "email").summary, "Email to your agents is off.");
  });

  test("a shared room is worth a look only when it opens the owner's tools", () => {
    const facts = quiet();
    facts.rooms = [
      { id: "r1", name: "Design", ownerTools: ["your apps", "a browser"] },
      { id: "r2", name: "Book club", ownerTools: [] },
    ];
    const f = find(facts, "shared-rooms");
    assert.equal(f.level, "look");
    assert.equal(f.summary, "Design opens your own tools to the people in it.");
    assert.deepEqual(f.items, [{ id: "r1", name: "Design", detail: "your apps, a browser" }]);
    facts.rooms = [facts.rooms[1]];
    assert.equal(find(facts, "shared-rooms").level, "ok");
    assert.match(find(facts, "shared-rooms").summary, /1 shared room keeps your own tools to yourself/);
  });

  test("a browser or the use of this computer is worth a look, said per agent", () => {
    const facts = quiet();
    facts.agents[0].browser = true;
    facts.agents[1].browser = true;
    facts.agents[1].thisMachine = true;
    const f = find(facts, "browser-computer");
    assert.equal(f.level, "look");
    assert.deepEqual(f.items?.map((i) => i.detail), ["a browser", "a browser and this Mac"]);
  });

  test("saved secrets are listed by name, and webhooks and signed out engines counted", () => {
    const facts = quiet();
    facts.secrets = ["GITHUB_TOKEN", "STRIPE_KEY"];
    facts.webhooks = 3;
    facts.signedOut = [{ id: "codex", name: "Codex", agents: 2 }];
    assert.equal(find(facts, "secrets").summary, "2 secrets are saved for your agents.");
    assert.deepEqual(find(facts, "secrets").items?.map((i) => i.name), ["GITHUB_TOKEN", "STRIPE_KEY"]);
    assert.equal(find(facts, "webhooks").summary, "3 webhooks are on.");
    assert.deepEqual(find(facts, "webhooks").fix, { kind: "automations", tab: "webhooks", label: "Review webhooks" });
    assert.equal(find(facts, "engines").summary, "Codex is signed out.");
    assert.equal(find(facts, "engines").items?.[0].detail, "used by 2 agents");
    for (const id of ["secrets", "webhooks", "engines"]) assert.equal(find(facts, id).level, "look");
  });

  test("a key file others can read is risky; no modes to read, no finding", () => {
    const facts = quiet();
    facts.files = [
      { name: "~/.bloks", path: "/h/.bloks", mode: "0700", want: "0700", open: false },
      { name: "~/.bloks/config.json", path: "/h/.bloks/config.json", mode: "0644", want: "0600", open: true },
    ];
    const f = find(facts, "files");
    assert.equal(f.level, "risky");
    assert.equal(f.summary, "~/.bloks/config.json is open to other accounts on this Mac.");
    assert.deepEqual(f.items, [{ id: "/h/.bloks/config.json", name: "~/.bloks/config.json", detail: "0644, should be 0600" }]);
    assert.equal(f.fix?.kind, "permissions");
    assert.equal(checkup({ ...quiet(), files: null }).some((x) => x.id === "files"), false);
  });

  test("automatic backups off are worth a look; a build without backups says nothing", () => {
    assert.equal(checkup(quiet()).some((f) => f.id === "backups"), false);
    const off = find({ ...quiet(), backups: { auto: false } }, "backups");
    assert.equal(off.level, "look");
    assert.equal(off.summary, "Automatic backups are off.");
    assert.deepEqual(off.fix, { kind: "page", page: "backups", label: "Turn on backups" });
    const on = find({ ...quiet(), backups: { auto: true } }, "backups");
    assert.equal(on.level, "ok");
    assert.equal(on.fix, undefined);
  });

  test("names read as a list, and a long one is cut short", () => {
    assert.equal(names(["Ada"]), "Ada");
    assert.equal(names(["Ada", "Linus"]), "Ada and Linus");
    assert.equal(names(["Ada", "Linus", "Kat"]), "Ada, Linus and Kat");
    assert.equal(names(["Ada", "Linus", "Kat", "Grace", "Alan"]), "Ada, Linus and 3 more");
  });
});

describe("file modes", () => {
  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

  test("the data folder and its key files go back to 0700 and 0600, and a link is left alone", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bloks-modes-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const data = join(root, ".bloks");
    mkdirSync(join(data, "identities"), { recursive: true });
    chmodSync(data, 0o755);
    chmodSync(join(data, "identities"), 0o755);
    writeFileSync(join(data, "config.json"), "{}", { mode: 0o644 });
    writeFileSync(join(data, "people.json"), "[]", { mode: 0o600 });
    writeFileSync(join(data, "identities", "ada.pem"), "key", { mode: 0o644 });
    // a link inside the folder to somebody else's file: changing its mode
    // would change theirs
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, "{}", { mode: 0o644 });
    symlinkSync(elsewhere, join(data, "webhooks.json"));
    chmodSync(elsewhere, 0o644);

    const before = filePermissions(data);
    assert.deepEqual(
      before.filter((c) => c.open).map((c) => [c.name, c.mode]),
      [
        ["~/.bloks", "0755"],
        ["~/.bloks/config.json", "0644"],
        ["~/.bloks/identities", "0755"],
        ["~/.bloks/identities/ada.pem", "0644"],
      ],
    );
    assert.equal(before.find((c) => c.name === "~/.bloks/people.json")?.open, false);
    assert.equal(before.some((c) => c.name === "~/.bloks/webhooks.json"), false);

    const { fixed, failed } = tightenPermissions(data);
    assert.equal(fixed.length, 4);
    assert.deepEqual(failed, []);
    assert.equal(mode(data), "700");
    assert.equal(mode(join(data, "config.json")), "600");
    assert.equal(mode(join(data, "identities")), "700");
    assert.equal(mode(join(data, "identities", "ada.pem")), "600");
    assert.equal(mode(elsewhere), "644", "the link's target was changed");
    assert.ok(filePermissions(data).every((c) => !c.open));
  });
});

describe("through the server", () => {
  async function fixture(t: TestContext) {
    const home = mkdtempSync(join(tmpdir(), "bloks-security-"));
    const runs = join(home, "runs.jsonl");
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(runs, "");
    // a turn told ASK asks for the checkup with its own credential
    writeFileSync(cli, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (f) => console.log(JSON.stringify(f));
let input = "";
process.stdin.on("data", async function take(c) {
  input += c;
  const frame = input.split("\\n").slice(0, -1).filter(Boolean).map(JSON.parse).find((f) => f.type === "user");
  if (!frame) return;
  process.stdin.off("data", take);
  const said = typeof frame.message.content === "string" ? frame.message.content : JSON.stringify(frame.message.content);
  const asked = {};
  if (said.includes("ASK")) {
    const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN };
    asked.read = (await fetch(process.env.BLOKS_URL + "/api/security", { headers: auth })).status;
    asked.fix = (await fetch(process.env.BLOKS_URL + "/api/security/permissions", { method: "POST", headers: auth })).status;
  }
  appendFileSync(${JSON.stringify(runs)}, JSON.stringify(asked) + "\\n");
  out({ type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: "s", result: "Done", total_cost_usd: 0 });
});
`, { mode: 0o755 });
    mkdirSync(join(home, ".bloks"));
    writeFileSync(
      join(home, ".bloks", "config.json"),
      JSON.stringify({
        instances: { claude: { driver: "claudeAgent", config: { cli } } },
        secrets: { GITHUB_TOKEN: "ghp-the-value-itself", SPARE_KEY: "spare-value" },
      }),
    );
    const h = await startHarness({ HOME: home });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const runsSoFar = () => readFileSync(runs, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { h, home, runsSoFar };
  }

  test("the checkup reads this workspace, and its fixes work", async (t) => {
    const { h, home } = await fixture(t);
    const report = async () => {
      const res = await h.fetch("/api/security");
      assert.equal(res.status, 200);
      return res.json();
    };
    let r = await report();
    assert.ok(Array.isArray(r.findings) && r.findings.length >= 8);
    assert.equal(r.findings.find((f: any) => f.id === "files").level, "ok", "a fresh ~/.bloks is already private");
    assert.deepEqual(r.findings.find((f: any) => f.id === "secrets").items.map((i: any) => i.name), ["GITHUB_TOKEN", "SPARE_KEY"]);
    assert.doesNotMatch(JSON.stringify(r), /ghp-the-value-itself|spare-value/, "a secret's value reached the report");

    // an agent in full access, then taken off it the way the page does
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ approvals: "full" }) });
    r = await report();
    assert.equal(r.findings[0].id, "full-access");
    assert.equal(r.risky, 1);
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ approvals: "auto" }) });
    assert.equal((await report()).risky, 0);

    // a config file another account could read, fixed from the page
    chmodSync(join(home, ".bloks", "config.json"), 0o644);
    r = await report();
    assert.equal(r.findings.find((f: any) => f.id === "files").level, "risky");
    const fixed = await (await h.fetch("/api/security/permissions", { method: "POST" })).json();
    assert.deepEqual(fixed.fixed, ["~/.bloks/config.json"]);
    assert.equal(fixed.findings.find((f: any) => f.id === "files").level, "ok");
    assert.equal(statSync(join(home, ".bloks", "config.json")).mode & 0o777, 0o600);

    // a secret forgotten is gone from disk and from the next turn
    const forgot = await h.fetch("/api/security/secrets/GITHUB_TOKEN", { method: "DELETE" });
    assert.equal(forgot.status, 200);
    assert.deepEqual((await forgot.json()).findings.find((f: any) => f.id === "secrets").items.map((i: any) => i.name), ["SPARE_KEY"]);
    const disk = JSON.parse(readFileSync(join(home, ".bloks", "config.json"), "utf8"));
    assert.deepEqual(Object.keys(disk.secrets), ["SPARE_KEY"]);
    assert.equal((await h.fetch("/api/security/secrets/GITHUB_TOKEN", { method: "DELETE" })).status, 404);
    assert.equal((await h.fetch("/api/security/secrets/..%2Fconfig", { method: "DELETE" })).status, 404);
  });

  test("a paired phone and an agent's own turn are turned away", async (t) => {
    const { h, home, runsSoFar } = await fixture(t);
    await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const started = await h.json("/api/pair/start", { method: "POST" });
    const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Test iPhone" }) });
    assert.ok(paired.body?.token, "the fixture phone did not pair");
    assert.equal((await h.fetchRemote("/api/bots", { token: paired.body.token })).status, 200, "the paired phone is not paired");
    assert.equal((await h.fetchRemote("/api/security", { token: paired.body.token })).status, 403);
    assert.equal((await h.fetchRemote("/api/security/permissions", { method: "POST", token: paired.body.token })).status, 403);
    assert.equal((await h.fetchRemote("/api/security/secrets/SPARE_KEY", { method: "DELETE", token: paired.body.token })).status, 403);
    // and the pairing it took to try is itself a finding
    const remote = (await h.json("/api/security")).findings.find((f: any) => f.id === "remote");
    assert.equal(remote.level, "look");
    assert.match(remote.summary, /1 device of yours/);

    assert.equal(allows("ada", "GET", "/api/security").ok, false);
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    chmodSync(join(home, ".bloks", "config.json"), 0o644);
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ASK about security" }) });
    const asked = await waitFor(() => runsSoFar().find((r) => r.read !== undefined));
    assert.ok(asked, h.logs());
    assert.deepEqual(asked, { read: 403, fix: 403 });
    assert.equal(statSync(join(home, ".bloks", "config.json")).mode & 0o777, 0o644, "an agent changed a file's mode");
    assert.ok(existsSync(join(home, ".bloks")));
  });
});
