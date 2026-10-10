// Account-free intake: only fake Telegram metadata and planted file bytes.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { saveBytes, saveImage, serveAttachment, VOICE_MAX_BYTES } from "../server/attachments.ts";
import { DATA_DIR } from "../server/config.ts";
import { download, Inbox, type InboxHooks, type Incoming, parseUpdates } from "../server/telegram.ts";
import { composeOutgoing, fileAttachment, splitAttachments } from "../src/lib/attachments.ts";

const FILE = new Uint8Array([1, 2, 3, 4, 5]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
const MB = 1024 * 1024;
const incoming = (fields: Record<string, unknown>, chatId = 42): Incoming => {
  const out = parseUpdates({ result: [{ update_id: 1, message: { chat: { id: chatId }, ...fields } }] });
  assert.equal(out.length, 1, "media is retained by the parser");
  return out[0]!;
};
const video = (over: Record<string, unknown> = {}) => ({ file_id: "clip", file_size: 5, mime_type: "video/mp4", ...over });
const document = (over: Record<string, unknown> = {}) => ({ file_id: "doc", file_size: 5, mime_type: "application/pdf", file_name: "notes.pdf", ...over });

function fixture(t: TestContext, over: Partial<InboxHooks> = {}) {
  const seen = {
    download: [] as { id: string; max: number }[], saved: [] as string[], delivered: [] as { chat: number; text: string }[],
    replies: [] as string[], answers: [] as { option?: string; free?: string }[], refused: 0, heard: 0,
  };
  let card: { options: string[]; permission: boolean } | undefined;
  const keep = (bytes: Uint8Array, ext: string) => {
    const path = saveBytes(bytes, ext);
    seen.saved.push(path);
    return path;
  };
  const hooks: InboxHooks = {
    state: () => ({ chatIds: [42, 43] }),
    send: async (_chat, text) => { seen.replies.push(text); }, pair: async () => {}, refuse: async () => { seen.refused++; },
    download: async (id, max) => { seen.download.push({ id, max }); return id === "photo" ? PNG : FILE; },
    transcriber: () => async () => { seen.heard++; return "heard words"; },
    saveImage: (bytes) => { const path = saveImage(bytes); seen.saved.push(path); return path; },
    saveVoice: (bytes) => keep(bytes, "ogg"), saveFile: keep,
    press: async () => {},
    waiting: () => card,
    answer: async (_chat, read) => { seen.answers.push(read); card = undefined; },
    deliver: (chat, text) => { seen.delivered.push({ chat, text }); }, ...over,
  };
  t.after(() => { seen.saved.forEach((path) => rmSync(path, { force: true })); });
  return { box: new Inbox(hooks, 5), seen, setCard: (permission: boolean) => { card = { permission, options: ["Allow", "Deny"] }; }, card: () => card };
}

function filePath(f: ReturnType<typeof fixture>) {
  assert.equal(f.seen.delivered.length, 1, "one agent message");
  const parsed = splitAttachments(f.seen.delivered[0]!.text);
  assert.equal(parsed.files.length, 1, "the agent gets a file path");
  const path = parsed.files[0]!;
  assert.equal(dirname(path), join(DATA_DIR, "attachments"));
  assert.match(basename(path), /^[0-9a-f-]{36}\.[a-z0-9]+$/);
  assert.deepEqual(new Uint8Array(readFileSync(path)), FILE, "stored bytes are unchanged");
  return { path, parsed };
}

function notServed(path: string) {
  let status = 0;
  serveAttachment(basename(path), { writeHead: (code: number) => { status = code; }, end: () => {} } as unknown as ServerResponse);
  assert.equal(status, 404, "unchecked file bytes never get an image or voice serving name");
}

describe("Telegram file intake", () => {
  for (const [label, fields, ext] of [
    ["video", { video: video(), caption: "show this bug" }, "mp4"],
    ["document", { document: document(), caption: "read these notes" }, "pdf"],
    ["video note", { video_note: { file_id: "round", file_size: 5 } }, "mp4"],
    ["audio", { audio: { file_id: "music", file_size: 5, mime_type: "audio/ogg" } }, "oga"],
    ["animation", { animation: { file_id: "gif", file_size: 5 }, document: document() }, "mp4"],
  ] as const) {
    test(`${label} arrives with its saved path and caption`, async (t) => {
      const f = fixture(t);
      await f.box.take(incoming(fields));
      const { path, parsed } = filePath(f);
      assert.ok(path.endsWith(`.${ext}`));
      assert.equal(parsed.display, "caption" in fields ? fields.caption : "");
      assert.equal(f.seen.download.length, 1);
      assert.equal(f.seen.download[0]!.max, VOICE_MAX_BYTES);
      if (label === "animation") assert.equal(f.seen.download[0]!.id, "gif", "animation wins over document");
      assert.equal(f.seen.heard, 0, "raw files are never transcribed");
      assert.deepEqual(f.seen.answers, []);
      assert.deepEqual(f.seen.replies, []);
      assert.equal(f.seen.delivered[0]!.text, composeOutgoing(parsed.display, [fileAttachment("file", path, FILE.length)]));
      notServed(path);
    });
  }

  test("21 MB is refused before getFile and the note reaches the agent", async (t) => {
    let getFile = 0;
    t.mock.method(globalThis, "fetch", async () => { getFile++; throw new Error("unexpected getFile"); });
    const f = fixture(t, { download: (id, max) => download("TEST", id, max) });
    await f.box.take(incoming({ video: video({ file_size: 21 * MB }) }));
    assert.equal(getFile, 0);
    assert.deepEqual(f.seen.saved, []);
    assert.equal(f.seen.delivered.length, 1, "refusal reaches the agent without a caption");
    assert.match(f.seen.delivered[0]!.text, /video.*22020096 bytes.*over 20 MB/i);
    assert.doesNotMatch(f.seen.delivered[0]!.text, /came with this/);
    assert.match(f.seen.replies[0]!, /20 MB.*shorter clip/);
  });

  test("exactly 20 MB and unknown sizes reach the bounded download", async (t) => {
    for (const size of [20 * MB, undefined, NaN, Infinity, -1]) {
      const f = fixture(t);
      await f.box.take(incoming({ video: video({ file_size: size }) }));
      filePath(f);
      assert.deepEqual(f.seen.download, [{ id: "clip", max: VOICE_MAX_BYTES }]);
    }
  });

  test("a document over the limit suggests a smaller file", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ document: document({ file_size: 21 * MB }), caption: "read it" }));
    assert.deepEqual(f.seen.download, []);
    assert.deepEqual(f.seen.saved, []);
    assert.match(f.seen.delivered[0]!.text, /^read it\n\n\[.*20 MB/);
    assert.match(f.seen.replies[0]!, /20 MB.*smaller file/);
  });

  test("an unpaired video's caption does not pair or download", async (t) => {
    const f = fixture(t, { state: () => ({ chatIds: [], pairing: "claim" }) });
    await f.box.take(incoming({ video: video(), caption: "claim" }));
    await f.box.flush();
    assert.equal(f.seen.refused, 1);
    assert.deepEqual(f.seen.download, []);
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.delivered, []);
    assert.equal(f.seen.heard, 0);
  });

  test("a malformed file ID is refused with its caption without download", async (t) => {
    for (const id of [undefined, "", 1]) {
      const f = fixture(t);
      await f.box.take(incoming({ document: document({ file_id: id }), caption: "notes" }));
      assert.deepEqual(f.seen.download, []);
      assert.deepEqual(f.seen.saved, []);
      assert.match(f.seen.delivered[0]!.text, /^notes\n\n\[/);
    }
  });

  test("file download and save failures keep the reason with or without a caption", async (t) => {
    for (const caption of ["", "look here"]) for (const where of ["download", "saveFile"] as const) {
      const f = fixture(t, { [where]: () => { throw new Error("planted failure"); } });
      await f.box.take(incoming({ video: video(), caption }));
      assert.equal(f.seen.delivered.length, 1);
      const text = f.seen.delivered[0]!.text;
      assert.match(text, /planted failure/);
      if (caption) assert.ok(text.startsWith(caption + "\n\n"));
      else { assert.match(text, /video.*5 bytes/i); assert.doesNotMatch(text, /came with this/); }
      assert.match(f.seen.replies[0]!, /planted failure/);
      if (where === "download") assert.match(f.seen.replies[0]!, /20 MB.*shorter clip/);
      else assert.doesNotMatch(f.seen.replies[0]!, /20 MB|shorter clip/);
      assert.deepEqual(f.seen.saved, []);
    }
  });

  test("file paths escape prompt delimiters just like the app", async (t) => {
    const path = '/tmp/with "quote" & <angle>\nline.mp4';
    const f = fixture(t, { saveFile: () => path });
    await f.box.take(incoming({ video: video(), caption: "caption" }));
    assert.equal(f.seen.delivered[0]!.text, composeOutgoing("caption", [fileAttachment("video", path, 5)]));
    assert.deepEqual(splitAttachments(f.seen.delivered[0]!.text).files, [path]);
  });
});

