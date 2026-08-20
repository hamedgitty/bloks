// The sample workspace the phone shows when it has no Mac to talk to.
//
// App Review has no Mac running Bloks. If this file is malformed the app
// decodes nothing, shows an empty list, and gets rejected as incomplete,
// which is a failure nobody would see until it happened. It is generated
// rather than hand-written, so what is worth checking is that the
// generator still produces the three things it exists to demonstrate.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(repo, "ios", "Bloks", "Resources", "demo-workspace.json"), "utf8");
const fixture = JSON.parse(raw) as {
  note: string;
  bots: Array<Record<string, any>>;
  rooms: Array<Record<string, any>>;
};

// Exactly what ios/Bloks/Models/Message.swift decodes. A kind not in this
// list renders as nothing on the phone.
const KINDS = [
  "text",
  "options",
  "activity",
  "screen",
  "notice",
  "artifact",
  "connector",
  "secret",
  "component",
];

const everyMessage = () => [
  ...fixture.bots.flatMap((b) => (b.messages ?? []).map((m: any) => [b.name, m] as const)),
  ...fixture.rooms.flatMap((r) => (r.messages ?? []).map((m: any) => [r.name, m] as const)),
];

describe("the sample workspace", () => {
  test("has agents and a room, each with an id the phone needs", () => {
    assert.ok(fixture.bots.length >= 3, "too few agents to look like a workspace");
    assert.ok(fixture.rooms.length >= 1, "no room, and a room is half the product");
    for (const bot of fixture.bots) assert.equal(typeof bot.id, "string");
    for (const room of fixture.rooms) assert.equal(typeof room.id, "string");
  });

  test("every message is one the phone can draw", () => {
    for (const [where, message] of everyMessage()) {
      assert.equal(typeof message.id, "string", `${where} has a message with no id`);
      assert.equal(typeof message.at, "number", `${where} has a message with no time`);
      assert.ok(KINDS.includes(message.kind), `${where} has a "${message.kind}" message the phone cannot draw`);
    }
  });

  test("carries an open approval, which is the reason the app exists", () => {
    const open = everyMessage().find(([, m]) => m.card?.requestId && !m.card.answered && !m.card.dismissed);
    assert.ok(open, "no open approval: the sample demonstrates the wrong product");
  });

  test("carries a workflow gate, which is not the same thing", () => {
    const gate = everyMessage().find(([, m]) => m.card?.runId);
    assert.ok(gate, "no workflow gate");
    assert.equal(gate![1].card.options.length, 2, "a gate has exactly two answers");
  });

  test("carries an answer that is not a paragraph", () => {
    const component = everyMessage().find(([, m]) => m.kind === "component");
    assert.ok(component, "no component: the gallery is invisible in the sample");
    assert.ok(component![1].component?.kind, "the component does not say what shape it is");
  });

  test("says it is a sample, since it will be read as real otherwise", () => {
    assert.match(fixture.note, /Not real data/);
  });

  test("no em dashes and no en dashes, the same as everywhere else", () => {
    assert.ok(!/—|–/.test(raw), "the sample workspace has a dash in it");
  });
});
