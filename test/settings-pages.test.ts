import test from "node:test";
import assert from "node:assert/strict";
import { SettingsPages, SETTINGS_PAGE_BYTES, SETTINGS_PAGE_ROWS } from "../server/settings-pages.ts";
function body(page: ReturnType<SettingsPages["read"]>) { assert.equal(page.status, 200); return page.body as {
  rows: {reference:string;observation:object}[];total:number;continuation:string|null;
}; }
const query = (category = "agent", cursor?: string) => new URLSearchParams({ category, ...(cursor ? {cursor} : {}) });

test("category discovery touches no owner; invalid selection never reflects request data", () => {
  const pages = new SettingsPages(); let calls = 0;
  const records = () => { calls++; throw new Error("PRIVATE"); };
  assert.equal(pages.read(new URLSearchParams(), "PRIVATE_CALLER", records).status, 200);
  for (const q of ["category=PRIVATE", "category=agent&category=room", "id=PRIVATE", "category=agent&id=PRIVATE", "category=agent&cursor=PRIVATE"]) {
    const result = pages.read(new URLSearchParams(q), "PRIVATE_CALLER", records);
    assert.equal(result.status, 400); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  }
  assert.equal(calls, 0);
});

test("large collections page by stable opaque id with bounded rows and bytes", () => {
  const pages = new SettingsPages();
  const records = Array.from({length:163}, (_,i) => ({id:`PRIVATE_ID_${i}`,visible:true,project:() => ({safe:i})}));
  let cursor: string | undefined; const refs: string[] = []; const output: string[] = [];
  do {
    const result = pages.read(query("agent",cursor), "PRIVATE_CALLER", () => records);
    const page = body(result); output.push(JSON.stringify(result));
    assert.equal(page.total, 163); assert.ok(page.rows.length <= SETTINGS_PAGE_ROWS);
    assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= SETTINGS_PAGE_BYTES);
    refs.push(...page.rows.map((r) => r.reference)); cursor = page.continuation ?? undefined;
  } while(cursor);
  assert.equal(refs.length,163); assert.equal(new Set(refs).size,163);
  assert.deepEqual(refs, [...refs].sort());
  assert.ok(!output.join("").includes("PRIVATE"));
  for(const line of output) {
    const c = JSON.parse(line).body.continuation;
    if(c) assert.ok(!Buffer.from(c.split('.')[0], 'base64url').toString().includes('PRIVATE'));
  }
});

test("hidden records never project or affect totals; membership is rechecked between pages", () => {
  const pages = new SettingsPages(); let projections = 0;
  const records = Array.from({length:24}, (_,i) => ({id:`r${i}`,visible:true,project:() => {projections++;return {safe:true};}}));
  records.push({id:"PRIVATE_HIDDEN",visible:false,project:() => {throw new Error('hidden projector reached');}});
  const first = body(pages.read(query("room"), "agent", () => records));
  assert.equal(first.total,24); assert.equal(projections,20); assert.ok(first.continuation);
  for(const record of records) record.visible = false;
  const next = body(pages.read(query("room",first.continuation!), "agent", () => records));
  assert.equal(next.total,0); assert.deepEqual(next.rows,[]); assert.equal(next.continuation,null);
  assert.equal(projections,20);
  const hiddenRef = pages.reference("room","PRIVATE_HIDDEN");
  assert.equal(pages.read(new URLSearchParams({category:"room",id:hiddenRef}),"agent",() => records).status,404);
});

test("continuations cannot be tampered, reused by another caller/category/selection or survive a restart", () => {
  const pages = new SettingsPages(); const records = Array.from({length:21},(_,i) => ({id:String(i),visible:true,project:() => ({safe:true})}));
  const first = body(pages.read(query(),"a",() => records)); const cursor = first.continuation!;
  for(const [instance,q,caller] of [
    [pages,query("agent",cursor),"b"], [pages,query("room",cursor),"a"],
    [pages,query("agent",cursor.slice(0,-2)+"xx"),"a"], [new SettingsPages(),query("agent",cursor),"a"],
    [pages,new URLSearchParams({category:"agent",cursor,id:pages.reference("agent","0")}),"a"],
  ] as const) assert.equal(instance.read(q,caller,() => records).status,400);
});

test("live insertion/deletion has documented stable-id semantics without a retained snapshot", () => {
  const pages = new SettingsPages(); let records = Array.from({length:40},(_,i) => ({id:String(i),visible:true,project:() => ({safe:true})}));
  const first = body(pages.read(query(),"a",() => records));
  const after = first.rows.at(-1)!.reference;
  records = records.filter((r) => pages.reference("agent",r.id) <= after);
  const added = Array.from({length:40},(_,i) => ({id:`new${i}`,visible:true,project:() => ({safe:true})}));
  records.push(...added);
  const next = body(pages.read(query("agent",first.continuation!),"a",() => records));
  const expected = records.map((r) => pages.reference("agent",r.id)).filter((id) => id > after).sort().slice(0,20);
  assert.deepEqual(next.rows.map((r) => r.reference),expected);
  assert.equal(next.total,records.length);
});

test("whole-row omission bounds large output and neutralizes owner errors", () => {
  const pages = new SettingsPages();
  const rows = [
    {id:"PRIVATE_ID",visible:true,project:() => ({text:"PRIVATE".repeat(100000)})},
    {id:"failure",visible:true,project:() => {throw new Error("PRIVATE_EXCEPTION");}},
  ];
  const result = body(pages.read(query(),"a",() => rows));
  assert.equal(result.rows.length,2);assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.ok(JSON.stringify(result).includes('size_limit'));assert.ok(JSON.stringify(result).includes('owner_observation_unavailable'));
});
