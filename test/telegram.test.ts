// Who gets an answer, and who does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sniffImage } from "../server/attachments.ts";
import { transcribe } from "../server/speech.ts";
import {
  answerPress,
  chatAction,
  decide,
  describeCard,
  download,
  edit,
  Inbox,
  type InboxHooks,
  type Incoming,
  interpretAnswer,
  keepTyping,
  nextOffset,
  notDelivered,
  pairingWord,
  parseUpdates,
  poll,
  post,
  type Press,
  type TelegramState,
  unbutton,
} from "../server/telegram.ts";
import { splitAttachments } from "../src/lib/attachments.ts";

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

  test("a pressed button comes through as a press, with who pressed it and where", () => {
    const out = parseUpdates({
      result: [
        {
          update_id: 12,
          callback_query: {
            id: "press-1",
            from: { id: 77, first_name: "Hamed" },
            message: { message_id: 5, chat: { id: 42 } },
            data: "abcdEFGH:1",
          },
        },
      ],
    });
    assert.deepEqual(out, [
      { chatId: 42, updateId: 12, text: "", from: "Hamed", press: { id: "press-1", data: "abcdEFGH:1", messageId: 5, fromId: 77 } },
    ]);
  });

  test("a press that cannot say what it carried, or who made it, is nothing", () => {
    const out = parseUpdates({
      result: [
        { update_id: 1, callback_query: { id: "p", from: { id: 1 }, message: { message_id: 5, chat: { id: 1 } } } },
        { update_id: 2, callback_query: { id: "p", message: { message_id: 5, chat: { id: 1 } }, data: "x" } },
        { update_id: 3, callback_query: { id: "p", from: { id: 1 }, inline_message_id: "i", data: "x" } },
      ],
    });
    assert.deepEqual(out, []);
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

  const press = (chatId: number, fromId: number) => ({
    ...message({ chatId, text: "" }),
    press: { id: "p", data: "abcdEFGH:0", messageId: 5, fromId },
  });

  test("a button pressed by the paired person, in their chat, is a press", () => {
    assert.deepEqual(decide({ chatIds: [42] }, press(42, 42)), {
      kind: "press",
      chatId: 42,
      press: { id: "p", data: "abcdEFGH:0", messageId: 5, fromId: 42 },
    });
  });

  test("a button pressed by anyone else in a paired chat is ignored, not answered", () => {
    // a group the bot was paired in shows its buttons to every member
    assert.deepEqual(decide({ chatIds: [-100] }, press(-100, 7)), { kind: "ignore" });
  });

  test("a button pressed in a chat that is not paired is ignored, without a refusal", () => {
    assert.deepEqual(decide({ chatIds: [42] }, press(9, 9)), { kind: "ignore" });
    // not even the pairing word is read from a press
    assert.deepEqual(decide({ chatIds: [], pairing: "abc123xy" }, { ...press(9, 9), text: "abc123xy" }), { kind: "ignore" });
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

  test("a card sent with buttons is only what it asks, since the choices are under it", () => {
    assert.equal(describeCard({ title: "Approval needed", subtitle: "rm -rf build", options }, true), "Approval needed\nrm -rf build");
    // a question with nothing to tap still asks to be typed
    assert.match(describeCard({ title: "Your agent has a question", subtitle: "Which day?" }, true), /Reply with your answer\.$/);
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

  test("a captioned file says its caption went on without it", () => {
    assert.match(notDelivered({ kind: "other", what: "files" }, true), /Your caption went to your agent without it/);
    assert.match(notDelivered({ kind: "voice", fileId: "v", bytes: 1 }, true), /Your caption went to your agent without it/);
    assert.doesNotMatch(notDelivered({ kind: "other", what: "files" }), /caption/);
  });
});

// ── the inbox, with Telegram, the vendors and the disk all stood in for ──

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9]);

/** An inbox whose every outside call is recorded. `over` swaps any hook. */
function inbox(over: Partial<InboxHooks> = {}, card?: { options: string[]; permission: boolean }) {
  const seen = {
    sent: [] as string[],
    delivered: [] as string[],
    downloads: [] as string[],
    heard: 0,
    answers: [] as { option?: string; free?: string }[],
    refused: 0,
    presses: [] as Press[],
  };
  let waiting = card;
  const hooks: InboxHooks = {
    state: () => ({ chatIds: [42] }),
    send: async (_chatId, text) => void seen.sent.push(text),
    pair: async () => {},
    refuse: async () => void seen.refused++,
    download: async (fileId) => {
      seen.downloads.push(fileId);
      return fileId.startsWith("voice") ? OGG : PNG;
    },
    transcriber: () => async () => {
      seen.heard++;
      return "meet Siobhan at 4:15";
    },
    saveImage: (bytes) => {
      if (!sniffImage(bytes)) throw new Error("only png, jpeg, gif and webp images are taken");
      return `/home/me/.bloks/attachments/${seen.downloads.length}.png`;
    },
    saveVoice: () => "/home/me/.bloks/attachments/v.ogg",
    waiting: () => waiting,
    answer: async (_chatId, read) => {
      seen.answers.push(read);
      waiting = undefined;
    },
    deliver: (_chatId, text) => void seen.delivered.push(text),
    press: async (_chatId, press) => void seen.presses.push(press),
    ...over,
  };
  return { box: new Inbox(hooks, 5), seen };
}

const voice = (over: Partial<Incoming> = {}): Incoming => ({
  ...message(),
  text: "",
  media: { kind: "voice", fileId: "voice-1", bytes: 6 },
  ...over,
});
const photo = (fileId: string, over: Partial<Incoming> = {}): Incoming => ({
  ...message(),
  text: "",
  media: { kind: "image", fileId, bytes: 7, mime: "image/jpeg" },
  ...over,
});

describe("the inbox", () => {
  test("a press from the paired person goes to the card it is for, and a stranger's goes nowhere", async () => {
    const { box, seen } = inbox();
    const pressed = { id: "p1", data: "abcdEFGH:0", messageId: 5, fromId: 42 };
    await box.take({ ...message({ text: "" }), press: pressed });
    assert.deepEqual(seen.presses, [pressed]);
    await box.take({ ...message({ chatId: 9, text: "" }), press: { ...pressed, fromId: 9 } });
    assert.equal(seen.presses.length, 1);
    assert.equal(seen.refused, 0, "a stranger's press is not even refused");
    assert.deepEqual(seen.delivered, [], "and a press is never a message to the agent");
  });

  test("a stranger's voice and photos are never downloaded or heard", async () => {
    const { box, seen } = inbox({ state: () => ({ chatIds: [7] }) });
    await box.take(voice());
    await box.take(photo("p1"));
    await box.take(photo("p2", { album: "g" }));
    await box.flush();
    assert.deepEqual(seen.downloads, []);
    assert.equal(seen.heard, 0);
    assert.deepEqual(seen.delivered, []);
    assert.equal(seen.refused, 3, "each goes to the same refusal as text, which the server sends once");
  });

  test("a voice message arrives as its transcript, marked, with the audio kept", async () => {
    const { box, seen } = inbox();
    await box.take(voice());
    assert.deepEqual(seen.downloads, ["voice-1"]);
    assert.equal(seen.delivered.length, 1);
    const said = seen.delivered[0];
    // the agent is told it was heard, so it takes care over names and numbers
    assert.match(said, /<voice-message path="\/home\/me\/\.bloks\/attachments\/v\.ogg" note="Transcribed from a voice message\./);
    assert.match(said, /misheard/);
    // and the thread shows the words with the recording beside them
    const { display, voice: audio } = splitAttachments(said);
    assert.equal(display, "meet Siobhan at 4:15");
    assert.deepEqual(audio, ["/home/me/.bloks/attachments/v.ogg"]);
    assert.deepEqual(seen.sent, []);
  });

  test("with no speech key a voice message is answered, not delivered", async () => {
    const { box, seen } = inbox({ transcriber: () => null });
    await box.take(voice());
    assert.deepEqual(seen.delivered, []);
    assert.deepEqual(seen.downloads, [], "nothing to hear it with, so nothing is fetched");
    assert.match(seen.sent[0], /did not reach your agent\. Add a speech key in Bloks Settings, or type it/);
  });

  test("a transcription that fails says so and why", async () => {
    const { box, seen } = inbox({
      transcriber: () => async () => {
        throw new Error("OpenAI answered 401");
      },
    });
    await box.take(voice());
    assert.deepEqual(seen.delivered, []);
    assert.match(seen.sent[0], /couldn't transcribe that voice message \(OpenAI answered 401\), so it did not reach your agent/);
  });

  test("a download that fails says so", async () => {
    const { box, seen } = inbox({
      download: async () => {
        throw new Error("Telegram answered HTTP 400");
      },
    });
    await box.take(voice());
    await box.take(photo("p1"));
    assert.deepEqual(seen.delivered, []);
    assert.equal(seen.sent.length, 2);
    for (const said of seen.sent) assert.match(said, /Telegram answered HTTP 400.*did not reach your agent/);
  });

  test("silence is not sent on as an empty message", async () => {
    const { box, seen } = inbox({ transcriber: () => async () => "  " });
    await box.take(voice());
    assert.deepEqual(seen.delivered, []);
    assert.match(seen.sent[0], /couldn't make out any words/);
  });

  test("a photo arrives like a pasted image, with its caption as the text", async () => {
    const { box, seen } = inbox();
    await box.take(photo("p1", { text: "what is this plant?" }));
    assert.equal(seen.delivered.length, 1);
    const { display, images } = splitAttachments(seen.delivered[0]);
    assert.equal(display, "what is this plant?");
    assert.deepEqual(images, ["/home/me/.bloks/attachments/1.png"]);
  });

  test("an image over the app's 10 MB limit is refused without a download", async () => {
    const { box, seen } = inbox();
    await box.take(photo("p1", { media: { kind: "image", fileId: "p1", bytes: 11 * 1024 * 1024, mime: "image/png" } }));
    assert.deepEqual(seen.downloads, []);
    assert.deepEqual(seen.delivered, []);
    assert.match(seen.sent[0], /over 10 MB/);
  });

  test("something that is not really an image is refused, not saved", async () => {
    const { box, seen } = inbox({ download: async () => OGG });
    await box.take(photo("p1"));
    assert.deepEqual(seen.delivered, []);
    assert.match(seen.sent[0], /only png, jpeg, gif and webp/);
  });

  test("an album arrives as one message, not one turn per photo", async () => {
    const { box, seen } = inbox();
    await box.take(photo("p1", { album: "g", text: "the kitchen, before and after" }));
    await box.take(photo("p2", { album: "g" }));
    // Telegram can split an album across polls; the inbox waits for it
    assert.deepEqual(seen.delivered, []);
    await box.take(photo("p3", { album: "g" }));
    await box.flush();
    assert.equal(seen.delivered.length, 1);
    const { display, images } = splitAttachments(seen.delivered[0]);
    assert.equal(display, "the kitchen, before and after");
    assert.equal(images.length, 3);
    assert.deepEqual(seen.sent, []);
  });

  test("an album lets itself go after a short wait, without being asked", async () => {
    const { box, seen } = inbox();
    await box.take(photo("p1", { album: "g" }));
    await box.take(photo("p2", { album: "g" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(seen.delivered.length, 1);
  });

  test("an album with a video in it delivers the photos and says what was left out", async () => {
    const { box, seen } = inbox();
    await box.take(photo("p1", { album: "g" }));
    await box.take({ ...message(), text: "", album: "g", media: { kind: "other", what: "videos" } });
    await box.flush();
    assert.equal(splitAttachments(seen.delivered[0]).images.length, 1);
    assert.match(seen.sent[0], /1 of those 2 did not reach your agent \(I can't take videos\)/);
  });

  test("stickers, videos and other files get a reply and go nowhere", async () => {
    const { box, seen } = inbox();
    for (const what of ["stickers", "videos", "video messages", "files"]) {
      await box.take({ ...message(), text: "", media: { kind: "other", what } });
    }
    assert.deepEqual(seen.delivered, []);
    assert.deepEqual(seen.downloads, []);
    assert.equal(seen.sent.length, 4);
    assert.match(seen.sent[0], /can't take stickers here, so that did not reach your agent/);
  });

  test("a video's caption reaches the agent, marked, and the person is told", async () => {
    const { box, seen } = inbox();
    await box.take({ ...message(), text: "what is wrong with this hinge?", media: { kind: "other", what: "videos" } });
    assert.deepEqual(seen.delivered, [
      "what is wrong with this hinge?\n\n[Something came with this that did not arrive (Bloks can't take videos from Telegram).]",
    ]);
    assert.deepEqual(seen.sent, ["I can't take videos here. Your caption went to your agent without it."]);
  });

  test("a voice message can answer a question", async () => {
    const { box, seen } = inbox({}, { options: [], permission: false });
    await box.take(voice());
    assert.deepEqual(seen.answers, [{ free: "meet Siobhan at 4:15" }]);
    assert.deepEqual(seen.delivered, [], "an answer is not also a new message");
    assert.deepEqual(seen.sent, ["Sent."]);
  });

  test("a voice message cannot answer an approval, and is not even sent to be heard", async () => {
    // a misheard "no" would be a "yes" to something that runs on this machine
    const { box, seen } = inbox({}, { options: ["Allow", "Deny"], permission: true });
    await box.take(voice());
    assert.deepEqual(seen.answers, []);
    assert.equal(seen.heard, 0);
    assert.match(seen.sent[0], /typed answer/);
    // typing it still works
    await box.take(message({ text: "yes" }));
    assert.deepEqual(seen.answers, [{ option: "Allow" }]);
  });

  test("a photo is never an answer to a card; it goes to the agent", async () => {
    const { box, seen } = inbox({}, { options: [], permission: false });
    await box.take(photo("p1", { text: "this one" }));
    assert.deepEqual(seen.answers, []);
    assert.equal(seen.delivered.length, 1);
  });

  // What #210 was about: the photo timed out, and the caption, which is
  // the part that is hard to type again on a phone, went with it.
  test("a photo that cannot be taken still sends its caption on, saying what is missing", async () => {
    const { box, seen } = inbox({
      download: async () => {
        throw new Error("timed out");
      },
    });
    await box.take(photo("p1", { text: "what do you make of this?" }));
    assert.deepEqual(seen.delivered, ["what do you make of this?\n\n[A photo came with this and did not arrive (timed out).]"]);
    assert.deepEqual(seen.sent, ["I couldn't take that photo (timed out). Your caption went to your agent without it."]);
  });

  test("a caption whose photo is missing is a new message, never the answer to a card", async () => {
    const { box, seen } = inbox(
      {
        download: async () => {
          throw new Error("timed out");
        },
      },
      { options: [], permission: false },
    );
    await box.take(photo("p1", { text: "yes" }));
    assert.deepEqual(seen.answers, []);
    assert.equal(seen.delivered.length, 1);
  });

  test("an uncaptioned photo that cannot be taken is answered as before", async () => {
    const { box, seen } = inbox({
      download: async () => {
        throw new Error("timed out");
      },
    });
    await box.take(photo("p1"));
    assert.deepEqual(seen.delivered, []);
    assert.deepEqual(seen.sent, ["I couldn't take that photo (timed out), so it did not reach your agent."]);
  });

  test("the agent is told which of an album's photos did not arrive", async () => {
    const { box, seen } = inbox({
      download: async (fileId) => {
        if (fileId === "p2") throw new Error("timed out");
        return PNG;
      },
    });
    await box.take(photo("p1", { album: "g", text: "the kitchen" }));
    await box.take(photo("p2", { album: "g" }));
    await box.take(photo("p3", { album: "g" }));
    await box.flush();
    const { display, images } = splitAttachments(seen.delivered[0]!);
    assert.equal(images.length, 2);
    assert.equal(display, "the kitchen\n\n[1 of 3 photos did not arrive (timed out).]");
    assert.match(seen.sent[0]!, /1 of those 3 did not reach your agent \(timed out\)\. The rest did\./);
  });

  test("an album where nothing arrived still sends its caption", async () => {
    const { box, seen } = inbox({
      download: async () => {
        throw new Error("timed out");
      },
    });
    await box.take(photo("p1", { album: "g", text: "before and after" }));
    await box.take(photo("p2", { album: "g" }));
    await box.flush();
    assert.deepEqual(seen.delivered, ["before and after\n\n[2 photos came with this and none of them arrived (timed out).]"]);
    assert.match(seen.sent[0]!, /None of those 2 reached your agent \(timed out\)\. Your caption went without them\./);
  });

  test("a transcribed voice message keeps its caption, first", async () => {
    const { box, seen } = inbox();
    await box.take(voice({ text: "for the shopping list" }));
    const { display, voice: audio } = splitAttachments(seen.delivered[0]!);
    assert.equal(display, "for the shopping list\n\nmeet Siobhan at 4:15");
    assert.equal(audio.length, 1);
    assert.match(seen.delivered[0]!, /note="Typed caption first, then transcribed/);
  });

  test("a voice message that cannot be heard still sends its caption on", async () => {
    const { box, seen } = inbox({ transcriber: () => null });
    await box.take(voice({ text: "for the shopping list" }));
    assert.deepEqual(seen.delivered, [
      "for the shopping list\n\n[A voice message came with this and did not arrive (there is no speech key to transcribe it).]",
    ]);
    assert.match(seen.sent[0]!, /Your caption went to your agent without it/);
  });

  test("a captioned voice message while an approval waits still asks for typing, and sends nothing", async () => {
    const { box, seen } = inbox({}, { options: ["Allow", "Deny"], permission: true });
    await box.take(voice({ text: "go ahead" }));
    assert.deepEqual(seen.delivered, []);
    assert.deepEqual(seen.answers, []);
    assert.match(seen.sent[0]!, /typed answer/);
  });

  test("typed text still answers a card, and still asks again on an unclear approval", async () => {
    const { box, seen } = inbox({}, { options: ["Allow", "Deny"], permission: true });
    await box.take(message({ text: "hmm, what does it do?" }));
    assert.deepEqual(seen.answers, []);
    assert.deepEqual(seen.sent, ["Reply 1 or 2, or yes / no."]);
    await box.take(message({ text: "2" }));
    assert.deepEqual(seen.answers, [{ option: "Deny" }]);
  });
});

describe("files and speech over the wire", () => {
  test("a file is fetched by asking where it is, then from there", async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "voice/file_3.oga", file_size: 6 } });
      }
      return new Response(OGG);
    });
    const bytes = await download("T0KEN", "abc", 1_000);
    assert.deepEqual([...bytes], [...OGG]);
    assert.deepEqual(urls, [
      "https://api.telegram.org/botT0KEN/getFile",
      "https://api.telegram.org/file/botT0KEN/voice/file_3.oga",
    ]);
  });

  test("a file bigger than allowed is not downloaded at all", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 50 * 1024 * 1024 } });
    });
    await assert.rejects(download("T", "abc", 20 * 1024 * 1024), /over 20 MB/);
    assert.equal(calls, 1);
  });

  test("a download that times out is tried once more", async (t) => {
    let getFile = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/getFile")) {
        getFile++;
        if (getFile === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        return Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 6 } });
      }
      return new Response(OGG);
    });
    assert.deepEqual([...(await download("T", "abc", 1_000))], [...OGG]);
    assert.equal(getFile, 2);
  });

  test("a connection that drops twice gives up, and says so plainly", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      calls++;
      if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 6 } });
      throw new TypeError("fetch failed");
    });
    await assert.rejects(download("T", "abc", 1_000), (error: Error) => error.message === "the connection dropped");
    assert.equal(calls, 4, "two tries of two calls each, and no third");
  });

  test("a file Telegram refuses is not tried again", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("{}", { status: 400 });
    });
    await assert.rejects(download("T", "abc", 1_000), /HTTP 400/);
    assert.equal(calls, 1);
  });

  test("a voice note goes to the vendor named .ogg, with the vendor's model", async (t) => {
    const sent: { url: string; form: FormData; headers: Record<string, string> }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, form: init.body as FormData, headers: init.headers as Record<string, string> });
      return Response.json({ text: " hello there ", languages: [{ code: "en" }] });
    });
    assert.equal(await transcribe({ speech: { openaiKey: "sk-test" } }, OGG, "voice.ogg", "audio/ogg"), "hello there");
    assert.equal(await transcribe({ speech: { elevenlabsKey: "el-test" } }, OGG, "voice.ogg", "audio/ogg"), "hello there");
    assert.equal(sent[0].url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(sent[0].form.get("model"), "gpt-transcribe");
    assert.deepEqual([...(sent[0].form as unknown as Iterable<[string, unknown]>)].map(([key]) => key).sort(), ["file", "model"]);
    const file = sent[0].form.get("file") as File;
    assert.equal(file.name, "voice.ogg");
    assert.equal(file.type, "audio/ogg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), OGG);
    assert.equal(sent[0].headers.authorization, "Bearer sk-test");
    assert.equal(sent[1].url, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(sent[1].form.get("model_id"), "scribe_v2");
    assert.equal(sent[1].headers["xi-api-key"], "el-test");
  });

  test("a vendor that refuses is an error carrying only its status", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("{\"error\":\"key sk-secret is wrong\"}", { status: 401 }));
    await assert.rejects(transcribe({ speech: { openaiKey: "sk-test" } }, OGG, "voice.ogg", "audio/ogg"), (error: Error) => {
      assert.equal(error.message, "OpenAI answered 401");
      return true;
    });
  });
});

