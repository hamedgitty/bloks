// WhatsApp groups: what a webhook becomes, and what is refused.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { decide, outbound } from "../server/chat-bridge.ts";
import { cleanAppSecret, cleanPhoneNumberId, parseWebhook, verifySignature } from "../server/whatsapp.ts";

const OWN = "+1 555 010 0000";
const hook = (messages: unknown[], contacts: unknown[] = []) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts, messages } }] }],
});

describe("whatsapp", () => {
  test("a group text becomes a room message, with the business number's mention lifted", () => {
    const [m] = parseWebhook(
      hook(
        [{ from: "447700900123", id: "wamid.1", type: "text", group_id: "G1@g.us", text: { body: "@15550100000 can Nova draft the brief?" } }],
        [{ wa_id: "447700900123", profile: { name: "Sam" } }],
      ),
      OWN,
    );
    assert.equal(m.platform, "whatsapp");
    assert.equal(m.channelId, "G1@g.us");
    assert.equal(m.userName, "Sam");
    assert.equal(m.addressedBot, true);
    assert.equal(m.text, "can Nova draft the brief?");
    assert.equal(m.fromBot, false);
  });

  test("one to one chats, statuses and media are not for a room", () => {
    const out = parseWebhook(
      hook([
        { from: "1", id: "a", type: "text", text: { body: "hi" } },
        { from: "1", id: "b", type: "image", group_id: "G1", image: {} },
      ]),
      OWN,
    );
    assert.equal(out.length, 0);
    assert.equal(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }, OWN).length, 0);
    assert.equal(parseWebhook(null, OWN).length, 0);
  });

  test("the number's own echo is a bot, and never starts a turn", () => {
    const [m] = parseWebhook(hook([{ from: "15550100000", id: "e", type: "text", group_id: "G1", text: { body: "*Nova* hello" } }]), OWN);
    assert.equal(m.fromBot, true);
    const d = decide({ platform: "whatsapp", channelId: "G1", channelName: "Launch" }, m, () => "p1", ["Nova"]);
    assert.deepEqual(d, { kind: "ignore", why: "bot" });
  });

  test("only a call Meta signed with the app secret is believed", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const body = JSON.stringify(hook([]));
    const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(verifySignature(body, good, secret), true);
    assert.equal(verifySignature(`${body} `, good, secret), false);
    assert.equal(verifySignature(body, good, "f".repeat(32)), false);
    assert.equal(verifySignature(body, "sha1=abc", secret), false);
    assert.equal(verifySignature(body, undefined, secret), false);
  });

  test("the room reads well in a group, and a name cannot carry formatting", () => {
    assert.equal(outbound("whatsapp", { kind: "agent", name: "Nova" }, "Done."), "*Nova* Done.");
    assert.equal(outbound("whatsapp", { kind: "notice" }, "Nova is waiting"), "_Nova is waiting_");
    assert.equal(outbound("whatsapp", { kind: "person", name: "*Sam*" }, "hi"), "Sam: hi");
  });

  test("setup values are checked before Meta is asked anything", () => {
    assert.equal(cleanPhoneNumberId(" 106540352242922 "), "106540352242922");
    assert.equal(cleanPhoneNumberId("+1 555 0100"), null);
    assert.equal(cleanAppSecret("0123456789abcdef0123456789ABCDEF"), "0123456789abcdef0123456789ABCDEF");
    assert.equal(cleanAppSecret("short"), null);
  });
});
