// Group reply tools through the actual API driver, with loopback providers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { personFixture, SAM, until } from "./helpers/telegram-person.ts";

async function apiFixture(t: TestContext, kind: "deepseek" | "ollama", mode: "reply" | "limit" | "secret" = "reply") {
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}"); bodies.push(body);
    if (mode === "limit") { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: "Rate limit reached. Please try again in 20m" } })); }
    const continuing = mode === "secret" && body.messages?.some((m: any) => String(m.content).includes('The user saved "Synthetic service key"'));
    const latestUser = body.messages?.findLastIndex((m: any) => m.role === "user") ?? -1;
    const replied = body.messages?.slice(latestUser + 1).some((m: any) => m.role === "tool");
    const message = replied ? { role: "assistant", content: "Private final answer." } : { role: "assistant", tool_calls: [
      { id: "group-reply", type: "function", function: mode === "secret" && !continuing ? { name: "request_secret", arguments: JSON.stringify({ name: "Synthetic service key" }) } : { name: "reply_to_sender", arguments: JSON.stringify({ text: "API group answer" }) } },
    ] };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const f = await personFixture(t);
  const url = `http://127.0.0.1:${(provider.address() as any).port}`;
  await f.post(`/api/providers/${kind}/connect`, { url, ...(kind === "deepseek" ? { key: "sk-test-loopback-only-1111" } : {}) });
  await f.ownerJson(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: kind, model: "m-1" }, backupSelection: null }) });
  const group = () => f.say("@PlanningBot API_GROUP_WORDS", SAM, { chat: { id: -7001, type: "supergroup", title: "Planning group" }, entities: [{ type: "mention", offset: 0, length: 12 }], is_topic_message: true, message_thread_id: 9 });
  return { f, bodies, group };
}

test("an owner API group turn replies through its bound tool and keeps the final text in the app", async (t) => {
  const { f, bodies, group } = await apiFixture(t, "deepseek");
  const anchor = group();
  const sent = await until(() => f.sent(-7001).find((c) => c.body.text === "API group answer"), "the API tool did not reply in the group");
  await f.idle();
  assert.deepEqual(sent.body.reply_parameters, { message_id: anchor }); assert.equal(sent.body.message_thread_id, 9);
  assert.equal(bodies.length, 2);
  const schema = bodies[0].tools.find((tool: any) => tool.function?.name === "reply_to_sender");
  assert.equal(schema.function.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.function.parameters.properties), ["text"]);
  assert.match(JSON.stringify(bodies[0]), /every member sees it/);
  assert.equal(f.sent(-7001).some((c) => c.body.text === "Private final answer."), false);
  assert.ok((await f.messages()).some((m) => m.text === "Private final answer."));
});

test("an owner API without tools visibly holds a group turn before any completion", async (t) => {
  const { f, bodies, group } = await apiFixture(t, "ollama");
  const anchor = group();
  await until(async () => (await f.messages()).some((m) => m.kind === "notice" && m.text?.includes("cannot reply in Telegram groups")), "the owner saw no reason for the hold");
  const notice = await until(() => f.sent(-7001).find((c) => c.body.text.includes("cannot answer from Telegram yet")), "the group got no neutral hold notice");
  assert.deepEqual(notice.body.reply_parameters, { message_id: anchor }); assert.equal(notice.body.message_thread_id, 9);
  assert.doesNotMatch(notice.body.text, /tools|ollama|engine settings/i);
  assert.equal(bodies.length, 0); assert.equal(f.sent(-7001).length, 1);
});

test("an owner group's automatic fallback retains its return audience", async (t) => {
  const { f, bodies, group } = await apiFixture(t, "deepseek", "limit");
  await f.ownerJson(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const anchor = group();
  const sent = await until(() => f.sent(-7001).find((c) => c.body.text === "Hello Lee"), "fallback did not retain the group reply");
  await f.idle();
  assert.equal(bodies.length, 1);
  assert.deepEqual(sent.body.reply_parameters, { message_id: anchor }); assert.equal(sent.body.message_thread_id, 9);
  const turn = f.records().find((r) => r.kind === "claude" && r.text?.includes("API_GROUP_WORDS"));
  assert.equal(turn.person, false); assert.equal(turn.groupOwner, true);
  assert.equal((await f.messages()).filter((m) => m.role === "user" && m.text?.includes("API_GROUP_WORDS")).length, 1);
});

test("saving an owner group's secret card continues with the card's bound audience", async (t) => {
  const { f, group } = await apiFixture(t, "deepseek", "secret");
  const anchor = group();
  const card = await until(async () => (await f.messages()).find((m) => m.kind === "secret"), "the group turn did not ask for a key");
  await f.idle();
  assert.equal(card.telegramGroup.chatId, -7001);
  await f.post(`/api/bots/${f.bot.id}/secret-cards/${card.id}/save`, { value: "synthetic_fixture_value" });
  const sent = await until(() => f.sent(-7001).find((c) => c.body.text === "API group answer"), "saving the group card lost the reply audience");
  await f.idle();
  assert.deepEqual(sent.body.reply_parameters, { message_id: anchor }); assert.equal(sent.body.message_thread_id, 9);
  assert.equal(JSON.stringify(await f.messages()).includes("synthetic_fixture_value"), false);
});
