// Who gets an answer, and who does not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sniffImage } from "../server/attachments.ts";
import { transcribe } from "../server/speech.ts";
import {
  decide,
  describeCard,
  download,
  Inbox,
  type InboxHooks,
  type Incoming,
  interpretAnswer,
  nextOffset,
  notDelivered,
  pairingWord,
  parseUpdates,
  type TelegramState,
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
      await box.take({ ...message(), text: "see this", media: { kind: "other", what } });
    }
    assert.deepEqual(seen.delivered, [], "a caption is not sent on its own");
    assert.deepEqual(seen.downloads, []);
    assert.equal(seen.sent.length, 4);
    assert.match(seen.sent[0], /can't take stickers here.*caption was not sent/);
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

  test("a voice note goes to the vendor named .ogg, with the vendor's model", async (t) => {
    const sent: { url: string; form: FormData; headers: Record<string, string> }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, form: init.body as FormData, headers: init.headers as Record<string, string> });
      return Response.json({ text: " hello there " });
    });
    assert.equal(await transcribe({ speech: { openaiKey: "sk-test" } }, OGG, "voice.ogg", "audio/ogg"), "hello there");
    assert.equal(await transcribe({ speech: { elevenlabsKey: "el-test" } }, OGG, "voice.ogg", "audio/ogg"), "hello there");
    assert.equal(sent[0].url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(sent[0].form.get("model"), "gpt-4o-transcribe");
    assert.equal((sent[0].form.get("file") as File).name, "voice.ogg");
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
