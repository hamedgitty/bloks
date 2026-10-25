// Real HTTP/SSE fixture. Only the model transport is replaced, with a
// loopback stream whose deltas and completion have separate gates.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";
import { idle, messagesOf, waitFor } from "./turns.ts";
import { codexCommands } from "./codex-commands.ts";

type Cleanup = { after(fn: () => unknown): void };
export type PreviewBot = { id: string; threadId: string };
export const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body) });

export async function quietPreviewFixture(t: Cleanup) {
  const calls: Array<{ body: any; text: string; done: boolean; delta(text: string): void; finish(): void }> = [];
  const streams: Array<() => Promise<void>> = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "preview-fixture" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const call = {
        body: JSON.parse(body), text: "", done: false,
        delta(text: string) {
          assert.ok(!call.done, "cannot send after fixture completion");
          call.text += text;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        },
        finish() {
          if (call.done) return;
          call.done = true;
          res.end("data: [DONE]\n\n");
        },
      };
      calls.push(call);
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const h = await startHarness({ NODE_OPTIONS: `--import=${new URL("./boat-fetch.mjs", import.meta.url).href}` });
  t.after(async () => {
    await Promise.all(streams.map(close => close()));
    calls.forEach(call => call.finish());
    await h.stop();
    provider.closeAllConnections(); provider.close();
  });
  const connected = await h.fetch("/api/providers/ollama/connect", post({ url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` }));
  assert.ok(connected.ok, await connected.text());

  async function bot(name = "Preview fixture"): Promise<PreviewBot> {
    const { bot } = await h.json("/api/bots", post({ name }));
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "ollama", model: "preview-fixture" } }) });
    return bot;
  }
  async function stream(path = "/api/events") {
    const frames: any[] = [];
    const abort = new AbortController();
    const response = await h.fetch(path, { signal: abort.signal });
    assert.ok(response.ok);
    const reading = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          buffer += decoder.decode(next.value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
            const data = block.split("\n").find(line => line.startsWith("data: "));
            if (data) frames.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    const close = async () => { abort.abort(); await reading; };
    streams.push(close);
    assert.ok(await waitFor(() => frames.some(frame => frame.kind === "hello")), "SSE hello absent");
    return { frames, close };
  }
  async function webhook(bot: PreviewBot, thread?: string) {
    const { webhook } = await h.json("/api/webhooks", post({ name: "Neutral preview", botId: bot.id, ...(thread ? { thread } : {}) }));
    assert.ok(webhook?.token, "webhook was not created");
    return async (event = "inspect neutral event") => {
      const response = await h.fetch(`/hook/${webhook.token}`, post({ event }));
      assert.equal(response.status, 202, await response.text());
    };
  }
  async function call(index: number) {
    assert.ok(await waitFor(() => calls[index]), `provider call ${index} absent: ${h.logs()}`);
    return calls[index];
  }
  return { h, calls, bot, stream, webhook, call,
    messages: (bot: PreviewBot) => messagesOf(h, bot),
    idle: (bot: PreviewBot) => idle(h, bot),
    async person(bot: PreviewBot, text: string) {
      const response = await h.fetch(`/api/bots/${bot.id}/messages`, post({ text, taskId: bot.threadId }));
      assert.equal(response.status, 202, await response.clone().text());
      return response.json();
    },
  };
}

export const previewText = (frames: any[], lane: string) => frames
  .filter(frame => frame.event?.threadId === lane && frame.event?.type === "content.delta" && frame.event?.streamKind === "assistant_text")
  .map(frame => frame.event.delta).join("");

/** The existing fake native Codex driver, with a small test-only gate
 * added to its generated CLI. This exercises real steer receipts and
 * multiple authoritative assistant items, which chat SSE cannot model. */
export async function nativePreviewFixture(t: TestContext) {
  const streams: Array<{ abort: AbortController; reading: Promise<void> }> = [];
  // Registered before codexCommands' cleanup: close readers before it
  // kills the real harness, so teardown cannot mask a failed assertion.
  t.after(async () => { streams.forEach(stream => stream.abort.abort()); await Promise.all(streams.map(stream => stream.reading)); });
  // Codex currently emits whole assistant items. This labelled synthetic
  // token seam wraps only its normalized onEvent contract: the real HTTP
  // intake, native start/steer receipts, storage and terminal path stay
  // intact. Test-only native tool events carry the gated token payload.
  const seam = mkdtempSync(join(tmpdir(), "bloks-preview-seam-")), preload = join(seam, "tokens.mjs");
  writeFileSync(preload, `
import ${JSON.stringify(new URL("./boat-fetch.mjs", import.meta.url).href)};
import { CodexDriver } from ${JSON.stringify(new URL("../../server/drivers/codex.ts", import.meta.url).href)};
import { appendFileSync } from "node:fs";
const create = CodexDriver.create;
CodexDriver.create = async function(input) {
  const instance = await create.call(this, input), onEvent = instance.adapter.onEvent;
  instance.adapter.onEvent = listener => {
    const injected = new Set();
    return onEvent(event => {
      const key = event.threadId + "/" + event.turnId + "/" + event.itemId;
      if (event.type === "item.started" && event.command?.startsWith("preview-token:")) {
        const payload = JSON.parse(event.command.slice("preview-token:".length));
        const { title, command, itemType, ...base } = event;
        injected.add(event.threadId + "/" + event.turnId + "/" + payload.item);
        listener({ ...base, type: "content.delta", streamKind: "assistant_text", itemId: payload.item, delta: payload.text });
        appendFileSync(${JSON.stringify(join(seam, "observed.jsonl"))}, JSON.stringify(payload) + "\\n");
      } else if (!(event.type === "content.delta" && injected.has(key))) listener(event);
    });
  };
  return instance;
};
`);
  const s = await codexCommands(t, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
  t.after(() => rmSync(seam, { recursive: true, force: true }));
  const cli = join(s.root, "fake-codex.mjs"), file = join(s.root, "preview-actions.json");
  const anchor = '  if(spec.hold||text.includes("HOLD")){';
  const original = readFileSync(cli, "utf8");
  assert.ok(original.includes(anchor), "generated CLI hook changed");
  writeFileSync(file, "[]");
  writeFileSync(cli, original.replace('import { appendFileSync, existsSync, readFileSync }', 'import { appendFileSync, existsSync, readFileSync, writeFileSync }').replace(anchor, `
  if(spec.previewStream){
    let seen=0;
    const timer=setInterval(()=>{
      const actions=JSON.parse(readFileSync(root+"/preview-actions.json","utf8"));
      while(seen<actions.length){
        const action=actions[seen++];
        if(action.kind==="finish"){clearInterval(timer);writeFileSync(root+"/preview-actions.json","[]");finish();return;}
        const item=action.item??"answer";
        if(action.kind==="delta")out({method:"item/started",params:{threadId:thread,turnId:turn,item:{type:"commandExecution",id:"preview-token-"+seen,command:"preview-token:"+JSON.stringify({item,text:action.text})}}});
        if(action.kind==="complete")out({method:"item/completed",params:{threadId:thread,turnId:turn,item:{type:"agentMessage",id:item,text:action.text}}});
      }
    },20);
    return;
  }
` + anchor));
  const config: Record<string, unknown> = { previewStream: true };
  const spec = (change: Record<string, unknown>) => { Object.assign(config, change); s.spec(config); };
  spec({});
  let actions: any[] = [];
  const add = (action: any) => { actions.push(action); writeFileSync(file, JSON.stringify(actions)); };
  const observed = () => { try { return readFileSync(join(seam, "observed.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  async function stream(path = "/api/events") {
    const frames: any[] = [], abort = new AbortController();
    const response = await s.h.fetch(path, { signal: abort.signal }); assert.ok(response.ok);
    const reading = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
      try { for (;;) {
        const next = await reader.read(); if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true }); let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const data = block.split("\n").find(line => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      } } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    streams.push({ abort, reading });
    assert.ok(await waitFor(() => frames.some(frame => frame.kind === "hello")));
    return frames;
  }
  const { webhook } = await s.post("/api/webhooks", { botId: s.bot.id, name: "Neutral native preview" });
  return { ...s, spec, stream,
    reset() { actions = []; writeFileSync(file, "[]"); },
    async delta(text: string, item = "answer") {
      const before = observed().length;
      add({ kind: "delta", text, item });
      assert.ok(await waitFor(() => observed().length > before), "synthetic normalized token did not pass through the actual bus");
    },
    complete(text: string, item = "answer") { add({ kind: "complete", text, item }); },
    finish(text: string) { spec({ answer: text }); add({ kind: "finish" }); },
    async fire() {
      const response = await s.h.fetch(`/hook/${webhook.token}`, post({ event: "Inspect neutral native fixture" }));
      assert.equal(response.status, 202, await response.text());
    },
  };
}
