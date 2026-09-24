// Shared rooms in Slack and Discord: what the bridge hears, and what it says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, namesAnAgent, outbound, TurnBrake, type ChatLink, type ChatMessage } from "../server/chat-bridge.ts";
import { parseEvent, plainText } from "../server/slack.ts";
import { cleanToken, parseMessage } from "../server/discord.ts";

const link: ChatLink = { platform: "slack", channelId: "C1", channelName: "#launch", declined: ["U_NO"] };
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  platform: "slack",
  channelId: "C1",
  userId: "U_SAM",
  userName: "Sam",
  text: "@Nova draft the taglines",
  addressedBot: false,
  fromBot: false,
  messageId: "1.0",
  ...over,
});
const known = (_p: string, id: string) => (id === "U_SAM" ? "p_sam" : null);
const agents = ["Nova", "Ivy"];

test("a person the owner let in reaches the room when they name an agent", () => {
  assert.deepEqual(decide(link, msg(), known, agents), { kind: "post", personId: "p_sam", text: "@Nova draft the taglines" });
});

test("or when they mention the bot itself", () => {
  const d = decide(link, msg({ text: "what do you think?", addressedBot: true }), known, agents);
  assert.equal(d.kind, "post");
});

test("talk that is not addressed to the agents is never read", () => {
  assert.deepEqual(decide(link, msg({ text: "lunch anyone?" }), known, agents), { kind: "ignore", why: "not-addressed" });
  // a longer name that starts with an agent's is somebody else
  assert.equal(decide(link, msg({ text: "@Novak are you in?" }), known, agents).kind, "ignore");
});

test("bots are never heard, including this bridge's own echoes", () => {
  assert.deepEqual(decide(link, msg({ fromBot: true }), known, agents), { kind: "ignore", why: "bot" });
});

test("a stranger knocks, and someone turned away stays turned away", () => {
  assert.deepEqual(decide(link, msg({ userId: "U_NEW" }), known, agents), { kind: "knock" });
  assert.deepEqual(decide(link, msg({ userId: "U_NO" }), known, agents), { kind: "ignore", why: "declined" });
});

test("only the linked channel on the linked platform counts", () => {
  assert.equal(decide(link, msg({ channelId: "C2" }), known, agents).kind, "ignore");
  assert.equal(decide(link, msg({ platform: "discord" }), known, agents).kind, "ignore");
  assert.equal(decide(null, msg(), known, agents).kind, "ignore");
});

test("agent names match as whole words, any case", () => {
  assert.equal(namesAnAgent("hey @nova, quick one", ["Nova"]), true);
  assert.equal(namesAnAgent("@Chief of Staff please", ["Chief of Staff"]), true);
  assert.equal(namesAnAgent("email nova@example.com", ["Nova"]), false);
});

test("nothing the room says can ping a whole channel", () => {
  assert.doesNotMatch(outbound("slack", { kind: "agent", name: "Nova" }, "done <!channel> <!here>"), /<!/);
  assert.doesNotMatch(outbound("discord", { kind: "agent", name: "Nova" }, "done @everyone @here"), /@everyone|@here/);
});

test("a person's name cannot smuggle markup", () => {
  assert.equal(outbound("slack", { kind: "person", name: "<@U1> Sam" }, "hi"), "&lt;@U1&gt; Sam: hi");
  assert.match(outbound("discord", { kind: "person", name: "@everyone" }, "hi"), /^@​everyone: hi$/);
});

test("the brake lets a steady room through and stops a flood", () => {
  const brake = new TurnBrake(3, 60_000);
  assert.equal(brake.allow("r", 0), true);
  assert.equal(brake.allow("r", 1), true);
  assert.equal(brake.allow("r", 2), true);
  assert.equal(brake.allow("r", 3), false);
  assert.equal(brake.allow("other", 3), true);
  assert.equal(brake.allow("r", 60_001), true);
});

test("Slack: a person's message, a bot's, and things that are not speech", () => {
  const person = parseEvent({ type: "message", channel: "C1", user: "U_SAM", text: "<@UBOT> hi", ts: "1.1" }, "UBOT")!;
  assert.equal(person.addressedBot, true);
  assert.equal(person.fromBot, false);
  assert.equal(parseEvent({ type: "message", channel: "C1", bot_id: "B1", subtype: "bot_message", text: "x", ts: "1" }, "UBOT")!.fromBot, true);
  assert.equal(parseEvent({ type: "message", channel: "C1", user: "UBOT", text: "echo", ts: "1" }, "UBOT")!.fromBot, true);
  assert.equal(parseEvent({ type: "message", subtype: "message_changed", channel: "C1", ts: "1" }, "UBOT"), null);
  assert.equal(parseEvent({ type: "reaction_added" }, "UBOT"), null);
});

test("Slack: markup becomes plain text", () => {
  const names = (id: string) => ({ U2: "Ana" })[id];
  assert.equal(plainText("<@UBOT> ask <@U2> about <https://x.dev|the site> &amp; <#C9|general>", "UBOT", names), "ask @Ana about the site (https://x.dev) & #general");
});

test("Discord: mentions, bots and webhooks", () => {
  const m = parseMessage(
    { id: "9", channel_id: "C1", content: "<@111> ask <@222>", author: { id: "5", username: "sam" }, mentions: [{ id: "111" }, { id: "222", global_name: "Ana" }] },
    "111",
  )!;
  assert.equal(m.addressedBot, true);
  assert.equal(m.text, "ask @Ana");
  assert.equal(m.fromBot, false);
  assert.equal(parseMessage({ id: "1", channel_id: "C1", content: "x", author: { id: "7", bot: true } }, "111")!.fromBot, true);
  assert.equal(parseMessage({ id: "1", channel_id: "C1", content: "x", webhook_id: "w", author: { id: "8" } }, "111")!.fromBot, true);
});

test("Discord: a token is checked for shape and a pasted Bot prefix is dropped", () => {
  const t = "A".repeat(24) + "." + "b".repeat(6) + "." + "c".repeat(38);
  assert.equal(cleanToken(`Bot ${t}`), t);
  assert.equal(cleanToken("nope"), null);
});
