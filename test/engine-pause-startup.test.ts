// Real isolated server startup, persisted restriction, actual fake driver.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnginePauses, pauseFile } from "../server/engine-pauses.ts";
import { startHarness } from "./helpers/server.ts";

test("persisted Claude restriction precedes actual server factories/default suggestions across restart", async t => {
  const home=mkdtempSync(join(tmpdir(),"bloks-pause-startup-")), data=join(home,".bloks");
  mkdirSync(data);
  const cli=join(home,"fake-claude.cjs"), counter=join(home,"calls.jsonl"), file=join(data,"engine-pauses.json");
  writeFileSync(cli,`#!${process.execPath}\n`+`
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({args})+'\\n');
if(args[0]==='--version')console.log('9.9.9 (Claude Code)');
else if(args[0]==='auth')console.log(JSON.stringify({loggedIn:true}));
else {process.stdin.resume();process.stdin.on('end',()=>console.log('A fake summary.'));}
`,{mode:0o700});
  const configured={instances:{claude:{driver:"claudeAgent",config:{cli}}},
    agentDefaults:{modelSelection:{instanceId:"claude",model:"claude-sonnet-5"}}};
  writeFileSync(join(data,"config.json"),JSON.stringify(configured));
  const policy=new EnginePauses(pauseFile(file));
  await policy.activate({kind:"owner"},{id:"startup-restriction",agents:"all",selector:{family:"claude"},until:Date.now()+60_000,timeZone:"UTC"});
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  for(let restart=0;restart<2;restart++){
    const h=await startHarness({HOME:home,USERPROFILE:home});
    try{
      const health=await h.fetch("/api/health");assert.equal(health.status,200,h.logs());
      const suggestion=await h.fetch("/api/agents/suggest",{method:"POST",body:JSON.stringify({description:"A synthetic fixture role"})});
      assert.equal(suggestion.status,200,h.logs());await suggestion.json();
      assert.equal(existsSync(counter),false,"startup protection called a fake provider before admission");
      const saved=JSON.parse(readFileSync(join(data,"config.json"),"utf8"));
      assert.equal(saved.instances.claude.config.cli,cli);
      assert.deepEqual(saved.agentDefaults.modelSelection,configured.agentDefaults.modelSelection);
      const persisted=JSON.parse(readFileSync(file,"utf8"));
      assert.equal(persisted.pauses[0].id,"startup-restriction");
      assert.equal(persisted.invocations.length,0);
    }finally{await h.stop();}
  }
});