describe("typing while the agent works", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // a loaded machine runs a 10 ms interval late, never early: wait for the
  // ticks themselves, up to a bound, rather than for the time they should take
  const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await wait(10); };

  test("says typing at once, then again and again until the turn ends", async () => {
    let said = 0;
    const typing = keepTyping(async () => void said++, () => false, 10);
    await wait(0);
    assert.equal(said, 1, "at once, not one interval in");
    await until(() => said >= 3);
    assert.ok(said >= 3);
    await typing.stop();
    const stopped = said;
    await wait(40);
    assert.equal(said, stopped, "nothing after the turn ends");
  });

  test("goes quiet while a card waits for the person, and picks up when it is answered", async () => {
    let said = 0;
    let waiting = false;
    const typing = keepTyping(async () => void said++, () => waiting, 10);
    await wait(0);
    waiting = true;
    const before = said;
    await wait(40);
    assert.equal(said, before, "typing would say the agent is working when it is waiting on them");
    waiting = false;
    await until(() => said > before);
    assert.ok(said > before, "and it comes back once the card is answered");
    await typing.stop();
  });

  test("an answered card brings typing back at once, not a tick later", async () => {
    let said = 0;
    const typing = keepTyping(async () => void said++, () => false, 60_000);
    await wait(0);
    typing.now();
    await wait(0);
    assert.equal(said, 2);
    await typing.stop();
  });

  test("a chat action that fails is ignored", async () => {
    const typing = keepTyping(
      async () => {
        throw new Error("Telegram answered HTTP 403");
      },
      () => false,
      10,
    );
    await wait(25);
    await typing.stop();
  });

  test("stopping waits for one already on its way, so it cannot land after the answer", async () => {
    let landed = false;
    const typing = keepTyping(
      async () => {
        await wait(20);
        landed = true;
      },
      () => false,
      1_000,
    );
    await typing.stop();
    assert.equal(landed, true);
  });

  test("the action is typing, to the chat that asked", async (t) => {
    const bodies: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.match(url, /\/sendChatAction$/);
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, result: true });
    });
    await chatAction("T", 42);
    assert.deepEqual(bodies, [{ chat_id: 42, action: "typing" }]);
  });
});

