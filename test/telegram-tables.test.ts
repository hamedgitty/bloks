import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deliveries, messages } from "../server/telegram-format.ts";
import { parseUpdates, post, replyText, send, TelegramError } from "../server/telegram.ts";

const table = "| Item | Price |\n| :--- | ---: |\n| Sample A | **12** |\n| [Sample B](https://example.com/a-(b)) | 18 |";
const rich = (text: string) => deliveries(text, true).filter((d) => d.richHtml).map((d) => d.richHtml!);
const accepted = () => Response.json({ ok: true, result: { message_id: 81 } });
function record(t: TestContext, answer: (method: string, body: any, n: number) => Response | Promise<Response> = accepted) {
  const calls: { method: string; body: any }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    return answer(method, body, calls.length);
  });
  return calls;
}

test("native tables keep headings, alignment, cell order, styles and complete links", () => {
  assert.deepEqual(rich(table), ['<table><tr><th align="left">Item</th><th align="right">Price</th></tr><tr><td align="left">Sample A</td><td align="right"><b>12</b></td></tr><tr><td align="left"><a href="https://example.com/a-(b)">Sample B</a></td><td align="right">18</td></tr></table>']);
});

test("encoded destinations and escaped HTML attributes remain complete in cells", () => {
  const input = '| Source | Value |\n| --- | --- |\n| [Offer](https://example.com/a-%28b%29?q=1&x=2) | _yes_ |';
  assert.match(rich(input)[0]!, /href="https:\/\/example.com\/a-%28b%29\?q=1&amp;x=2">Offer<\/a>/);
  assert.match(rich(input)[0]!, /<i>yes<\/i>/);
});

test("blank headings, empty cells, escaped pipes, code, Unicode and hostile tags retain positions", () => {
  const [html] = rich('| | Value | Note |\n| --- | :---: | --- |\n| Stage A | `a\\|b` | <img src="https://example.com/x"> |\n| 😀 | 你好 | |');
  assert.ok(html);
  assert.match(html, /<th align="left"><\/th><th align="center">Value/);
  assert.match(html, /<td align="center"><code>a\|b<\/code><\/td>/);
  assert.match(html, /&lt;img src="https:\/\/example.com\/x"&gt;/);
  assert.match(html, /😀<\/td><td align="center">你好<\/td><td align="left"><\/td>/);
  assert.doesNotMatch(html, /<img|<script/);
});

test("ordinary and plain replies are exactly the previous formatter result", () => {
  for (const text of ["## Heading\n\n**Bold** and _italic_.\n- One\n- Two", "```txt\n" + table + "\n```", "~~~\n" + table + "\n~~~", "    | A | B |\n    | --- | --- |\n    | 1 | 2 |", "- List\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |", "a\\|b\n---\\|---", "| A | B |\n| --- |", "prose ".repeat(3000)]) {
    assert.deepEqual(deliveries(text, true), [{ chunks: messages(text, true) }]);
  }
  assert.deepEqual(deliveries(table, false), [{ chunks: messages(table, false) }]);
});

test("mixed prose, tables and fenced examples retain their full order", () => {
  const ds = deliveries("**Before**\n\n" + table + "\n\n```\n" + table + "\n```\n\n" + table + "\n\n- After", true);
  assert.equal(ds.length, 5);
  assert.equal(ds[0]!.chunks[0]!.html, "<b>Before</b>");
  assert.equal(ds[1]!.richHtml, rich(table)[0]);
  assert.match(ds[2]!.chunks[0]!.html!, /^<pre>/);
  assert.equal(ds[3]!.richHtml, ds[1]!.richHtml);
  assert.equal(ds[4]!.chunks[0]!.html, "• After");
});

test("long tables split only at rows, repeat headings and retain every row once", () => {
  const input = "Name | Value\n--- | ---\n" + Array.from({ length: 1000 }, (_, i) => `Row${i} | ${"😀".repeat(12)}`).join("\n");
  const tables = rich(input);
  assert.ok(tables.length > 2);
  const ids: number[] = [];
  for (const html of tables) {
    assert.ok(Buffer.byteLength(html, "utf8") <= 30_000);
    assert.ok((html.match(/<tr>/g) ?? []).length <= 400);
    assert.match(html, /^<table><tr><th align="left">Name/);
    ids.push(...Array.from(html.matchAll(/>Row(\d+)</g), (m) => Number(m[1])));
  }
  assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => i));
});

