// Hearing: what you say on a call or in a meeting, turned into text by
// whoever hears for the workspace, each against a fake of its own on this
// machine (a Whisper server, ElevenLabs, OpenAI); which one is chosen;
// where a stretch of speech starts and stops; and the page being allowed
// to play the voices it fetched. Never a real vendor.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { AppConfig } from "../server/config.ts";
import { allows } from "../server/agent-cli.ts";
import {
  HEARING_CHOICES,
  HearingError,
  clipName,
  hear,
  hearer,
  hearingError,
  hearingStatus,
  normalizeWhisperUrl,
  nobodyHears,
  transcribe,
} from "../server/speech.ts";
import { CALL_PAUSES, MEETING_PAUSES, NoWords, Pauses, loudness, pickEars } from "../src/lib/hearing.ts";
import { startHarness } from "./helpers/server.ts";

interface Heard {
  url: string;
  headers: IncomingMessage["headers"];
  form: FormData;
}

/** A fake that hears: every request it gets, its form read back. */
async function fakeHearer(answer: (heard: Heard, res: ServerResponse) => void) {
  const heard: Heard[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", async () => {
      const form = await new Response(Buffer.concat(parts), { headers: { "content-type": String(req.headers["content-type"]) } })
        .formData()
        .catch(() => new FormData());
      const one = { url: req.url ?? "", headers: req.headers, form };
      heard.push(one);
      answer(one, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, heard, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A few bytes that stand in for a recording: nothing here decodes it. */
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6]);

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// keys built at run time, so nothing token-shaped sits in the source
const OPENAI = ["sk", "test", "hearing"].join("-");
const ELEVEN = ["el", "test", "hearing"].join("-");

describe("who hears", () => {
  test("automatic takes a Whisper server of your own first, then ElevenLabs, then OpenAI", () => {
    const whisperUrl = "http://localhost:8000";
    assert.equal(hearer({}), null);
    assert.equal(hearer({ speech: { openaiKey: OPENAI } }), "openai");
    assert.equal(hearer({ speech: { openaiKey: OPENAI, elevenlabsKey: ELEVEN } }), "elevenlabs");
    assert.equal(hearer({ speech: { openaiKey: OPENAI, elevenlabsKey: ELEVEN, whisperUrl } }), "whisper");
  });

  test("a vendor chosen by name hears, or nobody does: never somebody else quietly", () => {
    const both: AppConfig = { speech: { openaiKey: OPENAI, elevenlabsKey: ELEVEN } };
    assert.equal(hearer({ speech: { ...both.speech, hearing: "openai" } }), "openai");
    assert.equal(hearer({ speech: { ...both.speech, hearing: "whisper" } }), null);
    assert.match(nobodyHears({ speech: { hearing: "whisper" } }), /set to your Whisper server, but none is saved/);
    assert.match(nobodyHears({ speech: { hearing: "elevenlabs" } }), /no ElevenLabs key is saved/);
    assert.match(nobodyHears({}), /Nothing is set up to hear you\. Add an OpenAI or ElevenLabs key, or a Whisper server/);
  });

  test("the Mac chosen still leaves the server something to hear with, for voice messages and other devices", () => {
    assert.equal(hearer({ speech: { hearing: "mac", openaiKey: OPENAI } }), "openai");
    assert.deepEqual(hearingStatus({ speech: { hearing: "mac", openaiKey: OPENAI } }), { choice: "mac", engine: "openai", whisper: false });
  });

  test("a word that is not a choice reads as automatic, and the status shows the server's address, not a key", () => {
    assert.equal(hearingStatus({ speech: { hearing: "loudly" } }).choice, "auto");
    const status = hearingStatus({ speech: { whisperUrl: "http://studio.local:8000", openaiKey: OPENAI } });
    assert.deepEqual(status, { choice: "auto", engine: "whisper", whisper: true, whisperUrl: "http://studio.local:8000" });
    assert.ok(!JSON.stringify(status).includes(OPENAI));
    assert.deepEqual([...HEARING_CHOICES], ["auto", "whisper", "elevenlabs", "openai", "mac"]);
  });

  test("a Whisper server has to be on this computer or your own network, and a pasted endpoint folds to its root", () => {
    assert.deepEqual(normalizeWhisperUrl("localhost:8000/v1/audio/transcriptions"), { url: "http://localhost:8000" });
    assert.deepEqual(normalizeWhisperUrl("http://192.168.1.20:9000/v1"), { url: "http://192.168.1.20:9000" });
    // beside Bloks in Docker: a Compose service, or the container's host
    assert.deepEqual(normalizeWhisperUrl("http://whisper:8000"), { url: "http://whisper:8000" });
    assert.deepEqual(normalizeWhisperUrl("http://host.docker.internal:8000"), { url: "http://host.docker.internal:8000" });
    assert.match((normalizeWhisperUrl("https://whisper.example.com") as { error: string }).error, /Whisper has to run on this computer or your own network/);
    assert.match((normalizeWhisperUrl("") as { error: string }).error, /like http:\/\/localhost:8000/);
    assert.match((normalizeWhisperUrl("http://me:pw@localhost:8000") as { error: string }).error, /Whisper takes no sign-in/);
  });

  test("a recording is named for what it is, since the vendors read the format from the name", () => {
    assert.equal(clipName("audio/webm;codecs=opus"), "speech.webm");
    assert.equal(clipName("audio/ogg; codecs=opus"), "speech.ogg");
    assert.equal(clipName("audio/mp4"), "speech.m4a");
    assert.equal(clipName("audio/wav"), "speech.wav");
    assert.equal(clipName("audio/something-new"), "speech.webm");
  });
});

describe("hearing, against fakes", () => {
  test("a Whisper server gets the recording at /v1/audio/transcriptions with no key at all", async () => {
    const fake = await fakeHearer((_h, res) => json(res, 200, { text: "  book the room for Thursday  " }));
    try {
      const heard = await hear({ speech: { whisperUrl: fake.url, openaiKey: OPENAI } }, WEBM, "audio/webm;codecs=opus");
      assert.deepEqual(heard, { text: "book the room for Thursday", by: "whisper" });
      const [one] = fake.heard;
      assert.equal(one.url, "/v1/audio/transcriptions");
      assert.equal(one.headers.authorization, undefined, "the OpenAI key never goes to somebody's own server");
      assert.equal(one.form.get("model"), "whisper-1");
      assert.equal(one.form.get("response_format"), "json");
      const file = one.form.get("file") as File;
      assert.equal(file.name, "speech.webm");
      assert.equal(file.type, "audio/webm");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), WEBM);
    } finally {
      await fake.close();
    }
  });

  test("OpenAI and ElevenLabs each get the recording with their own key and model", async () => {
    const fake = await fakeHearer((_h, res) => json(res, 200, { text: "hello" }));
    try {
      await withEnv({ BLOKS_OPENAI_SPEECH_URL: fake.url, BLOKS_ELEVENLABS_URL: fake.url }, async () => {
        assert.deepEqual(await hear({ speech: { openaiKey: OPENAI } }, WEBM, "audio/webm"), { text: "hello", by: "openai" });
        assert.deepEqual(await hear({ speech: { elevenlabsKey: ELEVEN } }, WEBM, "audio/mp4"), { text: "hello", by: "elevenlabs" });
      });
      const [openai, eleven] = fake.heard;
      assert.equal(openai.url, "/v1/audio/transcriptions");
      assert.equal(openai.headers.authorization, `Bearer ${OPENAI}`);
      assert.equal(openai.form.get("model"), "gpt-transcribe");
      assert.equal(eleven.url, "/v1/speech-to-text");
      assert.equal(eleven.headers["xi-api-key"], ELEVEN);
      assert.equal(eleven.form.get("model_id"), "scribe_v2");
      assert.equal((eleven.form.get("file") as File).name, "speech.m4a");
    } finally {
      await fake.close();
    }
  });

  test("each refusal says what to fix, and never repeats what the vendor said back", async () => {
    const fake = await fakeHearer((h, res) => {
      const status = Number(h.url.split("/").pop()) || 401;
      json(res, status, { error: { message: `key ${OPENAI} is wrong; heard "secret words"` } });
    });
    try {
      await withEnv({ BLOKS_OPENAI_SPEECH_URL: fake.url }, async () => {
        await assert.rejects(hear({ speech: { openaiKey: OPENAI } }, WEBM, "audio/webm"), (e: Error) => {
          assert.ok(e instanceof HearingError);
          assert.equal(e.status, 401);
          assert.equal(e.message, "OpenAI did not accept the key. Paste a new one in Settings, Voices.");
          assert.ok(!e.message.includes(OPENAI) && !e.message.includes("secret words"));
          return true;
        });
      });
    } finally {
      await fake.close();
    }
    assert.match(hearingError("openai", 429, undefined), /limiting requests just now, or the account is out of credit/);
    assert.match(hearingError("elevenlabs", 413, undefined), /ElevenLabs could not read that recording \(413\)/);
    assert.match(hearingError("whisper", 404, "http://localhost:8000"), /^http:\/\/localhost:8000 answered, but not as a Whisper server/);
    assert.match(hearingError("whisper", 500, "http://localhost:8000"), /Its own log says why/);
  });

  test("a Whisper server that is not running is said as such", async () => {
    const fake = await fakeHearer((_h, res) => json(res, 200, {}));
    await fake.close();
    await assert.rejects(
      hear({ speech: { whisperUrl: fake.url } }, WEBM, "audio/webm"),
      new RegExp(`Nothing answered at ${fake.url.replace(/[.]/g, "\\.")}\\. Start the Whisper server`),
    );
    await assert.rejects(hear({}, WEBM, "audio/webm"), /Nothing is set up to hear you/);
  });

  test("a voice message from a phone goes the same way, and a refusal stays its status alone", async () => {
    const fake = await fakeHearer((h, res) => (h.form.get("model") === "whisper-1" ? json(res, 200, { text: "on my way" }) : json(res, 403, {})));
    try {
      assert.equal(await transcribe({ speech: { whisperUrl: fake.url } }, WEBM, "voice.ogg", "audio/ogg"), "on my way");
      assert.equal((fake.heard[0].form.get("file") as File).name, "voice.ogg");
      await withEnv({ BLOKS_OPENAI_SPEECH_URL: fake.url }, async () => {
        await assert.rejects(transcribe({ speech: { openaiKey: OPENAI } }, WEBM, "voice.ogg", "audio/ogg"), (e: Error) => e.message === "OpenAI answered 403");
      });
    } finally {
      await fake.close();
    }
  });
});

