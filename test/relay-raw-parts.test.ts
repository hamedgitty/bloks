// A file larger than one answer through Bloks Cloud (GitHub 366). A
// device that says it takes parts gets a large file a part at a time, each
// part an ordinary sealed answer under the relay's limits, and puts them
// back together; a device that does not say so gets exactly what it got
// before, the 413 included. The loop that joins the parts is the desktop
// app's own (electron/raw-parts.mjs), tried here alone and through the
// app's stand-in server against a real workspace.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { gatherParts, type RawAnswer } from "../electron/raw-parts.mjs";
import { startRemoteProxy } from "../electron/remote.mjs";
import { RAW_PART_BYTES, RAW_PARTS_MAX_BYTES } from "../server/relay-link.ts";
import { deviceKey, open, peek, seal } from "../server/relay-crypto.ts";
import { tooLargeHere } from "../src/lib/sharedFile.ts";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const MB = 1024 * 1024;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("the parts loop, alone", () => {
  /** A file served in parts of `size`, as the other computer would. */
  const served = (file: Uint8Array, size = 4, tag = "t1") => {
    const asked: Array<[number, string | undefined]> = [];
    const parts = Math.max(1, Math.ceil(file.length / size));
    const askPart = async (part: number, said?: string): Promise<RawAnswer> => {
      asked.push([part, said]);
      return { status: 200, type: "image/png", bytes: file.subarray(part * size, (part + 1) * size), size: file.length, parts, part, tag };
    };
    return { askPart, asked };
  };

  test("asks for every part by its number and the first one's tag, and joins them in order", async () => {
    const file = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { askPart, asked } = served(file);
    const whole = await gatherParts(askPart);
    assert.equal(whole.status, 200);
    assert.equal(whole.type, "image/png");
    assert.deepEqual([...whole.bytes], [...file]);
    assert.deepEqual(asked, [[0, undefined], [1, "t1"], [2, "t1"]]);
    // and into whatever the caller makes of the pieces, a Blob in a browser
    const { bytes: blob } = await gatherParts(served(file).askPart, { join: (pieces, type) => new Blob(pieces as BlobPart[], { type }) });
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, "image/png");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...file]);
  });

  test("an answer that is not in parts, or is one part, comes back as it is", async () => {
    const plain = { status: 404, type: "application/json", bytes: encode({ error: "no such file" }) };
    assert.equal(await gatherParts(async () => plain), plain);
    const old = { status: 413, type: "application/json", bytes: encode({ error: "too large to open through Bloks Cloud" }) };
    assert.equal(await gatherParts(async () => old), old);
    const one = { status: 200, type: "text/plain", bytes: new Uint8Array([1]), size: 1, parts: 1, part: 0, tag: "t" };
    assert.equal(await gatherParts(async () => one), one);
  });

  test("a part of one is held to what it says, and is not a way past the limit (GitHub 371)", async () => {
    const part = (fields: Partial<RawAnswer>) => ({ status: 200, type: "application/octet-stream", bytes: new Uint8Array([1]), size: 1, parts: 1, part: 0, tag: "t", ...fields }) as RawAnswer;
    const status = async (answer: RawAnswer) => (await gatherParts(async () => answer)).status;
    // the report's own control: one byte that says it is over 50 MB
    assert.equal(await status(part({ size: 52_428_801 })), 413);
    // a size the bytes do not match, either way
    assert.equal(await status(part({ size: 2 })), 502);
    assert.equal(await status(part({ size: 0 })), 502);
    // a first answer that is not part 0, or whose numbers are not numbers
    assert.equal(await status(part({ part: 1 })), 502);
    assert.equal(await status(part({ parts: "1" as unknown as number })), 502);
    assert.equal(await status(part({ size: 1.5 })), 502);
    assert.equal(await status(part({ tag: undefined })), 502);
    assert.equal(await status(part({ parts: 0 })), 502);
    // and the good ones still pass: a whole part of one, an empty file
    const good = part({});
    assert.equal(await gatherParts(async () => good), good);
    const empty = part({ bytes: new Uint8Array(0), size: 0 });
    assert.equal(await gatherParts(async () => empty), empty);
    // an answer with no part fields at all is an older computer's, as it came
    const legacy = { status: 200, type: "image/png", bytes: new Uint8Array([9, 9]) };
    assert.equal(await gatherParts(async () => legacy), legacy);
  });

  test("a refusal partway is handed back, and parts that do not belong together are not joined", async () => {
    const file = new Uint8Array(12);
    const changed = { status: 412, type: "application/json", bytes: encode({ error: "the file changed while it was being opened. Open it again.", changed: true }) };
    const { askPart } = served(file);
    assert.equal(await gatherParts(async (part, tag) => (part === 2 ? changed : askPart(part, tag))), changed);
    // a later part of another version, or that is not the one asked for
    for (const lie of [{ tag: "t2" }, { part: 0 }, { size: 13 }, { parts: 9 }, { tag: undefined }]) {
      const mixed = await gatherParts(async (part, tag) => (part === 1 ? { ...(await askPart(part, tag)), ...lie } : askPart(part, tag)));
      assert.equal(mixed.status, 502, JSON.stringify(lie));
    }
    // a first part that claims more than there can be is not followed
    const greedy = served(new Uint8Array(12));
    const claimed = await gatherParts(async (part, tag) => ({ ...(await greedy.askPart(part, tag)), size: RAW_PARTS_MAX_BYTES + 1, parts: 3 }));
    assert.equal(claimed.status, 413);
    assert.deepEqual(greedy.asked, [[0, undefined]]);
  });

  test("stops asking once nobody is waiting", async () => {
    const { askPart, asked } = served(new Uint8Array(12));
    let waiting = true;
    const whole = await gatherParts(
      async (part, tag) => {
        if (part === 1) waiting = false;
        return askPart(part, tag);
      },
      { gone: () => !waiting },
    );
    assert.notEqual(whole.status, 200);
    assert.deepEqual(asked.map(([part]) => part), [0, 1]);
  });

  test("the card says why before anybody clicks, and only when it will not open", () => {
    assert.equal(tooLargeHere(51 * MB, RAW_PARTS_MAX_BYTES), "Too large to open through Bloks Cloud, which opens files up to 50 MB.");
    assert.equal(tooLargeHere(RAW_PARTS_MAX_BYTES, RAW_PARTS_MAX_BYTES), null);
    assert.equal(tooLargeHere(3 * MB, RAW_PARTS_MAX_BYTES), null);
    // on this computer, its network, or a server too old to say
    assert.equal(tooLargeHere(51 * MB, null), null);
  });
});