test("empty rows hit the block bound even when text is tiny", () => {
  const tables = rich("| A | B |\n| - | - |\n" + "| | |\n".repeat(1000));
  assert.ok(tables.length >= 3);
  assert.equal(tables.reduce((n, h) => n + (h.match(/<tr>/g) ?? []).length - 1, 0), 1000);
  assert.ok(tables.every((h) => (h.match(/<tr>/g) ?? []).length <= 400));
});

for (const [name, input] of [
  ["excess columns", Array.from({ length: 21 }, (_, i) => `H${i}`).join(" | ") + "\n" + Array(21).fill("---").join(" | ") + "\n" + Array.from({ length: 21 }, (_, i) => `Cell${i}`).join(" | ")],
  ["excess body cells", "| A | B |\n| --- | --- |\n| 1 | 2 | Keep this cell |"],
  ["oversized row", "| A | B |\n| --- | --- |\n| 1 | " + "x".repeat(35_000) + " |"],
  ["oversized header", "| " + "H".repeat(35_000) + " | B |\n| --- | --- |\n| 1 | 2 |"],
] as const) test(`${name} uses complete legacy fallback`, () => {
  const ds = deliveries(input, true);
  assert.ok(ds.every((d) => !d.richHtml));
  assert.deepEqual(ds.flatMap((d) => d.chunks), messages(input, true));
});

test("twenty columns and whitespace middle headings keep every position", () => {
  const heading = Array.from({ length: 20 }, (_, i) => i === 1 ? "  " : `H${i}`).join(" | ");
  const body = Array.from({ length: 20 }, (_, i) => `Cell${i}`).join(" | ");
  const [html] = rich(heading + "\n" + Array(20).fill("---").join(" | ") + "\n" + body);
  assert.equal((html!.match(/<th /g) ?? []).length, 20);
  assert.equal((html!.match(/<td /g) ?? []).length, 20);
  assert.match(html!, /H0<\/th><th align="left"><\/th><th align="left">H2/);
  assert.match(html!, /Cell19<\/td><\/tr><\/table>$/);
});

test("short rows pad empty cells, header-only tables and outer-pipe-free tables work", () => {
  assert.match(rich("A | B | C\n- | - | -\n1 | 2")[0]!, /<td align="left">1<\/td><td align="left">2<\/td><td align="left"><\/td>/);
  assert.equal(rich("A | B\n- | -").length, 1);
  assert.match(rich("A | B\n- | -\nOnly A")[0]!, /<td align="left">Only A<\/td><td align="left"><\/td>/);
  for (const input of ["| A |\n---\nValue", "A\n| --- |\nValue"]) assert.match(rich(input)[0]!, /<th align="left">A<\/th><\/tr><tr><td align="left">Value<\/td>/);
  assert.deepEqual(deliveries("A\n---\nWords", true), [{ chunks: messages("A\n---\nWords", true) }]);
});

test("hostile table-like input has bounded work and no loss", () => {
  const inputs = ["| A | B |\n| --- | --- |\n" + "| [x](https://example.com/( ".repeat(2500), ("| **x ".repeat(10) + "\n").repeat(1000)];
  const before = Date.now();
  for (const input of inputs) {
    const ds = deliveries(input, true);
    assert.ok(ds.flatMap((d) => d.chunks).every((c) => c.plain.length <= 4000));
    assert.deepEqual(ds.flatMap((d) => d.chunks), messages(input, true));
  }
  assert.ok(Date.now() - before < 2000);
});

test("only a table uses sendRichMessage, in order between existing formatted prose", async (t) => {
  const calls = record(t);
  let count = 0;
  await send("T", 42, "**Before**\n\n" + table + "\n\n- After", true, () => count++);
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "sendRichMessage", "sendMessage"]);
  assert.deepEqual(calls[1]!.body, { chat_id: 42, rich_message: { html: rich(table)[0] } });
  assert.equal(calls[0]!.body.text, "<b>Before</b>");
  assert.equal(calls[2]!.body.text, "• After");
  assert.equal(count, 3);
});

