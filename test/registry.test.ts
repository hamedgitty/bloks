// GitHub 525: the registry, who reports to whom and who to ask for what
// (server/registry.ts). Stored as the owner sets it, read the same way
// after a restart, and holding nothing until the owner turns on asking a
// lead first: an empty registry, or a hierarchy alone, routes every
// message as before.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_REGISTRY,
  MAX_CONTACT_FOR_CHARS,
  RegistryStore,
  acrossRefusal,
  chainOfCommand,
  contactLine,
  contactsFor,
  forgetAgent,
  hierarchyBriefing,
  leadNow,
  normalizeRegistry,
  orgView,
  reportsOf,
  rosterOf,
  routeMessage,
  withContactFor,
  withLead,
  type Registry,
  type RegistryAgent,
} from "../server/registry.ts";
import { allows } from "../server/agent-cli.ts";
import { agentMatches, leadChoices, reportingRows, unplacedAgents } from "../src/lib/registry.ts";

// Two teams. Marlow leads Ada and Atlas, and Ada has a worker, Pip.
// Juno leads Quill. Solo is on its own.
const AGENTS: RegistryAgent[] = [
  { id: "marlow", name: "Marlow", title: "Lead architect", skills: ["Plan the work"] },
  { id: "ada", name: "Ada", title: "Frontend specialist", skills: ["Responsive layout", "Accessibility review"] },
  { id: "atlas", name: "Atlas", title: "Backend engineer", skills: ["Database schema"] },
  { id: "pip", name: "Pip", title: "Test runner", skills: ["Run the suite"] },
  { id: "juno", name: "Juno", title: "Growth lead", skills: ["Campaign plan"] },
  { id: "quill", name: "Quill", title: "Copywriter", description: "Writes launch pages and release notes.", skills: ["Headlines"] },
  { id: "solo", name: "Solo", title: "Generalist" },
];
const roster = rosterOf(AGENTS);
const LEADS = { ada: "marlow", atlas: "marlow", pip: "ada", quill: "juno" };
const chart = (over: Partial<Registry> = {}): Registry => ({ leads: { ...LEADS }, contactFor: {}, leadFirst: false, ...over });
const apart = { sharesRoom: false, inExchange: false };
const PAIRS = AGENTS.flatMap((a) => AGENTS.map((b) => [a.id, b.id] as const));

