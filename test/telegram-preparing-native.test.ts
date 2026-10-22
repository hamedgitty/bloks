// Pause the real checkpoint preparation, not a guessed busy/HTTP gap.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { personFixture, until, LEE } from "./helpers/telegram-person.ts";

async function preparing(t: TestContext, kind: "codex" | "claude" = "codex") {
  const env: Record<string, string> = {};
  const realGit = (process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "git")).find((file) => existsSync(file));
  assert.ok(realGit, "the fixture has no real Git for its other operations");
  const f = await personFixture(t, kind, { env, seed(root) {
    const project = join(root, "project"), bin = join(root, "gate-bin");
    mkdirSync(project); mkdirSync(bin);
    writeFileSync(join(project, "AGENTS.md"), "Synthetic project instructions.\n");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const root=${JSON.stringify(root)},project=${JSON.stringify(project)},real=${JSON.stringify(realGit)},args=process.argv.slice(2);
if(args[0]==='-C'&&args[1]===project&&args[2]==='ls-files'&&args.includes('--others')&&args.includes('--ignored')&&existsSync(join(root,'gate-armed'))){
  process.on('SIGTERM',()=>{writeFileSync(join(root,'gate-outcome'),'killed');process.exit(143)});
  writeFileSync(join(root,'gate-entered'),String(process.pid));
  while(!existsSync(join(root,'gate-release')))await new Promise(r=>setTimeout(r,10));
  writeFileSync(join(root,'gate-outcome'),'released');
}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});
process.exit(result.status??1);
`, { mode: 0o755 });
    // Only this fixture shim is added, not any real engine executable.
    env.PATH = bin;
  } });
  const configured = await f.ownerJson(`/api/bots/${f.bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: join(f.root, "project") }) });
  assert.equal(configured.bot.cwd, join(f.root, "project"), "the fixture's working-folder setting did not apply");
  return { ...f,
    arm() { rmSync(join(f.root, "gate-entered"), { force: true }); rmSync(join(f.root, "gate-outcome"), { force: true }); rmSync(join(f.root, "gate-release"), { force: true }); writeFileSync(join(f.root, "gate-armed"), "1"); },
    async entered() { await until(() => existsSync(join(f.root, "gate-entered")), "the real checkpoint Git call did not enter the gate"); },
    release() { writeFileSync(join(f.root, "gate-release"), "1"); },
    async released() { await until(() => existsSync(join(f.root, "gate-outcome")), "the Git shim did not finish"); assert.equal(readFileSync(join(f.root, "gate-outcome"), "utf8"), "released", "Git timed out instead of being released"); rmSync(join(f.root, "gate-armed"), { force: true }); },
  };
}

for (const kind of ["claude"] as const) {
  test(`${kind}: taking out a preparing person prevents engine input and marks the words unsent`, async (t) => {
    const f = await preparing(t, kind);
    // No earlier engine turn: its after-turn photograph could otherwise
    // enter the same shim while this new message is still in the queue.
    f.say("ADMISSION_ONLY", LEE);
    const person = await until(async () => (await f.status()).people.find((p: any) => p.name === "Lee"), "the person did not knock");
    await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "decline" });
    await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "allow" });
    assert.equal(f.records().length, 0, "admission setup started an earlier engine turn");
    f.arm();
    try {
      f.say("PREPARING_MEMBER_WORDS FAKE_REPLY", LEE);
      await f.entered();
      assert.equal(f.records().some((r) => r.text?.includes("PREPARING_MEMBER_WORDS")), false, "the gate was after engine input");
      assert.equal((await f.ownerJson("/api/bots")).bots.find((b: any) => b.id === f.bot.id).busy, true);
      await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: person.id, action: "remove" });
      f.release(); await f.released(); await f.idle();
      assert.equal(f.records().some((r) => r.text?.includes("PREPARING_MEMBER_WORDS")), false, "the removed person's preparing words reached the engine");
      const words = (await f.messages()).find((m) => m.text === "PREPARING_MEMBER_WORDS FAKE_REPLY");
      assert.ok(words); assert.equal(words.queued, false); assert.equal(words.unsent, true, "the preparing words were not marked unsent");
      assert.ok((await f.messages()).some((m) => m.kind === "notice" && /removed before/.test(m.text ?? "")));
      assert.equal(f.sent(LEE).some((c) => c.body.text === "Hello Lee"), false);
    } finally { f.release(); }
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "NEXT_OWNER_WORDS FAKE_TEXT" });
    await until(() => f.records().some((r) => r.text?.endsWith("NEXT_OWNER_WORDS FAKE_TEXT")), "the owner's next turn did not run");
    await f.idle();
  });
}

test("an owner stop during checkpoint preparation is consumed before engine input", async (t) => {
  const f = await preparing(t);
  f.arm();
  try {
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "PREPARING_OWNER_WORDS FAKE_TEXT" });
    await f.entered();
    assert.equal(f.records().some((r) => r.text?.includes("PREPARING_OWNER_WORDS")), false, "the gate was after engine input");
    await f.post(`/api/bots/${f.bot.id}/interrupt`);
    f.release(); await f.released(); await f.idle();
    assert.equal(f.records().some((r) => r.text?.includes("PREPARING_OWNER_WORDS")), false, "the stopped preparing words reached the engine");
    assert.ok((await f.messages()).some((m) => m.kind === "notice" && /Stopped before Planning had started/.test(m.text ?? "")), "the early stop has no notice");
  } finally { f.release(); }
  await f.post(`/api/bots/${f.bot.id}/messages`, { text: "NEXT_OWNER_WORDS FAKE_TEXT" });
  await until(() => f.records().some((r) => r.text?.endsWith("NEXT_OWNER_WORDS FAKE_TEXT")), "the stop leaked into the next turn");
  await f.idle();
});