describe("safe Telegram file suffixes", () => {
  for (const [name, mime, ext] of [
    ["x.png", "application/octet-stream", "bin"], ["x.ogg", "application/octet-stream", "bin"],
    ["x.png", "application/pdf", "pdf"], ["x.ogg", "audio/ogg", "oga"],
    ["x.JPEG", "application/octet-stream", "bin"], ["x.gif", "application/octet-stream", "bin"],
    ["x.webp", "application/octet-stream", "bin"], ["../../report.CSV", "application/octet-stream", "csv"],
    ["x.verylongextension", "unknown/type", "bin"], ["x.png/other", "unknown/type", "bin"],
    ['x.pdf\"/><attached-image path=\"evil', "unknown/type", "bin"],
  ]) {
    test(`${name} with ${mime} cannot expose unchecked bytes`, async (t) => {
      const f = fixture(t);
      await f.box.take(incoming({ document: document({ file_name: name, mime_type: mime }) }));
      const { path } = filePath(f);
      assert.ok(path.endsWith(`.${ext}`));
      notServed(path);
    });
  }

  test("lying image MIME on a raw video never gives it an image serving name", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ video: video({ mime_type: "image/png", file_name: "x.png" }) }));
    notServed(filePath(f).path);
  });

  test("an image document still has to pass the existing byte sniff", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ document: document({ mime_type: "image/png", file_name: "x.png" }) }));
    assert.deepEqual(f.seen.saved, []);
    assert.equal(f.seen.delivered.length, 1);
    assert.match(f.seen.replies[0]!, /only png, jpeg, gif and webp/);
  });
});

