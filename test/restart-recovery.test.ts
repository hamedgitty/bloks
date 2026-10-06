// A turn cut off by Bloks stopping, picked up when it starts again
// (server/cut-off.ts, and recoverCutOff in server/index.ts; GitHub 160).
//
// The rules worth a real restart: a crash counts as much as a quit; a
// turn is picked up once, in its own lane, and never on a second start;
// what was queued behind it goes in the same turn; a card the old engine
// raised can never be answered into the new one; a stop, or an agent put
// away, stays that way; and after too long away the person decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 15_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

const PICKUP = "Bloks stopped in the middle of your last step";

/** A provider that answers on cue: every call is kept, and held until the
 * test lets it go, unless `answerAtOnce` is set. */
async function fakeProvider(t: { after: (fn: () => unknown) => void }) {
  const state = {
    calls: [] as string[],
    held: [] as Array<() => void>,
    answerAtOnce: false,
    /** A turn whose body has this in it gets a question back, once. */
    askOn: "",
  };
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      state.calls.push(body);
      if (state.askOn && body.includes(state.askOn) && !body.includes(PICKUP) && !body.includes('"role":"tool"')) {
        return res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "ask_user", arguments: JSON.stringify({ question: "Ship it?", choices: ["Yes", "No"] }) },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (state.answerAtOnce) finish();
      else state.held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    state.held.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
  });
  const port = (provider.address() as { port: number }).port;
  return {
    state,
    port,
    sent: (marker: string) => state.calls.filter((c) => c.includes(marker)).length,
  };
}

async function agentOn(h: Harness, port: number, name: string) {
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  return bot as { id: string; threadId: string };
}

const messagesOf = async (h: Harness, bot: { id: string; threadId: string }) =>
  (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];

const idle = (h: Harness, bot: { id: string }) =>
  waitFor(async () => {
    const { bots } = await h.json("/api/bots");
    const found = bots.find((b: any) => b.id === bot.id);
    return found && !found.busy ? found : null;
  });

const inFlight = (home: string) => {
  try {
    return JSON.parse(readFileSync(join(home, ".bloks", "turns-in-flight.json"), "utf8")) as any[];
  } catch {
    return [];
  }
};

test("a turn cut off by a crash is picked up once, in its own lane, with what was queued behind it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cutoff-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = await fakeProvider(t);

  const first = await startHarness({ HOME: home });
  const bot = await agentOn(first, fake.port, "Ivy");
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WRITE-THE-REPORT" }) });
  await waitFor(() => fake.state.calls.length >= 1);
  const queued = await first.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "NEWER-WORDS" }) });
  assert.equal(queued.queued, true);
  // on disk while it runs, before anything has gone wrong
  const recorded = inFlight(home);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].laneId, bot.threadId);
  assert.equal(recorded[0].requester, "owner");
  assert.equal(recorded[0].instanceId, "grok");
  // no SIGTERM, no chance to tidy up
  await first.crash();

  fake.state.answerAtOnce = true;
  const second = await startHarness({ HOME: home });
  assert.ok(await waitFor(() => fake.sent(PICKUP) >= 1), "the cut-off turn was never picked up");
  await idle(second, bot);
  // give a second pickup, or a separate turn for the queue, time to happen
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(fake.sent(PICKUP), 1, "picked up more than once");
  const pickup = fake.state.calls.find((c) => c.includes(PICKUP))!;
  // the newer words went in the same turn, which is the only turn after
  // the restart: nothing raced it
  assert.ok(pickup.includes("NEWER-WORDS"), "what was queued did not join the pickup");
  assert.equal(fake.state.calls.length, 2, "a turn of its own started beside the pickup");

  const messages = await messagesOf(second, bot);
  const notices = messages.filter((m) => m.kind === "notice" && /cut off when Bloks stopped/.test(m.text ?? ""));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, "Ivy was cut off when Bloks stopped, and is picking up where it left off.");
  // a notice, never words put in the person's mouth, and the request is
  // not asked again
  assert.equal(messages.filter((m) => m.role === "user" && /stopped in the middle/.test(m.text ?? "")).length, 0);
  assert.equal(messages.filter((m) => m.role === "user" && m.text === "WRITE-THE-REPORT").length, 1);
  const newer = messages.find((m) => m.text === "NEWER-WORDS");
  assert.equal(newer.queued, false);
  assert.equal(typeof newer.deliveredAt, "number");
  assert.deepEqual(inFlight(home), [], "the pickup ended and left nothing behind");
  await second.stop();

  // and a later start finds nothing to pick up
  const third = await startHarness({ HOME: home });
  t.after(() => third.stop());
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(fake.sent(PICKUP), 1, "a second start picked the same turn up again");
  const after = await messagesOf(third, bot);
  assert.equal(after.filter((m) => m.kind === "notice" && /cut off when Bloks stopped/.test(m.text ?? "")).length, 1);
});

