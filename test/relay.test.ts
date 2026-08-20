// The relay's routing table.
//
// The relay is the one piece of Bloks that sits on somebody else's
// computer, so the assertions here are mostly about what it refuses:
// a token that is wrong, a role that is borrowed, a space answering
// another space's request, and a Mac that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SpaceRegistry, type Ask } from "../relay/spaces.ts";

test("a space issues one agent token and one client token, and they are different roles", () => {
  const registry = new SpaceRegistry();
  const { space, agentToken, clientToken } = registry.create();

  assert.equal(registry.authenticate(agentToken)?.role, "agent");
  assert.equal(registry.authenticate(clientToken)?.role, "client");
  assert.equal(registry.authenticate(agentToken)?.space.id, space.id);
});

test("an agent token cannot be used as a client, or the Mac credential is a listening device", () => {
  // This is the assertion that matters most in this file. If a stolen Mac
  // token could open the client stream, whoever took it could read every
  // event flowing to the phones.
  const registry = new SpaceRegistry();
  const { agentToken } = registry.create();
  const auth = registry.authenticate(agentToken);
  assert.equal(auth?.role, "agent");
  assert.notEqual(auth?.role, "client");
});

test("an unknown or absent token authenticates as nobody", () => {
  const registry = new SpaceRegistry();
  registry.create();
  assert.equal(registry.authenticate(null), null);
  assert.equal(registry.authenticate(""), null);
  assert.equal(registry.authenticate("not-a-token"), null);
  // A token of the right shape but the wrong value must not pass either.
  assert.equal(registry.authenticate("a".repeat(43)), null);
});

test("a second phone can join a space, and revoking clears every phone", () => {
  const registry = new SpaceRegistry();
  const { space, clientToken, agentToken } = registry.create();
  const second = registry.addClient(space.id);
  assert.ok(second);
  assert.equal(registry.authenticate(second)?.role, "client");

  registry.revokeClients(space.id);
  assert.equal(registry.authenticate(clientToken), null);
  assert.equal(registry.authenticate(second), null);
  // Revoking phones must not lock the Mac out of its own space.
  assert.equal(registry.authenticate(agentToken)?.role, "agent");
});

test("asking an offline Mac fails immediately rather than hanging", async () => {
  // Twenty seconds of spinner is a worse answer than "your Mac is not
  // online", which is something a person can act on.
  const registry = new SpaceRegistry();
  const { space } = registry.create();
  await assert.rejects(() => registry.ask(space.id, "ciphertext"), /offline/);
});

test("an ask reaches the Mac and its answer comes back to the caller", async () => {
  const registry = new SpaceRegistry();
  const { space } = registry.create();

  let delivered: Ask | null = null;
  registry.openLink(space.id, (ask) => {
    delivered = ask;
    // The Mac answers on its own schedule.
    setTimeout(() => registry.answer(space.id, { id: ask.id, status: 202, payload: "reply" }), 5);
  });

  const answer = await registry.ask(space.id, "command");
  assert.equal(answer.status, 202);
  assert.equal(answer.payload, "reply");
  assert.equal(delivered!.payload, "command", "the relay forwards the blob untouched");
});

test("one space cannot settle another space's request by guessing an id", async () => {
  const registry = new SpaceRegistry();
  const mine = registry.create();
  const theirs = registry.create();

  let asked: Ask | null = null;
  registry.openLink(mine.space.id, (ask) => {
    asked = ask;
  });
  registry.openLink(theirs.space.id, () => {});

  const pending = registry.ask(mine.space.id, "command");
  await new Promise((r) => setTimeout(r, 5));

  const stolen = registry.answer(theirs.space.id, {
    id: asked!.id,
    status: 200,
    payload: "forged",
  });
  assert.equal(stolen, false, "the other space's answer is refused");

  // The real Mac can still answer it.
  registry.answer(mine.space.id, { id: asked!.id, status: 202, payload: "real" });
  assert.equal((await pending).payload, "real");
});

test("an answer nobody asked for is ignored", () => {
  const registry = new SpaceRegistry();
  const { space } = registry.create();
  registry.openLink(space.id, () => {});
  assert.equal(registry.answer(space.id, { id: "made-up", status: 200, payload: "x" }), false);
});

test("a Mac is offline once its link goes quiet, and online again when it returns", () => {
  const registry = new SpaceRegistry();
  const { space } = registry.create();
  assert.equal(registry.isOnline(space.id), false);
  registry.openLink(space.id, () => {});
  assert.equal(registry.isOnline(space.id), true);
  registry.closeLink(space.id);
  assert.equal(registry.isOnline(space.id), false);
});

test("a reconnecting Mac replaces its old link rather than racing it", async () => {
  // Two Macs answering the same ask is a worse failure than a reconnect
  // dropping one, so the newest link wins.
  const registry = new SpaceRegistry();
  const { space } = registry.create();

  const seen: string[] = [];
  registry.openLink(space.id, () => seen.push("first"));
  registry.openLink(space.id, (ask) => {
    seen.push("second");
    registry.answer(space.id, { id: ask.id, status: 202, payload: "ok" });
  });

  await registry.ask(space.id, "command");
  assert.deepEqual(seen, ["second"]);
});

test("events fan out to every phone on the space and to no other space", () => {
  const registry = new SpaceRegistry();
  const mine = registry.create();
  const theirs = registry.create();

  const got: string[] = [];
  const other: string[] = [];
  const stop = registry.listen(mine.space.id, (p) => got.push(p));
  registry.listen(mine.space.id, (p) => got.push(p));
  registry.listen(theirs.space.id, (p) => other.push(p));

  registry.broadcast(mine.space.id, "frame");
  assert.deepEqual(got, ["frame", "frame"], "both phones on the space");
  assert.deepEqual(other, [], "and nobody else's");

  stop();
  registry.broadcast(mine.space.id, "again");
  assert.equal(registry.listenerCount(mine.space.id), 1);
});

test("a phone whose socket throws is dropped rather than breaking the fan-out", () => {
  // One dead phone must not stop the others receiving their events.
  const registry = new SpaceRegistry();
  const { space } = registry.create();
  const good: string[] = [];
  registry.listen(space.id, () => {
    throw new Error("socket gone");
  });
  registry.listen(space.id, (p) => good.push(p));

  registry.broadcast(space.id, "frame");
  assert.deepEqual(good, ["frame"]);
  assert.equal(registry.listenerCount(space.id), 1, "the broken one is gone");
});