describe("refusal notes and cards", () => {
  test("a refused sticker without a caption reaches the agent with size and reason", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ sticker: { file_id: "sticker", file_size: 100 } }));
    assert.equal(f.seen.delivered.length, 1);
    assert.equal(f.seen.delivered[0]!.text, "[A sticker (100 bytes) did not arrive (Bloks can't take stickers from Telegram).]");
    assert.doesNotMatch(f.seen.delivered[0]!.text, /came with this/);
    assert.deepEqual(f.seen.download, []);
  });

  test("unknown sticker and refused image sizes are stated as unknown", async (t) => {
    for (const fields of [{ sticker: { file_id: "s" } }, { document: document({ file_size: undefined, mime_type: "image/heic" }) }]) {
      const f = fixture(t);
      await f.box.take(incoming(fields));
      assert.equal(f.seen.delivered.length, 1, "the metadata refusal reaches the agent");
      assert.match(f.seen.delivered[0]!.text, /size not provided/);
      assert.deepEqual(f.seen.download, []);
    }
  });

  test("non-file refusal notes never invent a size", async (t) => {
    for (const type of ["location", "contact", "poll", "dice", "game", "story"]) {
      const f = fixture(t);
      await f.box.take(incoming({ [type]: {} }));
      assert.equal(f.seen.delivered.length, 1);
      assert.match(f.seen.delivered[0]!.text, /can't take/);
      assert.doesNotMatch(f.seen.delivered[0]!.text, /size|bytes|came with this/);
    }
  });

  test("uncaptioned image and voice failures deliver a standalone metadata note", async (t) => {
    for (const fields of [{ photo: [{ file_id: "photo", file_size: 5 }] }, { voice: { file_id: "voice", file_size: 6 } }]) {
      const f = fixture(t, { download: async () => { throw new Error("timed out"); } });
      await f.box.take(incoming(fields));
      assert.equal(f.seen.delivered.length, 1);
      assert.match(f.seen.delivered[0]!.text, /bytes.*timed out/);
      assert.doesNotMatch(f.seen.delivered[0]!.text, /came with this/);
    }
  });

  test("files and refusal notes never answer a waiting ask or approval", async (t) => {
    for (const permission of [true, false]) {
      const f = fixture(t);
      f.setCard(permission);
      await f.box.take(incoming({ video: video(), caption: "yes" }));
      await f.box.take(incoming({ sticker: { file_id: "s" }, caption: "yes" }));
      assert.deepEqual(f.seen.answers, []);
      assert.ok(f.card());
      assert.equal(f.seen.delivered.length, 2);
      await f.box.take(incoming({ text: "1" }));
      assert.deepEqual(f.seen.answers, [{ option: "Allow" }]);
    }
  });

  test("voice while approval waits keeps the exact typed-answer rule", async (t) => {
    for (const caption of ["", "yes"]) {
      const f = fixture(t);
      f.setCard(true);
      await f.box.take(incoming({ voice: { file_id: "voice", file_size: 6 }, caption }));
      assert.deepEqual(f.seen.delivered, []);
      assert.deepEqual(f.seen.download, []);
      assert.deepEqual(f.seen.saved, []);
      assert.equal(f.seen.heard, 0);
      assert.ok(f.card());
      assert.deepEqual(f.seen.replies, ["That one needs a tap or a typed answer. Tap a button on the card, or reply yes / no."]);
      await f.box.take(incoming({ text: "1" }));
      assert.deepEqual(f.seen.answers, [{ option: "Allow" }]);
    }
  });

  test("approval arriving during transcription still drops the voice and caption", async (t) => {
    const f = fixture(t, { transcriber: () => async () => { f.setCard(true); return "yes"; } });
    await f.box.take(incoming({ voice: { file_id: "voice", file_size: 6 }, caption: "yes" }));
    assert.ok(f.card());
    assert.deepEqual(f.seen.answers, []);
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.delivered, []);
    assert.deepEqual(f.seen.replies, ["That one needs a tap or a typed answer. Tap a button on the card, or reply yes / no."]);
  });
});

