import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isolated(code: string): void {
  const home = mkdtempSync(join(tmpdir(), "bloks-settings-saved-"));
  try {
    const configUrl = new URL("../server/config.ts", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const c = await import(${JSON.stringify(configUrl)});
      const file = join(c.DATA_DIR, 'config.json');
      fs.mkdirSync(c.DATA_DIR, {recursive:true});
      ${code}
    `], { env: { ...process.env, HOME: home, XAI_API_KEY: "ENV_SECRET_FIXTURE", COMPOSIO_KEY: "ENV_SECRET_FIXTURE" }, stdio: "pipe" });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("saved observation starts unknown and captures before environment and legacy resolution", () => isolated(`
  assert.equal(c.savedConfigObservation(), null);
  fs.writeFileSync(file, JSON.stringify({agents:{turnLimit:24},profile:{about:''}}));
  const live = c.loadConfig();
  assert.equal(live.composio.key, 'ENV_SECRET_FIXTURE');
  assert.equal(live.providers.grok.key, 'ENV_SECRET_FIXTURE');
  const saved = c.savedConfigObservation();
  assert.deepEqual(saved.value, {agents:{turnLimit:24},profile:{about:''}});
  assert.equal(saved.source, 'owner-load');
  assert.ok(Number.isFinite(saved.observedAt));
  live.agents.turnLimit = 1;
  saved.value.agents.turnLimit = 2;
  assert.equal(c.savedConfigObservation().value.agents.turnLimit, 24);
`));

test("pure getter never rereads a changed file or touches IO", () => isolated(`
  fs.writeFileSync(file, '{"agents":{"turnLimit":24}}'); c.loadConfig();
  fs.writeFileSync(file, '{"agents":{"turnLimit":8}}');
  for (const name of ['readFileSync','writeFileSync','renameSync','mkdirSync']) fs[name] = () => { throw new Error('IO trap'); };
  syncBuiltinESMExports();
  for (let i=0;i<20;i++) assert.equal(c.savedConfigObservation().value.agents.turnLimit, 24);
`));

test("failed owner loads and saves cannot replace the last successful observation", () => isolated(`
  fs.writeFileSync(file, '{"agents":{"turnLimit":24}}'); c.loadConfig();
  const before = c.savedConfigObservation();
  assert.throws(() => c.saveConfig({agents:{turnLimit:8}}, () => { throw new Error('save refused'); }));
  assert.deepEqual(c.savedConfigObservation(), before);
  const read = fs.readFileSync;
  fs.readFileSync = (...args) => { if(args[0] === file) throw Object.assign(new Error('read refused'),{code:'EMFILE'}); return read(...args); };
  syncBuiltinESMExports();
  assert.throws(() => c.loadConfig());
  assert.deepEqual(c.savedConfigObservation(), before);
  fs.readFileSync = read; syncBuiltinESMExports();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('rename refused'); }; syncBuiltinESMExports();
  assert.throws(() => c.saveConfig({agents:{turnLimit:8}}));
  assert.deepEqual(c.savedConfigObservation(), before);
  fs.renameSync = rename; syncBuiltinESMExports();
  assert.equal(c.saveConfig({agents:{turnLimit:8}}).agents.turnLimit, 8);
  assert.equal(c.savedConfigObservation().value.agents.turnLimit, 8);
  assert.equal(c.savedConfigObservation().source, 'owner-save');
`));

test("successful removals observe exactly the saved bytes without environment credentials", () => isolated(`
  fs.writeFileSync(file, JSON.stringify({secrets:{FIXTURE:'PRIVATE'},providers:{grok:{key:'PRIVATE'}},xai:{key:'PRIVATE'}}));
  c.loadConfig();
  c.forgetSecret('FIXTURE');
  assert.deepEqual(c.savedConfigObservation().value, JSON.parse(fs.readFileSync(file,'utf8')));
  const live = c.disconnectProvider('grok');
  assert.equal(live.providers.grok.key, 'ENV_SECRET_FIXTURE');
  const saved = c.savedConfigObservation();
  assert.equal(saved.value.providers.grok, undefined);
  assert.equal(saved.value.xai, undefined);
  assert.deepEqual(saved.value, JSON.parse(fs.readFileSync(file,'utf8')));
`));