describe("a large file through Bloks Cloud, against a real workspace", () => {
  let h: Harness;
  let relay: Awaited<ReturnType<typeof sealedRelay>>;
  let sealKey: Buffer;
  let openKey: Buffer;
  let deviceId = "";
  let deviceToken = "";
  let botId = "";
  let files = "";
  let ui = "";
  const file = randomBytes(3 * MB);

  /** One sealed raw ask, as a device sends it, and what came back, opened. */
  const rawAsk = async (request: Record<string, unknown>) => {
    const res = await fetch(`${relay.url}/space/client/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: seal(sealKey, deviceId, { method: "GET", raw: true, ...request }) }),
    });
    const { payload } = (await res.json()) as { payload: string };
    const reply = open(openKey, peek(payload)!) as {
      status: number;
      body?: any;
      type?: string;
      z?: string;
      size?: number;
      parts?: number;
      part?: number;
      tag?: string;
    };
    assert.ok(reply, "the answer could not be opened");
    return { reply, posted: payload.length, bytes: typeof reply.z === "string" ? gunzipSync(Buffer.from(reply.z, "base64")) : null };
  };
  /** The same ask as the parts loop makes it, for gatherParts. */
  const askPart = (path: string) => async (part: number, tag?: string): Promise<RawAnswer> => {
    const { reply, bytes } = await rawAsk({ path, parts: true, ...(part ? { part, tag } : {}) });
    return { ...reply, bytes: bytes ?? encode(reply.body ?? null) };
  };
  const href = (name: string) => `/api/bots/${botId}/artifacts/${encodeURIComponent(name)}`;
  const share = (name: string) =>
    h.json(`/api/bots/${botId}/artifacts`, { method: "POST", body: JSON.stringify({ name }) }) as Promise<{ ok: boolean; warning?: string }>;

  before(async () => {
    h = await startHarness();
    await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const started = await h.json("/api/pair/start", { method: "POST" });
    const claimed = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "A Mac" }) });
    deviceId = claimed.device.id;
    deviceToken = claimed.token;
    const digest = createHash("sha256").update(deviceToken).digest("hex");
    sealKey = deviceKey(digest, "phone-to-mac");
    openKey = deviceKey(digest, "mac-to-phone");
    ({ bot: { id: botId } } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Producer" }) }));
    files = join(h.home, ".bloks", "artifacts", botId);
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, "render.png"), file);
    writeFileSync(join(files, "empty.txt"), "");
    // over the most a device is sent in parts, without writing 51 MB
    writeFileSync(join(files, "footage.mov"), "");
    truncateSync(join(files, "footage.mov"), 51 * MB);
    ui = mkdtempSync(join(tmpdir(), "bloks-raw-parts-ui-"));
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  });

  after(async () => {
    await h?.stop();
    await relay?.stop();
    if (ui) rmSync(ui, { recursive: true, force: true });
  });

  test("before Bloks Cloud, sharing a file too large for it says nothing about it", async () => {
    const big = await share("footage.mov");
    assert.equal(big.ok, true);
    assert.equal("warning" in big, false, JSON.stringify(big));
  });

  test("with Bloks Cloud on, sharing one says so in plain words, and a small one says nothing", async () => {
    relay = await sealedRelay();
    const set = await h.fetch("/api/relay", { method: "PUT", body: JSON.stringify({ url: relay.url, agentToken: "fixture-agent", enabled: true }) });
    assert.equal(set.status, 200);
    await relay.connection;
    const big = await share("footage.mov");
    assert.equal(big.ok, true, "still shared: it opens on this computer");
    assert.equal(
      big.warning,
      "footage.mov is too large to open on paired devices through Bloks Cloud, which opens files up to 50 MB. It opens on this computer; for the person's phone, make it smaller or send it another way.",
    );
    const small = await share("render.png");
    assert.equal(small.ok, true);
    assert.equal("warning" in small, false);
  });

  test("a device that does not ask for parts still gets the 413 it always did", async () => {
    const { reply } = await rawAsk({ path: href("render.png") });
    assert.deepEqual(reply, { status: 413, body: { error: "too large to open through Bloks Cloud" } });
  });

  test("a device that asks for parts gets every one, each under the relay's limit, and they make the file", async () => {
    const first = await rawAsk({ path: href("render.png"), parts: true });
    assert.equal(first.reply.status, 200);
    assert.equal(first.reply.type, "image/png");
    assert.equal(first.reply.size, file.length);
    assert.equal(first.reply.parts, Math.ceil(file.length / RAW_PART_BYTES));
    assert.equal(first.reply.part, 0);
    assert.equal(typeof first.reply.tag, "string");
    const pieces = [first.bytes!];
    for (let part = 1; part < first.reply.parts!; part++) {
      const next = await rawAsk({ path: href("render.png"), parts: true, part, tag: first.reply.tag });
      assert.equal(next.reply.status, 200);
      assert.equal(next.reply.part, part);
      assert.equal(next.reply.tag, first.reply.tag);
      // what the relay carries for each, with room left for the post around it
      assert.ok(next.posted < 1_950_000, `part ${part} was ${next.posted} on the line`);
      pieces.push(next.bytes!);
    }
    assert.ok(first.posted < 1_950_000);
    assert.ok(Buffer.concat(pieces).equals(file), "the parts did not make the file");

    // and the loop the app uses, against the same answers
    const whole = await gatherParts(askPart(href("render.png")), { join: (p) => Buffer.concat(p) });
    assert.equal(whole.status, 200);
    assert.ok(Buffer.from(whole.bytes).equals(file));
  });

  test("a file that changes between parts is refused, not joined", async () => {
    writeFileSync(join(files, "draft.png"), randomBytes(2 * MB));
    const first = await rawAsk({ path: href("draft.png"), parts: true });
    assert.equal(first.reply.parts, 3);
    // written over in place, the same size: only its tag tells
    writeFileSync(join(files, "draft.png"), randomBytes(2 * MB));
    const second = await rawAsk({ path: href("draft.png"), parts: true, part: 1, tag: first.reply.tag });
    assert.equal(second.reply.status, 412);
    assert.deepEqual(second.reply.body, { error: "the file changed while it was being opened. Open it again.", changed: true });
    // and shorter than it was, past the end of what it had
    const again = await rawAsk({ path: href("draft.png"), parts: true });
    writeFileSync(join(files, "draft.png"), randomBytes(100));
    const gone = await rawAsk({ path: href("draft.png"), parts: true, part: 2, tag: again.reply.tag });
    assert.equal(gone.reply.status, 412);
    // a later part with no tag at all is not one anybody can check
    assert.equal((await rawAsk({ path: href("render.png"), parts: true, part: 1 })).reply.status, 416);
  });

  test("past the most a device is sent in parts, it is told why and how much, before a byte is read", async () => {
    const { reply } = await rawAsk({ path: href("footage.mov"), parts: true });
    assert.deepEqual(reply, { status: 413, body: { error: "too large to open through Bloks Cloud, which opens files up to 50 MB", limit: RAW_PARTS_MAX_BYTES } });
  });

  test("small answers are one part as before, and an empty file opens", async () => {
    const bots = await rawAsk({ path: "/api/bots", parts: true });
    assert.equal(bots.reply.status, 200);
    assert.equal(bots.reply.parts, 1);
    assert.ok(Array.isArray(JSON.parse(bots.bytes!.toString("utf8")).bots));
    const empty = await rawAsk({ path: href("empty.txt"), parts: true });
    assert.equal(empty.reply.status, 200);
    assert.equal(empty.bytes!.length, 0);
    // a missing file is the route's own answer, as ever
    const missing = await rawAsk({ path: href("nothing.png"), parts: true });
    assert.equal(missing.reply.status, 404);
    // the limit a card goes by is said only to an app that takes parts:
    // for one that does not, what fits depends on how a file compresses
    const told = await rawAsk({ path: "/api/attachments/where", parts: true });
    assert.equal(JSON.parse(told.bytes!.toString("utf8")).openMaxBytes, RAW_PARTS_MAX_BYTES);
    const untold = await rawAsk({ path: "/api/attachments/where" });
    const said = JSON.parse(untold.bytes!.toString("utf8"));
    assert.equal(said.throughCloud, true);
    assert.equal("openMaxBytes" in said, false);
  });

  test("the desktop app on this workspace elsewhere opens and downloads the file, and is told the limit", { timeout: 120_000 }, async () => {
    const app = await startRemoteProxy({ relayUrl: relay.url, relayToken: "fixture-client", deviceId, deviceToken }, { staticDir: ui, client: "macOS 3.0" });
    try {
      const at = (path: string) => fetch(`http://127.0.0.1:${app.port}${path}`);
      const opened = await at(href("render.png"));
      assert.equal(opened.status, 200);
      assert.equal(opened.headers.get("content-type"), "image/png");
      assert.ok(Buffer.from(await opened.arrayBuffer()).equals(file), "the window did not get the file");
      const downloaded = await at(`${href("render.png")}?download`);
      assert.equal(downloaded.status, 200);
      assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(file));
      const refused = await at(href("footage.mov"));
      assert.equal(refused.status, 413);
      assert.match((await refused.json()).error, /50 MB/);
      const where = await (await at("/api/attachments/where")).json();
      assert.equal(where.throughCloud, true);
      assert.equal(where.openMaxBytes, RAW_PARTS_MAX_BYTES);
      // and the app's own window, not through Bloks Cloud, has no such limit
      assert.equal("openMaxBytes" in (await h.json("/api/attachments/where")), false);
    } finally {
      app.stop();
    }
  });
});