describe("mixed albums", () => {
  test("mixed album delivers once with ordered images, files and captions", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ media_group_id: "g", photo: [{ file_id: "photo" }], caption: "before" }));
    await f.box.take(incoming({ media_group_id: "g", video: video(), caption: "after" }));
    await f.box.take(incoming({ media_group_id: "g", document: document() }));
    assert.equal(f.seen.delivered.length, 0);
    await f.box.flush();
    assert.equal(f.seen.delivered.length, 1);
    assert.equal(f.seen.saved.length, 3);
    const text = f.seen.delivered[0]!.text;
    assert.equal(splitAttachments(text).display, "before\n\nafter");
    assert.deepEqual(splitAttachments(text).images, [f.seen.saved[0]]);
    assert.deepEqual(splitAttachments(text).files, f.seen.saved.slice(1));
    assert.ok(text.indexOf(f.seen.saved[0]!) < text.indexOf(f.seen.saved[1]!));
    assert.ok(text.indexOf(f.seen.saved[1]!) < text.indexOf(f.seen.saved[2]!));
  });

  test("partial album keeps the healthy file and identifies an oversize part", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ media_group_id: "g", video: video() }));
    await f.box.take(incoming({ media_group_id: "g", document: document({ file_size: 21 * MB }) }));
    await f.box.flush();
    filePath(f);
    assert.equal(f.seen.download.length, 1);
    assert.match(f.seen.delivered[0]!.text, /1 of 2 attachments.*a file.*22020096 bytes.*20 MB/);
  });

  test("all-failed uncaptioned album still gives one complete refusal note", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ media_group_id: "g", video: video({ file_size: 21 * MB }) }));
    await f.box.take(incoming({ media_group_id: "g", sticker: { file_id: "s", file_size: 100 } }));
    await f.box.flush();
    assert.equal(f.seen.delivered.length, 1);
    assert.match(f.seen.delivered[0]!.text, /2 attachments.*none.*a video.*22020096 bytes.*a sticker.*100 bytes/);
    assert.doesNotMatch(f.seen.delivered[0]!.text, /came with this/);
    assert.deepEqual(f.seen.download, []);
  });

  test("album IDs and paired chats remain independent", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ media_group_id: "one", video: video() }));
    await f.box.take(incoming({ media_group_id: "two", video: video() }));
    await f.box.take(incoming({ media_group_id: "one", video: video() }, 43));
    await f.box.flush();
    assert.equal(f.seen.delivered.length, 3);
    assert.deepEqual(f.seen.delivered.map((m) => m.chat), [42, 42, 43]);
    assert.equal(f.seen.saved.length, 3);
  });

  test("uncaptioned partial and all-failed photo albums still name each refusal", async (t) => {
    for (const allFailed of [false, true]) {
      const f = fixture(t, { download: async (id) => {
        if (id === "bad" || allFailed) throw new Error("timed out");
        return PNG;
      } });
      await f.box.take(incoming({ media_group_id: "g", photo: [{ file_id: "photo", file_size: 5 }] }));
      await f.box.take(incoming({ media_group_id: "g", photo: [{ file_id: "bad", file_size: 7 }] }));
      await f.box.flush();
      assert.equal(f.seen.delivered.length, 1);
      const parsed = splitAttachments(f.seen.delivered[0]!.text);
      assert.equal(parsed.images.length, allFailed ? 0 : 1);
      assert.match(parsed.display, /a photo \(7 bytes\): timed out/);
      if (allFailed) assert.match(parsed.display, /a photo \(5 bytes\): timed out/);
      assert.doesNotMatch(parsed.display, /came with this/);
    }
  });
});

