import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function isolated(code:string){
  const home=mkdtempSync(join(tmpdir(),'bloks-settings-library-'));
  try{execFileSync(process.execPath,['--input-type=module','--eval',`
    import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    const s=await import(${JSON.stringify(new URL('../server/skills.ts',import.meta.url).href)});
    const dir=join(process.env.HOME,'.bloks','skills');
    ${code}
  `],{env:{...process.env,HOME:home},stdio:'pipe'});}finally{rmSync(home,{recursive:true,force:true});}
}

test('library metadata starts unknown, captures only natural owner reads and never retains instruction bodies',()=>isolated(`
  assert.deepEqual(s.observedSkillLibrary(),{lastObserved:null,lastAttempt:null});
  const builtin=s.listSkills();assert.ok(builtin.length);
  const before=s.observedSkillLibrary();assert.equal(before.lastAttempt.status,'complete');
  s.installSkill({id:'fixture',name:'Fixture',description:'A neutral fixture',body:'PRIVATE_INSTRUCTION_SENTINEL'});
  const invalid=s.observedSkillLibrary();assert.ok(invalid.lastObserved.invalidatedAt!==null);
  assert.equal(invalid.lastObserved.observedAt,before.lastObserved.observedAt);
  s.listSkills();const observed=s.observedSkillLibrary();
  const item=observed.lastObserved.items.find((x)=>x.id==='fixture');assert.equal(item.body,true);
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_INSTRUCTION_SENTINEL'));
  assert.equal(observed.lastObserved.invalidatedAt,null);
  observed.lastObserved.items[0].name='mutated caller clone';
  assert.notEqual(s.observedSkillLibrary().lastObserved.items[0].name,'mutated caller clone');
`));

test('library getter has no filesystem effects and failed owner reads preserve last observed values with unknown completeness',()=>isolated(`
  s.installSkill({id:'fixture',name:'Fixture',body:'fixture body'});s.listSkills();
  const before=s.observedSkillLibrary().lastObserved;
  const original=fs.readdirSync;fs.readdirSync=()=>{throw Object.assign(new Error('PRIVATE_ERROR'),{code:'EACCES'});};syncBuiltinESMExports();
  s.listSkills();const failed=s.observedSkillLibrary();assert.deepEqual(failed.lastObserved,before);assert.equal(failed.lastAttempt.status,'unavailable');
  fs.readdirSync=original;syncBuiltinESMExports();
  for(const name of ['readFileSync','readdirSync','statSync','writeFileSync','mkdirSync','unlinkSync'])fs[name]=()=>{throw new Error('IO trap');};syncBuiltinESMExports();
  for(let i=0;i<20;i++)assert.deepEqual(s.observedSkillLibrary(),failed);
`));

test('failed saves do not invalidate an observation; successful delete invalidates but retains useful dated metadata',()=>isolated(`
  s.installSkill({id:'fixture',name:'Fixture',body:'fixture body'});s.listSkills();const before=s.observedSkillLibrary();
  const write=fs.writeFileSync;fs.writeFileSync=()=>{throw new Error('write trap');};syncBuiltinESMExports();
  assert.throws(()=>s.installSkill({id:'fixture',name:'New',body:'new body'}));assert.deepEqual(s.observedSkillLibrary(),before);
  fs.writeFileSync=write;syncBuiltinESMExports();
  assert.equal(s.deleteSkill('missing'),false);assert.deepEqual(s.observedSkillLibrary(),before);
  assert.equal(s.deleteSkill('fixture'),true);const deleted=s.observedSkillLibrary();assert.ok(deleted.lastObserved.invalidatedAt!==null);
  assert.equal(deleted.lastObserved.items.find((x)=>x.id==='fixture').name,'Fixture');
  s.listSkills();assert.ok(!s.observedSkillLibrary().lastObserved.items.some((x)=>x.id==='fixture'));
`));

test('retained library metadata and text have explicit bounds, with whole-value omission and no partial secret fragment',()=>isolated(`
  fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<220;i++)fs.writeFileSync(join(dir,'f'+i+'.md'),'---\\nname: Fixture '+i+'\\n---\\nBody');
  const actual=s.listSkills();const observed=s.observedSkillLibrary().lastObserved;
  assert.ok(observed.omittedItems>0);assert.equal(actual.length-observed.items.length,observed.omittedItems);
  assert.ok(observed.items.length<=s.MAX_USER_SKILLS+actual.filter((x)=>x.source==='builtin').length);
  for(let i=0;i<220;i++)fs.unlinkSync(join(dir,'f'+i+'.md'));
  const long='SENSITIVE_LONG_NAME'.repeat(40);fs.writeFileSync(join(dir,'long.md'),'---\\nname: '+long+'\\n---\\nBody');
  s.listSkills();const item=s.observedSkillLibrary().lastObserved.items.find((x)=>x.id==='long');
  assert.equal(item.name,null);assert.ok(item.omitted.includes('name'));assert.ok(!JSON.stringify(item).includes(long));
`));