test("a turn somebody stopped, or one whose agent was put away, stays stopped", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cutoff-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = await fakeProvider(t);

  const first = await startHarness({ HOME: home });
  const stopped = await agentOn(first, fake.port, "Stopped");
  const shelved = await agentOn(first, fake.port, "Shelved");
  await first.fetch(`/api/bots/${stopped.id}/messages`, { method: "POST", body: JSON.stringify({ text: "STOP-ME" }) });
  await first.fetch(`/api/bots/${shelved.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SHELVE-ME" }) });
  await waitFor(() => fake.sent("STOP-ME") >= 1 && fake.sent("SHELVE-ME") >= 1);
  await first.fetch(`/api/bots/${stopped.id}/interrupt`, { method: "POST", body: JSON.stringify({}) });
  await first.crash();

  // put away while Bloks was not running
  const botsFile = join(home, ".bloks", "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  bots.find((b: any) => b.id === shelved.id).archivedAt = Date.now();
  writeFileSync(botsFile, JSON.stringify(bots, null, 2));

  fake.state.answerAtOnce = true;
  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal(fake.sent(PICKUP), 0, "a turn that should have stayed stopped was picked up");
  for (const bot of [stopped, shelved]) {
    const messages = await messagesOf(second, bot);
    assert.equal(messages.filter((m) => m.kind === "notice" && /cut off when Bloks stopped/.test(m.text ?? "")).length, 0);
  }
  assert.deepEqual(inFlight(home), [], "dropped, so no later start considers them either");
});

test("after too long away the person decides, an old card answers nothing, and stale queued words stay unsent", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cutoff-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = await fakeProvider(t);
  fake.state.askOn = "DECIDE-SHIP";

  const first = await startHarness({ HOME: home });
  const bot = await agentOn(first, fake.port, "Kat");
  await first.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "DECIDE-SHIP" }) });
  const card = await waitFor(async () => (await messagesOf(first, bot)).find((m) => m.kind === "options" && m.card?.requestId)?.card);
  assert.ok(card, "no question card appeared");
  await first.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LATE-WORDS" }) });
  await first.crash();

  // and the machine stayed off overnight
  const away = Date.now() - 13 * 60 * 60_000;
  const turnsFile = join(home, ".bloks", "turns-in-flight.json");
  writeFileSync(turnsFile, JSON.stringify(inFlight(home).map((turn) => ({ ...turn, seenAt: away }))));
  const laneFile = join(home, ".bloks", `messages-${bot.threadId}.json`);
  const list = JSON.parse(readFileSync(laneFile, "utf8"));
  for (const m of list) if (m.queued) m.queuedAt = away;
  writeFileSync(laneFile, JSON.stringify(list, null, 2));

  fake.state.answerAtOnce = true;
  const callsBefore = fake.state.calls.length;
  const second = await startHarness({ HOME: home });
  t.after(() => second.stop());
  const offered = await waitFor(async () => (await messagesOf(second, bot)).find((m) => m.kind === "notice" && m.carryOn));
  assert.ok(offered, "no Continue was offered");
  assert.match(offered.text, /^Kat was cut off when Bloks stopped, more than 12 hours ago/);
  assert.equal(offered.carryOn.laneId, bot.threadId);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(fake.state.calls.length, callsBefore, "picked up on its own after too long away");

  let messages = await messagesOf(second, bot);
  assert.equal(messages.find((m) => m.text === "LATE-WORDS").unsent, true, "stale queued words were not set aside");
  const old = messages.find((m) => m.kind === "options" && m.card?.requestId === card.requestId);
  assert.equal(old.card.cutOff, true);
  assert.ok(old.card.answered, "the old card still reads as open");
  // answering it anyway goes nowhere: no engine hears it as permission
  const answered = await second.json(`/api/bots/${bot.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ requestId: card.requestId, behavior: "answer", message: "Yes" }),
  });
  assert.equal(answered.outcome, "unavailable");
  assert.equal(fake.state.calls.length, callsBefore);

  // Continue is the same pickup, once
  const pressed = await second.fetch(`/api/threads/${bot.threadId}/carry-on`, { method: "POST" });
  assert.equal(pressed.status, 200);
  assert.ok(await waitFor(() => fake.sent(PICKUP) >= 1), "Continue did not pick the turn up");
  await idle(second, bot);
  const again = await second.fetch(`/api/threads/${bot.threadId}/carry-on`, { method: "POST" });
  assert.equal(again.status, 409);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fake.sent(PICKUP), 1);
  const pickup = fake.state.calls.find((c) => c.includes(PICKUP))!;
  assert.ok(!pickup.includes("Said to you since"), "words set aside as unsent went in anyway");
  messages = await messagesOf(second, bot);
  assert.equal(messages.find((m) => m.id === offered.id).carryOn.done, true, "the button stayed after it was used");
});
