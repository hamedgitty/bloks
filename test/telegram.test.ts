// Who gets an answer, and who does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decide,
  describeCard,
  interpretAnswer,
  nextOffset,
  notDelivered,
  pairingWord,
  parseUpdates,
  type TelegramState,
} from "../server/telegram.ts";

const message = (over: Partial<{ chatId: number; text: string; updateId: number }> = {}) => ({
  chatId: 42,
  from: "Hamed",
  text: "hello",
  updateId: 1,
  ...over,
});

describe("parseUpdates", () => {
  test("a plain message comes through", () => {
    const out = parseUpdates({
      ok: true,
      result: [
        { update_id: 7, message: { chat: { id: 42 }, from: { first_name: "Hamed" }, text: " hi " } },
      ],
    });
    assert.deepEqual(out, [{ chatId: 42, updateId: 7, text: "hi", from: "Hamed" }]);
  });

  test("an edited message counts too", () => {
    const out = parseUpdates({
      result: [{ update_id: 8, edited_message: { chat: { id: 1 }, text: "fixed" } }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "fixed");
  });

  // These used to be skipped, and the offset moved past them, so a
  // photo or a voice message vanished with nothing said to anybody.
  test("voice, photos, files and stickers are kept, each with what it is", () => {
    const out = parseUpdates({
      result: [
        { update_id: 1, message: { chat: { id: 1 }, voice: { file_id: "v", file_size: 900 } } },
        {
          update_id: 2,
          message: {
            chat: { id: 1 },
            caption: " look ",
            photo: [
              { file_id: "big", width: 1280, height: 960, file_size: 90_000 },
              { file_id: "small", width: 90, height: 67 },
            ],
          },
        },
        { update_id: 3, message: { chat: { id: 1 }, document: { file_id: "d", mime_type: "image/png" } } },
        { update_id: 4, message: { chat: { id: 1 }, document: { file_id: "p", mime_type: "application/pdf" } } },
        { update_id: 5, message: { chat: { id: 1 }, sticker: { file_id: "s" } } },
        { update_id: 6, message: { chat: { id: 1 }, video: { file_id: "m" } } },
        { update_id: 7, message: { chat: { id: 1 }, video_note: { file_id: "n" } } },
        // a GIF carries a document too, and is not a file to the person who sent it
        { update_id: 8, message: { chat: { id: 1 }, animation: { file_id: "g" }, document: { file_id: "g" } } },
        { update_id: 9, message: { chat: { id: 1 }, document: { file_id: "h", mime_type: "image/heic" } } },
      ],
    });
    assert.deepEqual(
      out.map((m) => m.media),
      [
        { kind: "voice", fileId: "v", bytes: 900 },
        { kind: "image", fileId: "big", bytes: 90_000, mime: "image/jpeg" },
        { kind: "image", fileId: "d", bytes: 0, mime: "image/png" },
        { kind: "other", what: "files" },
        { kind: "other", what: "stickers" },
        { kind: "other", what: "videos" },
        { kind: "other", what: "video messages" },
        { kind: "other", what: "GIFs" },
        { kind: "other", what: "HEIC images" },
      ],
    );
    assert.equal(out[1].text, "look", "a caption is the photo's text");
  });

  test("photos sent as one album share its id", () => {
    const out = parseUpdates({
      result: [
        { update_id: 1, message: { chat: { id: 1 }, media_group_id: "g1", photo: [{ file_id: "a" }] } },
        { update_id: 2, message: { chat: { id: 1 }, media_group_id: "g1", photo: [{ file_id: "b" }] } },
      ],
    });
    assert.deepEqual(out.map((m) => m.album), ["g1", "g1"]);
  });

  test("joins and other service messages are still skipped", () => {
    const out = parseUpdates({
      result: [
        { update_id: 10, message: { chat: { id: 1 }, new_chat_members: [{}] } },
        { update_id: 11, message: { chat: { id: 1 }, pinned_message: {} } },
      ],
    });
    assert.deepEqual(out, []);
  });

  test("nonsense gives nothing rather than throwing", () => {
    for (const bad of [null, undefined, {}, { result: "no" }, { result: [null, 3] }]) {
      assert.deepEqual(parseUpdates(bad), []);
    }
  });

  test("a very long message is cut", () => {
    const out = parseUpdates({
      result: [{ update_id: 1, message: { chat: { id: 1 }, text: "x".repeat(9000) } }],
    });
    assert.equal(out[0].text.length, 4000);
  });
});

describe("decide", () => {
  test("a known chat is delivered", () => {
    const state: TelegramState = { chatIds: [42] };
    assert.deepEqual(decide(state, message()), { kind: "deliver", chatId: 42, text: "hello" });
  });

  test("a stranger is refused, never delivered", () => {
    const state: TelegramState = { chatIds: [7] };
    assert.equal(decide(state, message()).kind, "refuse");
  });

  test("with no list at all, nobody gets through", () => {
    assert.equal(decide({}, message()).kind, "refuse");
  });

  test("the pairing word claims the bot", () => {
    const state: TelegramState = { pairing: "abc123xy", chatIds: [] };
    assert.deepEqual(decide(state, message({ text: "abc123xy" })), { kind: "pair", chatId: 42 });
  });

  test("a near miss on the pairing word is refused", () => {
    const state: TelegramState = { pairing: "abc123xy", chatIds: [] };
    for (const guess of ["abc123x", "abc123xy!", "ABC123XY", "abc 123xy"]) {
      assert.equal(decide(state, message({ text: guess })).kind, "refuse", `"${guess}" got through`);
    }
  });

  test("a photo captioned with the pairing word does not pair", () => {
    const state: TelegramState = { pairing: "abc123xy", chatIds: [] };
    const media = { kind: "image" as const, fileId: "f", bytes: 1, mime: "image/jpeg" };
    assert.equal(decide(state, { ...message({ text: "abc123xy" }), media }).kind, "refuse");
  });

  test("a known chat's photo is delivered with what it carries", () => {
    const media = { kind: "image" as const, fileId: "f", bytes: 1, mime: "image/jpeg" };
    const decision = decide({ chatIds: [42] }, { ...message(), media, album: "g" });
    assert.deepEqual(decision, { kind: "deliver", chatId: 42, text: "hello", media, album: "g" });
  });

  test("an allowed chat does not need the word once paired", () => {
    const state: TelegramState = { pairing: "abc123xy", chatIds: [42] };
    assert.equal(decide(state, message({ text: "anything" })).kind, "deliver");
  });
});

describe("offsets and pairing words", () => {
  test("the next offset is one past the highest seen", () => {
    assert.equal(nextOffset(0, [message({ updateId: 4 }), message({ updateId: 9 })]), 10);
  });

  test("nothing new leaves the offset alone", () => {
    assert.equal(nextOffset(12, []), 12);
  });

  test("an out of order batch still advances past all of it", () => {
    assert.equal(nextOffset(0, [message({ updateId: 9 }), message({ updateId: 4 })]), 10);
  });

  test("the pairing word avoids characters people misread on a phone", () => {
    const word = pairingWord();
    assert.equal(word.length, 8);
    assert.doesNotMatch(word, /[oil01]/, "0, O, 1, l and i are too easy to mistype");
  });
});

describe("answering a card from a phone", () => {
  const options = ["Allow", "Deny"];

  test("a number picks by position", () => {
    assert.deepEqual(interpretAnswer("2", options), { option: "Deny" });
    assert.deepEqual(interpretAnswer(" 1 ", options), { option: "Allow" });
  });

  test("yes and no map to the first and second option", () => {
    for (const yes of ["yes", "Yes please", "ok", "allow", "approve it"]) {
      assert.deepEqual(interpretAnswer(yes, options), { option: "Allow" }, yes);
    }
    for (const no of ["no", "No thanks", "deny", "decline", "don't"]) {
      assert.deepEqual(interpretAnswer(no, options), { option: "Deny" }, no);
    }
  });

  test("the option's own words work", () => {
    assert.deepEqual(interpretAnswer("deny", ["Approve", "Deny"]), { option: "Deny" });
  });

  test("an out of range number or other text is free text", () => {
    assert.deepEqual(interpretAnswer("9", options), { free: "9" });
    assert.deepEqual(interpretAnswer("Friday works", []), { free: "Friday works" });
  });

  test("a card reads as numbered choices", () => {
    const text = describeCard({ title: "Approval needed", subtitle: "rm -rf build", options });
    assert.match(text, /^Approval needed\nrm -rf build\n\n1\. Allow\n2\. Deny/);
    assert.match(text, /yes \/ no/);
  });
});

describe("what the bot cannot pass on", () => {
  test("every reply says the message did not arrive", () => {
    for (const media of [
      { kind: "voice" as const, fileId: "v", bytes: 1 },
      { kind: "image" as const, fileId: "i", bytes: 1, mime: "image/png" },
      { kind: "other" as const, what: "stickers" },
    ]) {
      assert.match(notDelivered(media), /did not reach your agent/);
    }
    assert.match(notDelivered({ kind: "other", what: "videos" }), /can't take videos/);
  });

  test("a captioned file says its caption was not sent alone", () => {
    assert.match(notDelivered({ kind: "other", what: "files" }, true), /caption was not sent/);
    assert.doesNotMatch(notDelivered({ kind: "other", what: "files" }), /caption/);
  });
});