describe("who hears, for this window", () => {
  const status = (over: object = {}) => ({ choice: "auto" as const, engine: null, whisper: false, ...over });

  test("the server's hearer comes first; the Mac's own recognizer only with nothing else, and only in the Mac app", () => {
    assert.deepEqual(pickEars(status({ engine: "openai" }), true), { kind: "server", by: "openai" });
    assert.deepEqual(pickEars(status(), true), { kind: "mac" });
    assert.deepEqual(pickEars(status(), false), { kind: "none", missing: "auto" });
    assert.deepEqual(pickEars(undefined, false), { kind: "none", missing: "auto" });
  });

  test("the Mac chosen hears in the Mac app, and anywhere else the server's hearer does", () => {
    assert.deepEqual(pickEars(status({ choice: "mac", engine: "openai" }), true), { kind: "mac" });
    assert.deepEqual(pickEars(status({ choice: "mac", engine: "openai" }), false), { kind: "server", by: "openai" });
    assert.deepEqual(pickEars(status({ choice: "mac" }), false), { kind: "none", missing: "mac" });
  });

  test("a vendor chosen and not set up is said, not covered for by the Mac", () => {
    assert.deepEqual(pickEars(status({ choice: "elevenlabs" }), true), { kind: "none", missing: "elevenlabs" });
  });
});