for (const status of [400, 404]) test(`definite rich HTTP ${status} rejection uses existing HTML then plain fallback`, async (t) => {
  const calls = record(t, (method, body) => method === "sendRichMessage" ? new Response("{}", { status }) : body.parse_mode ? new Response("{}", { status: 400 }) : accepted());
  let count = 0;
  await send("T", 42, table, true, () => count++);
  assert.equal(count, 1);
  assert.deepEqual(calls.map((c) => c.method), ["sendRichMessage", "sendMessage", "sendMessage"]);
  assert.deepEqual(calls[2]!.body, { chat_id: 42, text: messages(table, true)[0]!.plain });
  assert.ok(calls[2]!.body.text.includes("https://example.com/a-(b)"));
});

for (const status of [401, 403, 429, 500, 502]) test(`HTTP ${status} cannot replay a table as fallback`, async (t) => {
  const calls = record(t, () => Response.json({ parameters: { retry_after: 31 } }, { status }));
  let count = 0;
  await assert.rejects(send("T", 42, table + "\n\nAfter", true, () => count++), new RegExp(`HTTP ${status}`));
  assert.equal(calls.length, 1);
  assert.equal(count, 0);
});

for (const [name, answer] of [
  ["network uncertainty", () => { throw Error("synthetic uncertain send"); }],
  ["malformed JSON", () => new Response("invalid json")],
  ["missing confirmation", () => Response.json({ ok: true, result: {} })],
  ["HTTP success with refusal body", () => Response.json({ ok: false, error_code: 400 })],
] as const) test(`${name} stops without fallback or tail`, async (t) => {
  const calls = record(t, answer);
  await assert.rejects(send("T", 42, table + "\n\nAfter", true));
  assert.equal(calls.length, 1);
});

test("a bounded 429 retry uses the same rich method and body, accounts once", async (t) => {
  const calls = record(t, (_method, _body, n) => n === 1 ? Response.json({ parameters: { retry_after: 0 } }, { status: 429 }) : accepted());
  let count = 0;
  await send("T", 42, table, true, () => count++);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0]!.method, "sendRichMessage");
  assert.equal(count, 1);
});

test("a later rich refusal falls back only that table after earlier acceptance", async (t) => {
  let richCalls = 0;
  const calls = record(t, (method) => method === "sendRichMessage" && ++richCalls === 2 ? new Response("{}", { status: 400 }) : accepted());
  let count = 0;
  await send("T", 42, table + "\n\nBetween\n\n" + table + "\n\nTail", true, () => count++);
  assert.deepEqual(calls.map((c) => c.method), ["sendRichMessage", "sendMessage", "sendRichMessage", "sendMessage", "sendMessage"]);
  assert.equal(count, 4);
  assert.equal(calls[1]!.body.text, "Between");
  assert.equal(calls[3]!.body.text, messages(table, true)[0]!.html);
  assert.equal(calls[4]!.body.text, "Tail");
});

test("partial acceptance is never rewound after a later uncertain send", async (t) => {
  const calls = record(t, (_method, _body, n) => { if (n === 2) throw Error("synthetic uncertain send"); return accepted(); });
  let count = 0;
  await assert.rejects(send("T", 42, "Before\n\n" + table + "\n\nAfter", true, () => count++));
  assert.equal(count, 1);
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "sendRichMessage"]);
});

for (const status of [400, 429]) test(`retirement after HTTP ${status} blocks fallback/retry`, async (t) => {
  let allowed = true;
  const calls = record(t, () => { allowed = false; return Response.json({ parameters: { retry_after: 0 } }, { status }); });
  await assert.rejects(send("T", 42, table, true, undefined, () => allowed), /connection changed/);
  assert.equal(calls.length, 1);
});

test("silent notes and explicit person replies retain their existing methods and context", async (t) => {
  const calls = record(t);
  await post("T", 42, "Checking the sample.", undefined, true);
  await replyText("T", 42, "Plain | words", 7, () => true);
  assert.deepEqual(calls, [
    { method: "sendMessage", body: { chat_id: 42, text: "Checking the sample.", disable_notification: true } },
    { method: "sendMessage", body: { chat_id: 42, text: "Plain | words", reply_parameters: { message_id: 7, allow_sending_without_reply: true } } },
  ]);
});