describe("the unchanged default", () => {
  test("an empty registry routes every message, between any two agents, as it always has", () => {
    for (const [from, to] of PAIRS) {
      assert.deepEqual(routeMessage(EMPTY_REGISTRY, from, to, roster, apart), { ok: true, why: "open" }, `${from} to ${to}`);
    }
  });

  test("a hierarchy alone holds nothing: only the owner's switch does", () => {
    for (const [from, to] of PAIRS) {
      assert.equal(routeMessage(chart(), from, to, roster, apart).ok, true, `${from} to ${to}`);
    }
  });

  test("the switch on with nobody under anybody holds nothing either", () => {
    for (const [from, to] of PAIRS) {
      assert.equal(routeMessage({ ...EMPTY_REGISTRY, leadFirst: true }, from, to, roster, apart).ok, true, `${from} to ${to}`);
    }
  });

  test("an agent with no place is told nothing about one", () => {
    for (const agent of AGENTS) assert.equal(hierarchyBriefing(EMPTY_REGISTRY, agent.id, roster, "Sam", "bloks"), null, agent.id);
    assert.equal(hierarchyBriefing(chart(), "solo", roster, "Sam", "bloks"), null);
  });

  test("a missing file is an empty registry, switch off", () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-registry-"));
    try {
      const store = new RegistryStore(join(dir, "registry.json"));
      assert.deepEqual(store.get(), { leads: {}, contactFor: {}, leadFirst: false });
      // reading is not writing: nothing appears on disk until the owner sets something
      assert.equal(existsSync(join(dir, "registry.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storing the hierarchy", () => {
  test("what the owner set is what a restart reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-registry-"));
    try {
      const file = join(dir, "registry.json");
      const first = new RegistryStore(file);
      first.put(withContactFor(chart({ leadFirst: true }), "atlas", "Database questions"));
      const again = new RegistryStore(file);
      assert.deepEqual(again.get(), { leads: LEADS, contactFor: { atlas: "Database questions" }, leadFirst: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not a registry is set aside, never acted on", () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-registry-"));
    try {
      const file = join(dir, "registry.json");
      writeFileSync(file, "[1, 2, 3]");
      assert.deepEqual(new RegistryStore(file).get(), { leads: {}, contactFor: {}, leadFirst: false });
      assert.ok(readdirSync(dir).some((f) => f !== "registry.json"), "the unreadable file was kept aside");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hand-edited loop, a lead of itself and a bad id are dropped as it is read", () => {
    const read = normalizeRegistry({
      leads: { a: "b", b: "c", c: "a", d: "d", "bad id!": "a", e: 7 },
      contactFor: { a: "  Billing\n questions  ", b: "" },
      leadFirst: "yes",
    });
    // a and b keep their leads; c reporting to a would close the loop
    assert.deepEqual(read.leads, { a: "b", b: "c" });
    assert.deepEqual(read.contactFor, { a: "Billing questions" });
    // only true turns it on
    assert.equal(read.leadFirst, false);
  });

  test("a contact line is one tidy line, clamped, with no long dashes", () => {
    assert.equal(contactLine("Billing \u2014 refunds"), "Billing, refunds");
    assert.equal(contactLine(42), "");
    assert.equal(contactLine("x".repeat(500)).length, MAX_CONTACT_FOR_CHARS);
    assert.deepEqual(withContactFor(withContactFor(EMPTY_REGISTRY, "ada", "Layout"), "ada", "   ").contactFor, {});
  });

  test("setting a lead refuses itself, a loop and a stranger, and null clears it", () => {
    assert.match((withLead(chart(), "ada", "ada", roster) as { error: string }).error, /cannot report to itself/);
    // Pip is under Ada, so Ada cannot go under Pip
    assert.match((withLead(chart(), "ada", "pip", roster) as { error: string }).error, /Pip is already under Ada/);
    assert.match((withLead(chart(), "marlow", "pip", roster) as { error: string }).error, /already under Marlow/);
    assert.match((withLead(chart(), "ada", "nobody", roster) as { error: string }).error, /no such agent/);
    assert.match((withLead(chart(), "nobody", "ada", roster) as { error: string }).error, /no such agent/);
    const moved = withLead(chart(), "quill", "marlow", roster) as { registry: Registry };
    assert.equal(moved.registry.leads.quill, "marlow");
    const cleared = withLead(chart(), "quill", null, roster) as { registry: Registry };
    assert.equal("quill" in cleared.registry.leads, false);
  });

  test("a deleted manager's reports move up to its own lead", () => {
    const after = forgetAgent(withContactFor(chart(), "ada", "Layout"), "ada");
    assert.equal(after.leads.pip, "marlow");
    assert.equal("ada" in after.leads, false);
    assert.equal("ada" in after.contactFor, false);
    // a top's reports become tops
    const top = forgetAgent(chart(), "marlow");
    assert.equal("ada" in top.leads, false);
    assert.equal(top.leads.pip, "ada");
  });

  test("an archived lead is passed over for the nearest one above it", () => {
    const archived = rosterOf(AGENTS.map((a) => (a.id === "ada" ? { ...a, archivedAt: 1 } : a)));
    assert.equal(leadNow(chart(), "pip", archived), "marlow");
    assert.deepEqual(chainOfCommand(chart(), "pip", archived), ["marlow"]);
    assert.ok(reportsOf(chart(), "marlow", archived).includes("pip"));
    assert.ok(!reportsOf(chart(), "marlow", archived).includes("ada"));
  });
});

describe("routing with the switch on", () => {
  const on = chart({ leadFirst: true });
  const route = (from: string, to: string, ctx = apart) => routeMessage(on, from, to, roster, ctx);

  test("up the chain of command always goes", () => {
    assert.deepEqual(route("pip", "ada"), { ok: true, why: "up" });
    assert.deepEqual(route("pip", "marlow"), { ok: true, why: "up" });
  });

  test("within the team, everyone under the lead, it goes", () => {
    assert.deepEqual(route("ada", "atlas"), { ok: true, why: "team" });
    assert.deepEqual(route("atlas", "pip"), { ok: true, why: "team" });
    assert.deepEqual(route("ada", "pip"), { ok: true, why: "team" });
  });

  test("across teams it is held, and names the lead to go through", () => {
    assert.deepEqual(route("ada", "quill"), { ok: false, via: "marlow" });
    assert.deepEqual(route("pip", "juno"), { ok: false, via: "ada" });
    assert.deepEqual(route("quill", "atlas"), { ok: false, via: "juno" });
    // an agent nobody placed is outside every team too
    assert.deepEqual(route("ada", "solo"), { ok: false, via: "marlow" });
    const said = acrossRefusal({ name: "Quill" }, { id: "marlow", name: "Marlow" });
    assert.match(said, /Nothing was sent/);
    assert.ok(said.includes("bloks say marlow"), said);
    assert.doesNotMatch(said, /[\u2013\u2014]/);
  });

  test("an agent with no lead has nobody to ask, and reaches anyone", () => {
    for (const to of ["quill", "juno", "pip", "solo"]) assert.equal(route("marlow", to).ok, true, to);
    for (const to of ["ada", "quill", "pip"]) assert.equal(route("solo", to).ok, true, to);
  });

  test("a room the owner put them in, or a reply, is never held", () => {
    assert.deepEqual(route("ada", "quill", { sharesRoom: true, inExchange: false }), { ok: true, why: "room" });
    assert.deepEqual(route("ada", "quill", { sharesRoom: false, inExchange: true }), { ok: true, why: "exchange" });
    assert.deepEqual(route("ada", "ada"), { ok: true, why: "self" });
  });

  test("with its lead archived, an agent goes through the next lead up", () => {
    const archived = rosterOf(AGENTS.map((a) => (a.id === "ada" ? { ...a, archivedAt: 1 } : a)));
    assert.deepEqual(routeMessage(on, "pip", "quill", archived, apart), { ok: false, via: "marlow" });
    assert.equal(routeMessage(on, "pip", "atlas", archived, apart).ok, true);
  });
});

describe("reading it", () => {
  test("the chart: tops, the unplaced, and teams without archived members", () => {
    const agents = AGENTS.map((a) => (a.id === "atlas" ? { ...a, archivedAt: 5 } : a));
    const view = orgView(chart(), agents, [{ id: "room", name: "Launch", memberIds: ["juno", "quill", "atlas"], leadId: "atlas" }]);
    assert.deepEqual(view.tops.sort(), ["juno", "marlow"]);
    assert.deepEqual(view.unplaced, ["solo"]);
    assert.equal(view.agents.some((a) => a.id === "atlas"), false);
    assert.deepEqual(view.teams, [{ id: "room", name: "Launch", lead: null, members: ["juno", "quill"] }]);
    assert.deepEqual(view.agents.find((a) => a.id === "quill")?.rooms, ["room"]);
  });

  test("who to contact: the owner's line counts most, and the answer says the way there", () => {
    const reg = withContactFor(withContactFor(chart({ leadFirst: true }), "quill", "Release notes and launch copy"), "atlas", "Database questions");
    const found = contactsFor("release notes", reg, AGENTS, { id: "ada", ctx: () => apart });
    assert.equal(found[0].id, "quill");
    assert.deepEqual(found[0].route, { direct: false, via: "marlow", viaName: "Marlow" });
    assert.ok(found[0].matched.includes("contact for"));
    // inside the team it is direct
    const db = contactsFor("database", reg, AGENTS, { id: "ada", ctx: () => apart });
    assert.equal(db[0].id, "atlas");
    assert.deepEqual(db[0].route, { direct: true });
    // never yourself, never someone archived
    assert.equal(contactsFor("frontend", reg, AGENTS, { id: "ada", ctx: () => apart }).some((c) => c.id === "ada"), false);
    const archived = AGENTS.map((a) => (a.id === "quill" ? { ...a, archivedAt: 1 } : a));
    assert.equal(contactsFor("release notes", reg, archived).some((c) => c.id === "quill"), false);
    // no words: only those the owner wrote a line for
    assert.deepEqual(contactsFor("", reg, AGENTS).map((c) => c.id).sort(), ["atlas", "quill"]);
    assert.deepEqual(contactsFor("zebra", reg, AGENTS), []);
  });

  test("with the switch off, every contact is direct", () => {
    const found = contactsFor("copywriter", chart(), AGENTS, { id: "ada", ctx: () => apart });
    assert.deepEqual(found[0].route, { direct: true });
  });

  test("a placed agent is told its lead, its reports and, with the switch on, to ask first", () => {
    const off = hierarchyBriefing(chart(), "ada", roster, "Sam", "bloks") ?? "";
    assert.match(off, /as Sam set it/);
    assert.match(off, /you report to Marlow \(marlow\)/);
    assert.match(off, /Pip \(pip\) reports to you/);
    assert.doesNotMatch(off, /held/);
    const on = hierarchyBriefing(chart({ leadFirst: true }), "ada", roster, "Sam", "bloks") ?? "";
    assert.match(on, /ask Marlow/);
    assert.match(on, /`bloks who <what you need>`/);
    const top = hierarchyBriefing(chart({ leadFirst: true }), "marlow", roster, "Sam", null) ?? "";
    assert.match(top, /nobody is above you/);
    assert.match(top, /Ada \(ada\) and Atlas \(atlas\) report to you/);
    assert.doesNotMatch(top, /bloks/);
    for (const text of [off, on, top]) assert.doesNotMatch(text, /[\u2013\u2014]/);
  });
});

describe("who may change it", () => {
  test("an agent reads the chart and asks who to contact, and nothing more", () => {
    assert.equal(allows("ada", "GET", "/api/agent/registry").ok, true);
    assert.equal(allows("ada", "GET", "/api/agent/registry/contacts?q=billing").ok, true);
    for (const [method, path] of [
      ["GET", "/api/registry"],
      ["PATCH", "/api/registry"],
      ["PATCH", "/api/registry/agents/ada"],
      ["PATCH", "/api/registry/agents/marlow"],
      ["GET", "/api/registry/contacts"],
      ["POST", "/api/agent/registry"],
    ] as const) {
      assert.equal(allows("ada", method, path).ok, false, `${method} ${path}`);
    }
  });
});

describe("the Agents page's reading", () => {
  const view = orgView(chart(), AGENTS, []);

  test("rows top down, reports under their lead, each once", () => {
    const rows = reportingRows(view).map((r) => `${"  ".repeat(r.depth)}${r.agent.id}`);
    assert.deepEqual(rows, ["juno", "  quill", "marlow", "  ada", "    pip", "  atlas"]);
    assert.deepEqual(unplacedAgents(view).map((a) => a.id), ["solo"]);
  });

  test("an agent cannot be put under itself or anyone under it", () => {
    const choices = leadChoices(view, "marlow").map((a) => a.id);
    for (const below of ["marlow", "ada", "atlas", "pip"]) assert.equal(choices.includes(below), false, below);
    assert.deepEqual(choices.sort(), ["juno", "quill", "solo"]);
  });

  test("a search finds a name, a role, a contact line or a skill", () => {
    const ada = view.agents.find((a) => a.id === "ada")!;
    assert.equal(agentMatches(ada, ["Accessibility review"], "access"), true);
    assert.equal(agentMatches(ada, [], "FRONTEND"), true);
    assert.equal(agentMatches(ada, [], "ada frontend"), true);
    assert.equal(agentMatches(ada, [], "database"), false);
    assert.equal(agentMatches(ada, [], "  "), true);
  });
});

test("the registry file is written for the owner alone", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-registry-"));
  try {
    const file = join(dir, "registry.json");
    new RegistryStore(file).put(chart());
    const { statSync } = await import("node:fs");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).leads, LEADS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