describe("single-item refusals and file advice", () => {
  test("v2 wording: an oversize video without a caption names one video", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ video: video({ file_size: 21 * MB }) }));
    assert.deepEqual(f.seen.download, []);
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.replies, ["I couldn't take that video (it is over 20 MB), so it did not reach your agent. Telegram bots have a 20 MB limit. Try a shorter clip."]);
    assert.deepEqual(f.seen.delivered, [{ chat: 42, text: "[A video (22020096 bytes) did not arrive (it is over 20 MB).]" }]);
  });

  test("v2 wording: an oversize video's caption names the item once", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ video: video({ file_size: 21 * MB }), caption: "show this bug" }));
    assert.deepEqual(f.seen.download, []);
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.replies, ["I couldn't take that video (it is over 20 MB). Your caption went to your agent without it. Telegram bots have a 20 MB limit. Try a shorter clip."]);
    assert.deepEqual(f.seen.delivered, [{ chat: 42, text: "show this bug\n\n[A video (22020096 bytes) came with this and did not arrive (it is over 20 MB).]" }]);
  });

  test("v2 wording: a failed document names one file and the download advice", async (t) => {
    const f = fixture(t, { download: async () => { throw new Error("timed out"); } });
    await f.box.take(incoming({ document: document() }));
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.replies, ["I couldn't take that file (timed out), so it did not reach your agent. Telegram bots have a 20 MB limit. Try a smaller file."]);
    assert.deepEqual(f.seen.delivered, [{ chat: 42, text: "[A file (5 bytes) did not arrive (timed out).]" }]);
  });

  test("v2 wording: a location note names one location without a size", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ location: {} }));
    assert.deepEqual(f.seen.download, []);
    assert.deepEqual(f.seen.saved, []);
    assert.deepEqual(f.seen.replies, ["I can't take locations here, so that did not reach your agent."]);
    assert.deepEqual(f.seen.delivered, [{ chat: 42, text: "[A location did not arrive (Bloks can't take locations from Telegram).]" }]);
  });

  test("v2 wording: an album refusal names one part inside the sentence", async (t) => {
    const f = fixture(t);
    await f.box.take(incoming({ media_group_id: "g", document: document() }));
    await f.box.take(incoming({ media_group_id: "g", video: video({ file_size: 21 * MB }) }));
    await f.box.flush();
    const { parsed } = filePath(f);
    assert.equal(parsed.display, "[1 of 2 attachments did not arrive (a video (22020096 bytes): it is over 20 MB).]");
    assert.deepEqual(f.seen.replies, ["1 of those 2 did not reach your agent (it is over 20 MB). The rest did. Telegram bots have a 20 MB limit. Try a shorter clip."]);
  });

  test("v2 wording: a failed save keeps its reason without download advice", async (t) => {
    for (const caption of ["", "read it"]) {
      const f = fixture(t, { saveFile: () => { throw new Error("no space left"); } });
      await f.box.take(incoming({ document: document(), caption }));
      assert.doesNotMatch(f.seen.replies[0]!, /20 MB|smaller file|shorter clip/);
      assert.deepEqual(f.seen.saved, []);
      assert.deepEqual(f.seen.replies, [caption
        ? "I couldn't take that file (no space left). Your caption went to your agent without it."
        : "I couldn't take that file (no space left), so it did not reach your agent."]);
      assert.deepEqual(f.seen.delivered, [{ chat: 42, text: caption
        ? "read it\n\n[A file (5 bytes) came with this and did not arrive (no space left).]"
        : "[A file (5 bytes) did not arrive (no space left).]" }]);
    }
  });

  test("v2 wording: a missing file ID gets no download advice", async (t) => {
    for (const caption of ["", "read it"]) {
      const f = fixture(t);
      await f.box.take(incoming({ document: document({ file_id: undefined }), caption }));
      assert.deepEqual(f.seen.download, []);
      assert.deepEqual(f.seen.saved, []);
      assert.doesNotMatch(f.seen.replies[0]!, /20 MB|smaller file|shorter clip/);
      assert.deepEqual(f.seen.replies, [caption
        ? "I couldn't take that file (Telegram did not provide a file ID). Your caption went to your agent without it."
        : "I couldn't take that file (Telegram did not provide a file ID), so it did not reach your agent."]);
      assert.deepEqual(f.seen.delivered, [{ chat: 42, text: caption
        ? "read it\n\n[A file (5 bytes) came with this and did not arrive (Telegram did not provide a file ID).]"
        : "[A file (5 bytes) did not arrive (Telegram did not provide a file ID).]" }]);
    }
  });

  test("v2 wording: video messages, audio and GIF notes use singular articles", async (t) => {
    for (const [fields, name, item] of [
      [{ video_note: { file_id: "round", file_size: 5 } }, "video message", "A video message"],
      [{ audio: { file_id: "music", file_size: 5 } }, "audio file", "An audio file"],
      [{ animation: { file_id: "gif", file_size: 5 } }, "GIF", "A GIF"],
    ] as const) {
      const f = fixture(t, { download: async () => { throw new Error("timed out"); } });
      await f.box.take(incoming(fields));
      assert.deepEqual(f.seen.saved, []);
      assert.deepEqual(f.seen.replies, [`I couldn't take that ${name} (timed out), so it did not reach your agent. Telegram bots have a 20 MB limit. Try a shorter clip.`]);
      assert.deepEqual(f.seen.delivered, [{ chat: 42, text: `[${item} (5 bytes) did not arrive (timed out).]` }]);
    }
  });
});