function reply(rich_message: unknown, over: Record<string, unknown> = {}) {
  return parseUpdates({ result: [{ update_id: 1, message: { message_id: 9, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Sam" }, text: "About this table", reply_to_message: { message_id: 8, chat: { id: 42 }, from: { first_name: "Sample bot" }, rich_message, ...over } } }] })[0]!.replyTo;
}

test("replying to a rich table keeps visible headings/cells and the same target, with bounded work", () => {
  const result = reply({ blocks: [{ type: "table", cells: [[{ text: "Item" }, { text: "Price" }], [{ text: [{ type: "bold", text: "Sample" }, " A"] }, { text: "12" }]] }] });
  assert.deepEqual(result, { id: "tg:42:8", author: "Sample bot", excerpt: "Item | Price; Sample A | 12" });
  const huge = reply({ blocks: [{ type: "table", cells: Array(10000).fill(Array(100).fill({ text: "😀".repeat(5000) })) }] });
  assert.ok(huge!.excerpt.length <= 200);
  let nested: unknown = "too deep";
  for (let i = 0; i < 30; i++) nested = { text: nested };
  assert.equal(reply({ blocks: [{ type: "table", cells: [[{ text: nested }]] }] })!.excerpt, "[Message content unavailable]");
});

test("rich reply context never reads unknown/media properties or another chat", () => {
  const data = { blocks: [{ type: "photo", url: "https://example.com/private", caption: "Not followed" }, { type: "unknown", secret: "Not read" }] };
  assert.equal(reply(data)!.excerpt, "[Message content unavailable]");
  assert.equal(reply(data, { text: "Plain original" })!.excerpt, "Plain original");
  assert.equal(reply(data, { chat: { id: 99 } }), undefined);
});

test("escaped pipes in emphasis/code and backslash parity do not shift cells", () => {
  const html = rich('| A | B |\n| --- | --- |\n| `a\\|b` | *c\\|d* |')[0]!;
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /<i>c\|d<\/i>/);
  for (const count of [2, 3]) {
    const input = '| A | B |\n| --- | --- |\n| x' + '\\'.repeat(count) + (count === 3 ? '|z' : '') + ' | y |';
    const row = rich(input)[0]!;
    assert.equal((row.match(/<td /g) ?? []).length, 2);
    assert.ok(row.includes('>x\\' + (count === 3 ? '|z' : '') + '</td>'));
  }
});

for (const tail of ['## Next heading', '- Next item', '> Next quotation', '---']) test(`a following block ends the table without a blank line (${tail})`, () => {
  const ds = deliveries(table + '\n' + tail, true);
  assert.equal(ds[0]!.richHtml, rich(table)[0]);
  assert.deepEqual(ds[1]!.chunks, messages(tail, true));
});

for (const input of ['```md\n' + table, '~~~\n' + table + '\n```\n' + table, '```\n' + table + '\n~~~\n' + table]) test('unclosed or mixed fences remain exactly on the existing route', () => {
  assert.deepEqual(deliveries(input, true), [{ chunks: messages(input, true) }]);
});

test('an all-blank header-only table is sent even though its displayed cells are empty', async (t) => {
  const input = '| | |\n| - | - |';
  const html = rich(input)[0]!;
  assert.equal((html.match(/<th /g) ?? []).length, 2);
  const calls = record(t);
  let count = 0;
  await send('T', 42, input, true, () => count++);
  assert.equal(calls[0]!.method, 'sendRichMessage');
  assert.equal(count, 1);
});

test('twenty columns with many rows, entities, emoji and a long URL stay in generated limits', () => {
  const headings = Array.from({ length: 20 }, (_, i) => `Header${i}`).join(' | ');
  const url = 'https://example.com/' + 'p'.repeat(2000);
  const rows = Array.from({ length: 450 }, (_, i) => Array.from({ length: 20 }, (_, c) => c === 0 ? `Row${i}` : c === 1 ? '<&😀>' : i === 449 && c === 19 ? `[Last](${url})` : '').join(' | '));
  const input = headings + '\n' + Array(20).fill('---').join(' | ') + '\n' + rows.join('\n');
  const ds = deliveries(input, true);
  assert.ok(ds.length > 1 && ds.every((d) => d.richHtml));
  assert.deepEqual(ds.flatMap((d) => [...d.richHtml!.matchAll(/>Row(\d+)</g)].map((m) => Number(m[1]))), Array.from({ length: 450 }, (_, i) => i));
  for (const d of ds) {
    assert.ok(Buffer.byteLength(d.richHtml!, 'utf8') <= 30_000);
    assert.ok((d.richHtml!.match(/<tr>/g) ?? []).length <= 400);
    assert.equal((d.richHtml!.match(/<th /g) ?? []).length, 20);
    assert.match(d.richHtml!, /&lt;&amp;😀&gt;/);
  }
  assert.ok(ds.at(-1)!.richHtml!.includes(`href="${url}"`));
});

for (const late of ['| final | value | extra cell |', '| final | ' + 'x'.repeat(35000) + ' |']) test('a malformed/oversized late row selects the whole fallback before transport', async (t) => {
  const input = '| A | B |\n| --- | --- |\n' + Array.from({ length: 600 }, (_, i) => `| Row${i} | value |`).join('\n') + '\n' + late;
  const ds = deliveries(input, true);
  assert.equal(ds.some((d) => d.richHtml), false);
  assert.deepEqual(ds.flatMap((d) => d.chunks), messages(input, true));
  const calls = record(t);
  await send('T', 42, input, true);
  assert.ok(calls.every((c) => c.method === 'sendMessage'));
  assert.deepEqual(calls.map((c) => c.body.text), messages(input, true).map((c) => c.html));
});

const largeTable = () => '| Name | Link |\n| --- | --- |\n' + Array.from({ length: 450 }, (_, i) => `| Row${i} | [Label${i}](https://example.com/${'x'.repeat(120)}/${i}) |`).join('\n');
for (const failed of [false, true]) test(`only rejected rich chunk B owns its multi-message fallback (second fallback fails: ${failed})`, async (t) => {
  const input = largeTable();
  const plan = deliveries(input, true);
  assert.ok(plan.length >= 3 && plan.every((d) => d.richHtml));
  assert.ok(plan[1]!.chunks.length > 2);
  let richCalls = 0;
  let fallbackParts = 0;
  const calls = record(t, (method, body) => {
    if (method === 'sendRichMessage') return ++richCalls === 2 ? new Response('{}', { status: 400 }) : accepted();
    if (body.parse_mode) return new Response('{}', { status: 400 });
    return ++fallbackParts === 2 && failed ? new Response('{}', { status: 403 }) : accepted();
  });
  let count = 0;
  const sent = send('T', 42, input, true, () => count++);
  if (failed) await assert.rejects(sent, /HTTP 403/); else await sent;
  const richBodies = calls.filter((c) => c.method === 'sendRichMessage');
  assert.equal(richBodies.length, failed ? 2 : plan.length);
  assert.equal(richBodies[0]!.body.rich_message.html, plan[0]!.richHtml);
  assert.equal(richBodies[1]!.body.rich_message.html, plan[1]!.richHtml);
  const plain = calls.filter((c) => c.method === 'sendMessage' && !c.body.parse_mode);
  assert.deepEqual(plain.map((c) => c.body.text), plan[1]!.chunks.slice(0, failed ? 2 : undefined).map((c) => c.plain));
  assert.equal(count, failed ? 2 : plan.length - 1 + plan[1]!.chunks.length);
  assert.ok(plain[0]!.body.text.includes('https://example.com/'), 'fallback lost expanded link destinations');
  if (!failed) {
    const complete = plan.map((d, i) => i === 1 ? plain.map((c) => c.body.text).join('\n') : d.richHtml!).join('\n');
    assert.deepEqual([...complete.matchAll(/Row(\d+)/g)].map((m) => Number(m[1])), Array.from({ length: 450 }, (_, i) => i));
    assert.ok(plain[0]!.body.text.startsWith('| Name | Link |'), 'the fallback lost its repeated header');
  }
});

const malformed = [
  ['ok false', { ok: false, result: { message_id: 81 } }],
  ['missing ID', { ok: true, result: {} }],
  ['fractional ID', { ok: true, result: { message_id: 1.5 } }],
  ['string ID', { ok: true, result: { message_id: '81' } }],
  ['unsafe ID', { ok: true, result: { message_id: Number.MAX_SAFE_INTEGER + 1 } }],
  ['zero ID', { ok: true, result: { message_id: 0 } }],
  ['invalid JSON', undefined],
] as const;
for (const route of ['rich', 'html fallback', 'plain fallback']) for (const [name, value] of malformed) test(`${route} malformed confirmation (${name}) never accounts, falls back or sends later chunks`, async (t) => {
  const calls = record(t, (method, body) => {
    if (route !== 'rich' && method === 'sendRichMessage') return new Response('{}', { status: 400 });
    if (route === 'plain fallback' && body.parse_mode) return new Response('{}', { status: 400 });
    return value === undefined ? new Response('invalid') : Response.json(value);
  });
  let count = 0;
  await assert.rejects(send('T', 42, table + '\n\nLater', true, () => count++));
  assert.equal(count, 0);
  assert.equal(calls.length, route === 'rich' ? 1 : route === 'html fallback' ? 2 : 3);
});

test('connection retirement is checked before each ordinary fallback submessage', async (t) => {
  let allowed = true;
  const calls = record(t, (method) => method === 'sendRichMessage' ? new Response('{}', { status: 400 }) : accepted());
  let count = 0;
  await assert.rejects(send('T', 42, largeTable(), true, () => { count++; allowed = false; }, () => allowed), /connection changed/);
  assert.equal(count, 1);
  assert.equal(calls.length, 2);
});

test('retirement during the 429 wait prevents the retry', async (t) => {
  let allowed = true;
  const calls = record(t, () => {
    setTimeout(() => { allowed = false; }, 0);
    return Response.json({ parameters: { retry_after: 0 } }, { status: 429 });
  });
  await assert.rejects(send('T', 42, table, true, undefined, () => allowed), /connection changed/);
  assert.equal(calls.length, 1);
});

for (const fallback of [false, true]) test(`a thrown acceptance callback cannot trigger a resend (fallback: ${fallback})`, async (t) => {
  const calls = record(t, (method) => fallback && method === 'sendRichMessage' ? new Response('{}', { status: 400 }) : accepted());
  await assert.rejects(send('T', 42, table + '\n\nLater', true, () => { throw new TelegramError(400); }), /HTTP 400/);
  assert.equal(calls.length, fallback ? 2 : 1);
});

test('reply extraction bounds empty nodes and input text, ignores unknown shapes and nested replies', () => {
  const array = Array(10000).fill(''); array.push('OUTSIDE_NODE_BUDGET');
  const data = { blocks: [{ type: 'table', cells: [[{ text: array }, { text: { type: 'unknown', text: 'UNKNOWN_FIELD' }, reply_to_message: { text: 'NESTED_REPLY' } }]] }] };
  const before = Date.now();
  const empty = reply(data)!;
  assert.doesNotMatch(empty.excerpt, /OUTSIDE_NODE_BUDGET|UNKNOWN_FIELD|NESTED_REPLY/);
  assert.equal(reply({ blocks: [{ type: 'table', cells: [[{ text: ' '.repeat(100000) + 'OUTSIDE_TEXT_BUDGET' }]] }] })!.excerpt, '[Message content unavailable]');
  assert.ok(Date.now() - before < 2000);
  assert.equal(reply(data, { caption: 'Caption takes precedence' })!.excerpt, 'Caption takes precedence');
  const selected = parseUpdates({ result: [{ update_id: 1, message: { message_id: 9, chat: { id: 42 }, text: 'Current', from: { id: 42, first_name: 'Sam' }, quote: { text: 'Selected text wins' }, reply_to_message: { message_id: 8, text: 'Plain wins before rich', rich_message: data } } }] })[0]!;
  assert.equal(selected.replyTo!.excerpt, 'Selected text wins');
});