describe("where speech starts and stops", () => {
  /**
   * Readings every 50 ms, as speech sounds: inside a span, words with the
   * short gaps between them that real talk has; quiet outside. A stretch
   * that ends begins again, as the recorder does.
   */
  function run(pauses: Pauses, spans: Array<[number, number]>, until: number) {
    const events: Array<[number, string]> = [];
    pauses.reset(0);
    for (let at = 50; at <= until; at += 50) {
      const inSpeech = spans.some(([from, to]) => at >= from && at < to);
      const betweenWords = at % 400 === 0;
      const event = pauses.push(inSpeech && !betweenWords ? 0.4 : 0.01, at);
      if (event) events.push([at, event]);
      if (event === "end" || event === "idle") pauses.reset(at);
    }
    return events;
  }

  test("a sentence and a breath ends a call's stretch", () => {
    const events = run(new Pauses(CALL_PAUSES), [[1_000, 3_000]], 5_000);
    assert.deepEqual(events.map(([, e]) => e), ["speech", "end"]);
    assert.ok(events[0][0] >= 1_150 && events[0][0] <= 1_300, "speech is heard once it lasts, not at the first loud reading");
    // the last word is the reading before 3 s; a breath after it ends the stretch
    assert.ok(events[1][0] >= 2_950 + CALL_PAUSES.quietMs && events[1][0] <= 3_000 + CALL_PAUSES.quietMs);
  });

  test("a pause shorter than the rule is part of the same stretch", () => {
    const events = run(new Pauses(MEETING_PAUSES), [[500, 2_000], [2_800, 4_000]], 7_000);
    assert.deepEqual(events.map(([, e]) => e), ["speech", "end"]);
    assert.ok(events[1][0] >= 3_950 + MEETING_PAUSES.quietMs);
  });

  test("a click or a cough is not speech, and silence is let go of rather than sent", () => {
    const events = run(new Pauses(CALL_PAUSES), [[1_000, 1_100], [5_000, 5_050]], CALL_PAUSES.idleMs + 100);
    assert.deepEqual(events.map(([, e]) => e), ["idle"]);
  });

  test("talking without a pause is still cut, so no stretch outgrows what a vendor takes", () => {
    const events = run(new Pauses(MEETING_PAUSES), [[0, 120_000]], MEETING_PAUSES.maxMs + 1_000);
    const end = events.find(([, e]) => e === "end")!;
    assert.ok(end[0] >= MEETING_PAUSES.maxMs && end[0] <= MEETING_PAUSES.maxMs + 100);
  });

  test("a steady hum raises the bar instead of reading as one endless sentence", () => {
    const pauses = new Pauses(CALL_PAUSES);
    pauses.reset(0);
    const events: string[] = [];
    // a fan just above the floor for a long while, then a voice well over it
    for (let at = 50; at <= 30_000; at += 50) {
      const voice = at >= 20_000 && at < 22_000;
      const event = pauses.push(voice ? 0.6 : 0.1, at);
      if (event) events.push(event);
      if (event === "idle" || event === "end") pauses.reset(at);
    }
    assert.ok(events.includes("speech"), "the voice is heard over the fan");
    assert.ok(events.includes("end"), "and its end, though the fan never stops");
  });

  test("loudness is on the Mac helper's scale", () => {
    assert.equal(loudness([]), 0);
    assert.equal(loudness(new Float32Array(100)), 0);
    assert.equal(loudness(new Float32Array(100).fill(0.5)), 1);
    assert.ok(Math.abs(loudness(new Float32Array(100).fill(0.01)) - 0.12) < 1e-6);
  });

  test("the Mac's recognizer hearing sound and saying nothing is noticed, and words clear it", () => {
    const deaf = new NoWords(1_000);
    for (let at = 0; at <= 1_200; at += 100) deaf.level(0.5, at);
    assert.equal(deaf.deaf, true);
    deaf.heardWords();
    assert.equal(deaf.deaf, false);
    const quiet = new NoWords(1_000);
    for (let at = 0; at <= 5_000; at += 100) quiet.level(0.02, at);
    assert.equal(quiet.deaf, false, "a quiet room is not a deaf recognizer");
  });
});

