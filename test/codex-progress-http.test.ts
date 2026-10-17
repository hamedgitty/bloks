import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { progressIds, itemProgress } from "../server/codex-text.ts";
import { foldTurns } from "../src/lib/turnFold.ts";
import { initialState, reducer, type Message, type Bot, type AppState } from "../src/state/reducer.ts";

const until = async <T>(read: () => Promise<T | undefined> | T | undefined) => {
  for (let n = 0; n < 150; n++) { const value = await read(); if (value !== undefined) return value; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error("Synthetic fixture condition did not arrive");
};

test("real HTTP/SSE preserves item-time facts, accepted joins, terminal fallback and no transition patches", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-progress-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const cli = join(home, "codex-fake.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] === '--version') { console.log('codex-cli 0.162.1'); process.exit(0); }
if (process.argv[2] === 'login') process.exit(0);
const out = x => console.log(JSON.stringify(x));
const thread = 'native-' + process.pid, turn = 'turn-' + process.pid; let rejectSteer=false;
const item = (id,text,phase='commentary',questions=null) => out({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',id,text,phase,questions}}});
const finish = () => out({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
createInterface({input:process.stdin}).on('line',line => {
 const f=JSON.parse(line); if (f.id === undefined) return;
 const input=(f.params?.input||[]).filter(x=>x.type==='text').map(x=>x.text).join(' ');
 out(f.method==='turn/steer' && rejectSteer ? {id:f.id,error:{code:-32600,message:'Synthetic turn refused'}} : {id:f.id,result:f.method==='model/list'?{data:[]}:f.method==='thread/start'?{thread:{id:thread}}:f.method==='turn/start'?{turn:{id:turn}}:f.method==='turn/steer'?{turnId:turn}:{}});
 if (f.method==='turn/start') { rejectSteer=input.includes('REJECT_STEER');
  out({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
  if(input.includes('SENDER_HOLD')) { writeFileSync(${JSON.stringify(join(home, 'sender-token'))},process.env.BLOKS_TOKEN||''); return; }
  if(input.includes('ASYNC_FINAL')) item('async-answer','A visible answer','final_answer');
  if(input.includes('EXPLICIT_Q')) item('explicit-question','Which neutral option?','commentary',[{question:'Which neutral option?'}]);
  item('progress-1','Checking the neutral sample'); item('progress-2','Still checking the neutral sample');
  if(input.includes('NO_FINAL')||input.includes('ASYNC_FINAL')) setTimeout(finish,80);
 }
 if(f.method==='turn/steer' && !rejectSteer) setTimeout(()=>item('after-join','Continuing with your direction'),20);
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli, fullAuto: false } } } }));
  const tracePath = join(home, "attention.jsonl");
  const h = await startHarness({ HOME: home, CODEX_HOME: join(home, ".codex"), SHELL: "/bin/sh",
    NODE_OPTIONS: `--import=${new URL('./helpers/codex-progress-preload.mjs', import.meta.url).pathname}`,
    BLOKS_PROGRESS_TRACE: tracePath });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const frames: any[] = [];
  const response = await h.fetch("/api/events", { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const pumping = (async () => { let pending = ""; try { while (true) { const r = await reader.read(); if (r.done) break; pending += new TextDecoder().decode(r.value); let i: number; while ((i = pending.indexOf("\n\n")) >= 0) { const chunk = pending.slice(0, i); pending = pending.slice(i + 2); const data = chunk.split("\n").find((l) => l.startsWith("data: ")); if (data) frames.push(JSON.parse(data.slice(6))); } } } catch { /* aborted at teardown */ } })();
  t.after(async () => { abort.abort(); await pumping; });
  const bot = async (name: string) => { const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) }); await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) }); return bot; };
  const history = async (id: string): Promise<Message[]> => (await h.json(`/api/bots/${id}/messages?limit=100`)).messages;
  const sender = await bot("Coordinator");
  await h.json(`/api/bots/${sender.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SENDER_HOLD" }) });
  const token = await until(() => existsSync(join(home, "sender-token")) ? readFileSync(join(home, "sender-token"), "utf8") || undefined : undefined);
  const agentSend = (id: string, text: string) => h.json(`/api/bots/${id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
  const worker = await bot("Worker");
  const initialHistory = await history(worker.id);
  await agentSend(worker.id, "WORK_HOLD");
  const before = await until(async () => { const rows = await history(worker.id); return rows.some((m) => m.codexText?.itemId === "progress-2") ? rows : undefined; });
  const progress = before.filter((m) => m.codexText);
  assert.equal(progress.length, 2); assert.ok(progress.every(itemProgress));
  assert.equal(progressIds(before, () => true).size, 2);
  const startIndex = frames.length;
  const sent = await h.json(`/api/bots/${worker.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Use second option", joinedTurnId: "forged", codexText: progress[0].codexText }) });
  assert.equal(sent.steered, true);
  const after = await until(async () => { const rows = await history(worker.id); return rows.some((m) => m.codexText?.itemId === "after-join") ? rows : undefined; });
  const joined = after.find((m) => m.text === "Use second option")!;
  assert.equal(joined.midTurn, true); assert.equal(joined.joinedTurnId, progress[0].codexText!.turnId); assert.notEqual(joined.joinedTurnId, "forged");
  assert.equal(joined.codexText, undefined);
  assert.equal(progressIds(after, () => true).size, 0);
  let replayed: AppState = { ...initialState, bots: [{ ...worker, messages: initialHistory } as Bot], bloks: [] };
  const workerFrames = frames.filter(f => f.threadId === worker.threadId && f.kind === "message");
  for (const f of [...workerFrames, ...workerFrames]) replayed = reducer(replayed, { type: "messageAdded", threadId: f.threadId, message: f.message });
  assert.deepEqual(replayed.bots[0].messages.map(m => [m.id, m.codexText, m.joinedTurnId]), after.map(m => [m.id, m.codexText, m.joinedTurnId]), "actual SSE replay and stored reload disagree");
  assert.deepEqual(progressIds(replayed.bots[0].messages, () => true), progressIds(after, () => true));
  assert.equal(frames.slice(startIndex).filter((f) => f.kind === "message.patch").length, 0);
  for (const marker of ["NO_FINAL", "ASYNC_FINAL", "EXPLICIT_Q NO_FINAL"]) {
    const other = await bot(marker); await agentSend(other.id, marker);
    const rows = await until(async () => { const all = await h.json("/api/bots?messages=0"); const found = all.bots.find((b: any) => b.id === other.id); const rows = await history(other.id); return !found.busy && rows.some((m) => m.codexText) ? rows : undefined; });
    const saved = rows.filter((m) => m.codexText); assert.ok(saved.some(itemProgress));
    if (marker.includes("EXPLICIT_Q")) { const q = saved.find(m => m.codexText!.itemId === "explicit-question")!; assert.equal(q.codexText!.questions, "present"); assert.equal(itemProgress(q), false); }
    const display = foldTurns(rows, false); const said = display.rows.flatMap((r) => r.kind === "said" ? r.items.map((x) => x.message) : []);
    assert.equal(said.at(-1)?.codexText?.itemId, marker.includes("NO_FINAL") ? "progress-2" : "async-answer");
    const live = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === other.id);
    assert.equal(live.unread, marker !== "NO_FINAL", "fallback creates no unread; a normal final retains it");
  }
  const roomWorker = await bot("Roomworker");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Neutral room", memberIds: [sender.id, roomWorker.id] }) });
  assert.ok(room?.id);
  await h.json(`/api/bloks/${room.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "@Roomworker NO_FINAL" }) });
  const roomRows = await until(async () => { const rows = (await h.json(`/api/bloks/${room.id}/messages?limit=100`)).messages as Message[]; return rows.some(m => m.codexText?.itemId === "progress-2") ? rows : undefined; });
  assert.ok(roomRows.filter(m => m.codexText).every(m => m.codexText!.origin === "agent"), "authenticated room origin was lost at dispatch");
  const personRoomWorker = await bot("Roomhelper");
  const { blok: personRoom } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Personal room", memberIds: [sender.id, personRoomWorker.id] }) });
  await h.json(`/api/bloks/${personRoom.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Roomhelper NO_FINAL" }) });
  const personRoomRows = await until(async () => { const rows = (await h.json(`/api/bloks/${personRoom.id}/messages?limit=100`)).messages as Message[]; return rows.some(m => m.codexText?.itemId === "progress-2") ? rows : undefined; });
  assert.ok(personRoomRows.filter(m => m.codexText).every(m => m.codexText!.origin === "person"), "person-started room became quiet");
  const interrupted = await bot("Stopped worker"); await agentSend(interrupted.id, "WORK_HOLD");
  await until(async () => { const rows = await history(interrupted.id); return rows.some(m => m.codexText?.itemId === "progress-2") ? rows : undefined; });
  await h.json(`/api/bots/${interrupted.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: interrupted.threadId }) });
  const stopped = await until(async () => { const found = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === interrupted.id); return !found.busy ? found : undefined; });
  assert.equal(stopped.unread, false, "stopping progress-only work manufactured unread");
  const stoppedHistory = await history(interrupted.id);
  const stoppedVisible = foldTurns(stoppedHistory, false).rows.flatMap(r => r.kind === "said" ? r.items.map(x => x.message) : []);
  assert.equal(stoppedVisible.at(-1)?.codexText?.itemId, "progress-2");
  const refuses = await bot("Queued input"); await agentSend(refuses.id, "REJECT_STEER");
  await until(async () => { const rows = await history(refuses.id); return rows.filter((m) => m.codexText).length === 2 ? rows : undefined; });
  const queued = await h.json(`/api/bots/${refuses.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Wait for next turn", joinedTurnId: "forged" }) });
  assert.equal(queued.queued, true);
  const queuedHistory = await history(refuses.id);
  const waiting = queuedHistory.find((m) => m.text === "Wait for next turn")!;
  assert.equal(waiting.joinedTurnId, undefined); assert.equal(waiting.midTurn, undefined);
  assert.equal(progressIds(queuedHistory, () => true).size, 2, "queued person input did not join the running turn");
  const previews = frames.filter((f) => f.kind === "runtime" && f.event.type === "content.delta" && f.event.codexText?.display === "progress");
  assert.ok(previews.length >= 6, "private signal lost before the real SSE preview boundary");
  assert.equal(frames.filter((f) => f.kind === "message.patch").length, 0, "render-time transitions must not rewrite history");
  const attention = readFileSync(tracePath, "utf8").trim().split("\n").map(x => JSON.parse(x));
  const quietFrames = attention.filter(x => itemProgress(x.frame.message));
  assert.ok(quietFrames.length >= 6);
  assert.ok(quietFrames.every(x => x.wake === null && x.preview === null), "item-time progress escaped the real wake/preview boundary");
  assert.ok(attention.some(x => x.frame.message?.codexText?.phase === "final_answer" && x.preview?.body === "A visible answer"), "ordinary final preview lost");
});