describe("file bounds and the existing wire retry", () => {
  test("getFile and actual bytes over 20 MB refuse without retry", async (t) => {
    for (const metadata of [true, false]) {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ result: { file_path: "clip.mp4", file_size: metadata ? VOICE_MAX_BYTES + 1 : 5 } }));
        return new Response(new Uint8Array(VOICE_MAX_BYTES + 1));
      });
      const f = fixture(t, { download: (id, max) => download("TEST", id, max) });
      await f.box.take(incoming({ video: video() }));
      assert.equal(calls, metadata ? 1 : 2);
      assert.deepEqual(f.seen.saved, []);
      assert.equal(f.seen.delivered.length, 1);
      assert.match(f.seen.delivered[0]!.text, /over 20 MB/);
      t.mock.restoreAll();
    }
  });

  test("dropped connection retries once; a persistent drop gives a note", async (t) => {
    for (const persistent of [false, true]) {
      let files = 0, getFile = 0;
      t.mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("/getFile")) { getFile++; return new Response(JSON.stringify({ result: { file_path: "clip.mp4", file_size: 5 } })); }
        if (++files === 1 || persistent) throw new TypeError("fetch failed");
        return new Response(FILE);
      });
      const f = fixture(t, { download: (id, max) => download("TEST", id, max) });
      await f.box.take(incoming({ video: video() }));
      assert.equal(getFile, 2);
      assert.equal(files, 2);
      if (persistent) { assert.deepEqual(f.seen.saved, []); assert.match(f.seen.delivered[0]!.text, /connection dropped/); }
      else filePath(f);
      t.mock.restoreAll();
    }
  });

  test("HTTP refusal does not retry and reaches the agent", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("{}", { status: 400 }); });
    const f = fixture(t, { download: (id, max) => download("TEST", id, max) });
    await f.box.take(incoming({ video: video() }));
    assert.equal(calls, 1);
    assert.deepEqual(f.seen.saved, []);
    assert.match(f.seen.delivered[0]!.text, /HTTP 400/);
  });
});