test("an agent's token can never turn the person's speech into text", () => {
  assert.equal(allows("bot-1", "POST", "/api/speech/transcribe").ok, false);
});

describe("through the app", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let whisper: Awaited<ReturnType<typeof fakeHearer>>;
  let page: string;
  before(async () => {
    whisper = await fakeHearer((_h, res) => json(res, 200, { text: "what is on today" }));
    // a page of its own, so the server sends the headers it sends with the app
    page = mkdtempSync(join(tmpdir(), "bloks-page-"));
    writeFileSync(join(page, "index.html"), "<!doctype html><title>Bloks</title>");
    h = await startHarness({ BLOKS_STATIC_DIR: page });
  });
  after(async () => {
    await h.stop();
    await whisper.close();
    rmSync(page, { recursive: true, force: true });
  });

  test("the page may play the voices it fetched: blob media is allowed, nothing else is opened", async () => {
    const res = await fetch(`${h.url}/`);
    const policy = res.headers.get("content-security-policy") ?? "";
    assert.match(policy, /(^|; )media-src 'self' blob:(;|$)/);
    assert.match(policy, /(^|; )default-src 'self'(;|$)/);
    assert.match(policy, /(^|; )connect-src 'self'(;|$)/);
  });

  test("with nothing set up, a recording is refused with what to set up, and nothing is sent anywhere", async () => {
    const config = await h.json("/api/config");
    assert.deepEqual(config.speech.hearing, { choice: "auto", engine: null, whisper: false });
    const res = await h.fetch("/api/speech/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: WEBM });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "no-hearing");
    assert.match(body.error, /Nothing is set up to hear you/);
  });

  test("a Whisper server and a choice are saved and checked; a word that is not a choice is refused", async () => {
    const bad = await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ speech: { hearing: "loudly" } }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /speech\.hearing is one of auto, whisper, elevenlabs, openai, mac/);
    const away = await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ speech: { whisperUrl: "https://whisper.example.com" } }) });
    assert.equal(away.status, 400);
    const saved = await h.json("/api/config", {
      method: "PUT",
      body: JSON.stringify({ speech: { whisperUrl: `${whisper.url}/v1/audio/transcriptions`, hearing: "whisper" } }),
    });
    assert.deepEqual(saved.speech.hearing, { choice: "whisper", engine: "whisper", whisper: true, whisperUrl: whisper.url });
  });

  test("a recording comes back as words, from whoever hears", async () => {
    const res = await h.fetch("/api/speech/transcribe", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: WEBM });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "what is on today", by: "whisper" });
    const file = whisper.heard.at(-1)!.form.get("file") as File;
    assert.equal(file.name, "speech.webm");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), WEBM);
  });

  test("only sound is taken, and not an empty one", async () => {
    const text = await h.fetch("/api/speech/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(text.status, 415);
    const empty = await h.fetch("/api/speech/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(0) });
    assert.equal(empty.status, 400);
  });

  test("a hearer that fails comes back as a 502 that says what to fix", async () => {
    await whisper.close();
    const res = await h.fetch("/api/speech/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: WEBM });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Nothing answered at http:\/\/127\.0\.0\.1:\d+\. Start the Whisper server/);
  });
});