describe("buttons over the wire", () => {
  /** Every call made, by method, with its body. */
  function wire(t: { mock: { method: (...args: any[]) => unknown } }, result: unknown = true) {
    const calls: { method: string; body: any }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ method: url.split("/").pop()!, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, result });
    });
    return calls;
  }

  test("polling asks for presses as well as messages", async (t) => {
    const calls = wire(t, []);
    await poll("T", 3);
    assert.deepEqual(calls[0].body.allowed_updates, ["message", "callback_query"]);
  });

  test("a card goes with its buttons, and comes back with the id of the message it became", async (t) => {
    const calls = wire(t, { message_id: 81 });
    const keyboard = { inline_keyboard: [[{ text: "Allow", callback_data: "abcdEFGH:0" }]] };
    assert.equal(await post("T", 42, "Approval needed", keyboard), 81);
    assert.deepEqual(calls[0], { method: "sendMessage", body: { chat_id: 42, text: "Approval needed", reply_markup: keyboard } });
  });

  test("an answered card is rewritten without its buttons, and the press is answered", async (t) => {
    const calls = wire(t);
    await edit("T", 42, 81, "Approval needed\n\nAllowed");
    await answerPress("T", "press-1", "Allowed");
    await unbutton("T", 42, 82);
    assert.deepEqual(calls, [
      { method: "editMessageText", body: { chat_id: 42, message_id: 81, text: "Approval needed\n\nAllowed", reply_markup: { inline_keyboard: [] } } },
      { method: "answerCallbackQuery", body: { callback_query_id: "press-1", text: "Allowed" } },
      { method: "editMessageReplyMarkup", body: { chat_id: 42, message_id: 82, reply_markup: { inline_keyboard: [] } } },
    ]);
  });
});
