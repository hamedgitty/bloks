import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUi, MAX_SOURCE, MAX_STRING } from "../server/genui.ts";
import { deliveries, messages } from "../server/telegram-format.ts";
import { telegramOpenUi } from "../server/telegram-openui.ts";
import { send } from "../server/telegram.ts";
import type { Message } from "../server/store.ts";

const fence = (s: string) => `\`\`\`openui\n${s}\n\`\`\``;
const message = (text: string): Message => ({ id: "answer", at: 1, role: "bot", kind: "text", text, ui: extractUi(text) });
const plain = (text: string) => deliveries(text, true).flatMap((d) => d.chunks.map((c) => c.plain)).join("\n");
const rich = (text: string) => deliveries(text, true).flatMap((d) => d.richHtml === undefined ? [] : [d.richHtml]);
const table = () => {
  const labels = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);
  const values = Array.from({ length: 30 }, (_, i) => `${i + 1} kg`);
  labels[4] = "A | B\nsecond line";
  labels[9] = "[Source](https://example.com/a-(b))";
  return `root = Card([t, n])\nt = Table([Col("Name", ${JSON.stringify(labels)}), Col("Weight", ${JSON.stringify(values)})])\nn = TextContent("Caution: keep all rows.")`;
};

test("selected answer retains every table row, prose, literal data and link in real plain fallback", () => {
  const input = `Before.\n\n${fence(table())}\n\nAfter.`;
  const result = telegramOpenUi(message(input), []);
  assert.ok(result);
  const text = plain(result.text);
  assert.ok(text.indexOf("Before.") < text.indexOf("Row 1"));
  assert.ok(text.indexOf("Caution: keep all rows.") < text.indexOf("After."));
  for (let i = 1; i <= 30; i++) {
    assert.ok(text.includes(`Row ${i}`), `missing row ${i}`);
    assert.ok(text.includes(`${i} kg`), `missing value ${i}`);
  }
  assert.match(text, /A \| B\nsecond line/);
  assert.ok(text.includes("Source (https://example.com/a-(b))"));
  assert.doesNotMatch(text, /root = Card/);
});

test("literal blank lines and a long spaced cell survive actual delivery parts", () => {
  const long = `${"a".repeat(3920)} ${"b".repeat(70)}`;
  const label = "A very long heading ".repeat(4);
  const code = `root = Card([Table([Col(${JSON.stringify(label)}, ${JSON.stringify(["first | part\n\n\nlast", long])})])])`;
  const result = telegramOpenUi(message(fence(code)), []);
  assert.ok(result);
  const parts = deliveries(result.text, true).flatMap((d) => d.chunks.map((c) => c.plain));
  assert.ok(parts.join("").includes("first | part\n\n\nlast"));
  assert.ok(parts.join("").includes(long), "no literal space may be lost at a message boundary");
});

test("capped cells and unresolved values retain independent content with a limitation", () => {
  const values = Array.from({ length: 201 }, (_, i) => `value ${i + 1}`);
  const code = [
    'root = Card([h, t, u])',
    'h = TextContent("Independent")',
    `t = Table([Col("Values", ${JSON.stringify(values)})])`,
    'u = TextContent(missingReference)',
  ].join("\n");
  const result = telegramOpenUi(message(fence(code)), []);
  assert.ok(result);
  const text = plain(result.text);
  assert.ok(text.includes("Independent"));
  assert.ok(text.includes("value 200"));
  assert.ok(!text.includes("value 201"));
  assert.ok(text.includes("could not be displayed"));
  assert.ok(!text.includes("missingReference"));
});

test("an unresolved reference leaves its valid sibling and a local limitation", () => {
  const code = 'root = Card([TextContent("Independent"), TextContent(missingReference)])';
  const result = telegramOpenUi(message(fence(code)), []);
  assert.ok(result);
  const text = plain(result.text);
  assert.ok(text.includes("Independent"));
  assert.ok(text.includes("could not be displayed"));
  assert.ok(!text.includes("missingReference"));
});

test("possibly clipped cell and heading are omitted while an independent column survives", () => {
  const clipped = "z".repeat(MAX_STRING + 1);
  const code = `root = Card([Table([Col(${JSON.stringify(clipped)}, [${JSON.stringify(clipped)}]), Col("Safe heading", ["Safe value"])])])`;
  const result = telegramOpenUi(message(fence(code)), []);
  assert.ok(result);
  const text = plain(result.text);
  assert.ok(text.includes("Safe heading: Safe value"));
  assert.ok(text.includes("could not be displayed"));
  assert.ok(!text.includes("z".repeat(100)));
});

test("more than six independent fences are kept, with malformed siblings limited", () => {
  const fences = Array.from({ length: 8 }, (_, i) => fence(`root = Card([TextContent("Part ${i + 1}")])`));
  fences.splice(3, 0, fence('root = Card([TextContent("Safe"), Dashboard("secret")])'));
  const text = plain(telegramOpenUi(message(fences.join("\n\n")), [])!.text);
  for (let i = 1; i <= 8; i++) assert.ok(text.includes(`Part ${i}`));
  assert.ok(text.includes("Safe"));
  assert.ok(text.includes("could not be displayed"));
  assert.ok(!text.includes("secret"));
});

test("ordinary code fences are preserved and an unclosed OpenUI source is not dumped", () => {
  const source = ['```text', '```openui', 'not an interface', '```', '', fence('root = Card([TextContent("Visible")])'), '', '```openui', 'root = Card([TextContent("private source")])'].join("\n");
  const result = telegramOpenUi(message(source), []);
  assert.ok(result);
  assert.ok(result.text.includes("not an interface"));
  assert.ok(result.text.includes("Visible"));
  assert.ok(result.text.includes("could not be displayed"));
  assert.ok(!result.text.includes("private source"));
});

test("truncated data and uneven chart arrays get honest limits without action payloads", () => {
  const code = [
    'root = Card([h, chart, b])',
    `h = TextContent(${JSON.stringify("x".repeat(MAX_STRING + 10))})`,
    'chart = BarChart(["A", "B"], [Series("Weight", [11])])',
    'b = Buttons([Button("Act", @ToAssistant("HIDDEN_ACTION", {secret: "HIDDEN_STATE"}))])',
  ].join("\n");
  const text = plain(telegramOpenUi(message(fence(code)), [])!.text);
  assert.ok(text.includes("Label 1: A"));
  assert.ok(text.includes("Label 2: B"));
  assert.ok(text.includes("Value 1: 11"));
  assert.ok(!text.includes("A: 11"));
  assert.ok(text.includes("controls cannot be used"));
  assert.ok(text.includes("could not be displayed"));
  assert.ok(!text.includes("HIDDEN_ACTION"));
  assert.ok(!text.includes("HIDDEN_STATE"));
  assert.ok(!text.includes("x".repeat(100)));
});

test("clipped source links and disabled nodes do not hide independent text", () => {
  const code = [
    'root = Card([t, s, chart])',
    't = TextContent("Independent")',
    `s = Sources([{title: "Source", url: ${JSON.stringify("https://example.com/" + "a".repeat(MAX_STRING))}}])`,
    'chart = BarChart(["A"], [Series("S", [1])])',
  ].join("\n");
  const text = plain(telegramOpenUi(message(fence(code)), ["chart"])!.text);
  assert.ok(text.includes("Independent"));
  assert.ok(text.includes("Source"));
  assert.ok(!text.includes("https://example.com/"));
  assert.ok(text.includes("could not be displayed"));
});

test("newly projected values pass through redaction before formatting and unsafe links are omitted", () => {
  const secret = "sk_fixture_SECRET_12345";
  const code = [
    'root = Card([text, table, lines, src, block])',
    `text = TextContent(${JSON.stringify(`Text ${secret}`)})`,
    `table = Table([Col("Value", [${JSON.stringify(secret)}])])`,
    `lines = Table([Col("Kept", [${JSON.stringify(secret)}, "two\\nlines"])])`,
    `src = Sources([{title: "Source", url: ${JSON.stringify(`https://example.com/${secret}`)}}])`,
    `block = CodeBlock("text", ${JSON.stringify(`code ${secret}`)})`,
  ].join("\n");
  const rendered = telegramOpenUi(message(fence(code)), [], (s) => s.replaceAll(secret, "[redacted]"));
  assert.ok(rendered);
  const text = plain(rendered.text);
  assert.doesNotMatch(text, /sk_fixture_SECRET_12345/);
  assert.doesNotMatch(rich(rendered.text).join(""), /sk_fixture_SECRET_12345/);
  assert.ok(text.includes("Text [redacted]"));
  assert.deepEqual(rich(rendered.text), ['<table><tr><th align="left">Value</th></tr><tr><td align="left">[redacted]</td></tr></table>']);
  assert.ok(text.includes("| [redacted] |"));
  assert.ok(text.includes("Kept: [redacted]"));
  assert.ok(text.includes("code [redacted]"));
  assert.ok(!text.includes("https://example.com/"));
  assert.ok(text.includes("could not be displayed"));
});

test("ordinary text keeps its original path; a disabled OpenUI fence has a local limitation", () => {
  assert.equal(telegramOpenUi(message("ordinary"), []), null);
  const disabled = telegramOpenUi(message(fence(table())), ["openui"]);
  assert.ok(disabled);
  assert.ok(disabled.text.includes("could not be displayed"));
  assert.ok(!disabled.text.includes("Row 1"));
});

test("a missing stored tree inside the retained fence range is not synthesized", () => {
  const selected = message(fence('root = Card([TextContent("Do not synthesize")])'));
  selected.ui = undefined;
  const result = telegramOpenUi(selected, []);
  assert.ok(result);
  assert.ok(!result.text.includes("Do not synthesize"));
  assert.ok(result.text.includes("could not be displayed"));
});

test("visible component families retain labels and descriptions but never hidden form or action data", () => {
  const code = [
    'root = Card([h, c, q, tags, metric, steps, list, opt, tabs, form, sources, img, block])',
    'h = CardHeader("Heading", "Subtitle")',
    'c = Callout("warning", "Warning", "A caution")',
    'q = Quote("Quoted words", "Speaker", "Book")',
    'tags = TagBlock(["First tag", "Second tag"])',
    'metric = MetricIndicator("Speed", "42 km/h", "+2 km/h", "up")',
    'steps = Steps([StepsItem("Step one", "Step detail", "done")])',
    'list = ListBlock([ListItem("List title", "List detail", {src: "https://example.com/image", alt: "List image"}, "Open", @ToAssistant("HIDDEN_ACTION"))])',
    'opt = OptionCards([OptionCard("HIDDEN_ID", "Choice label", "Choice detail", true)], "Choose", "Choice note")',
    'tabs = Tabs([TabItem("HIDDEN_TAB", "Tab label", [TextContent("Tab content")])])',
    'form = Form("HIDDEN_FORM", Buttons([Button("Submit", @ToAssistant("HIDDEN_SUBMIT"))]), [FormControl("Name label", Input("HIDDEN_NAME", "Enter name", "text"), "Name hint"), FormControl("Pick label", Select("HIDDEN_SELECT", [SelectItem("HIDDEN_VALUE", "Choice A")]))])',
    'sources = Sources([{title: "Source title", url: "https://example.com/ref", sourceName: "Source name"}])',
    'img = Image("An image", "https://example.com/image")',
    `block = CodeBlock("js", ${JSON.stringify('const x = "value";\n```\nnext')})`,
  ].join("\n");
  const text = plain(telegramOpenUi(message(fence(code)), [])!.text);
  for (const expected of ["Heading", "Subtitle", "Warning", "A caution", "Quoted words", "Speaker", "Book", "First tag", "Speed", "42 km/h", "Step detail", "List image", "Choice label", "Choice detail", "Recommended", "Tab label", "Tab content", "Name label", "Enter name", "Name hint", "Pick label", "Choice A", "Source title", "https://example.com/ref", "An image", "const x = \"value\";\n```\nnext"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.ok(text.includes("controls cannot be used"));
  assert.doesNotMatch(text, /HIDDEN_/);
});

test("actual sender's definite formatting refusal keeps every row and link in plain fallback", async (t) => {
  const result = telegramOpenUi(message(fence(table())), [])!;
  const calls: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.parse_mode) return Response.json({ ok: false, error_code: 400, description: "fixture rejects formatting" }, { status: 400 });
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await send("TEST", 10101, result.text, result.markdown);
  const fallback = calls.filter((c) => !c.parse_mode).map((c) => c.text).join("\n");
  const rich = calls.filter((c) => c.parse_mode === "HTML").map((c) => c.text).join("\n");
  for (const output of [rich, fallback]) {
    let previous = -1;
    for (let i = 1; i <= 30; i++) {
      const at = output.indexOf(`${i} kg`, previous + 1);
      assert.ok(at > previous, `missing or reordered value ${i}`);
      previous = at;
      if (i !== 5 && i !== 10) assert.ok(output.includes(`Item ${i}`), `missing label ${i}`);
    }
    assert.ok(output.includes("A | B\nsecond line"));
    assert.ok(output.includes("https://example.com/a-(b)"));
  }
  assert.ok(calls.some((c) => c.parse_mode === "HTML"));
});

test("actual sender stops after an uncertain partial result without retry", async (t) => {
  const values = Array.from({ length: 30 }, (_, i) => `${i + 1} ${"v".repeat(220)}`);
  // A cell on two lines keeps the labelled lines, several ordinary messages.
  values[0] = "1 first\nsecond";
  const code = `root = Card([Table([Col("Values", ${JSON.stringify(values)})])])`;
  const result = telegramOpenUi(message(fence(code)), [])!;
  const calls: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    if (calls.length === 2) throw new TypeError("fixture connection lost");
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await assert.rejects(send("TEST", 10101, result.text, result.markdown));
  assert.equal(calls.length, 2, "an uncertain part must not be retried");
});

// ── tables through the formatter's rich table ──

const col = (label: unknown, data: unknown[]) => `Col(${JSON.stringify(label)}, ${JSON.stringify(data)})`;
const tableOf = (...cols: string[]) => `root = Card([Table([${cols.join(", ")}])])`;
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescapeHtml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
/** How the labelled lines show a cell: a string as the formatter shows
 * its Markdown, any other value as written. Headings are shown as written. */
const shownCell = (v: unknown) => typeof v === "string" ? messages(v, true, Number.MAX_SAFE_INTEGER).map((part) => part.plain).join("\n") : String(v);

test("a table whose every heading and cell survives goes as the rich table, and its refusal lines keep every value", async (t) => {
  const headings = ["x|y\\", "", "[H](https://h.example)", "<i>&</i>"];
  const columns: unknown[][] = [
    ["a|b", "a\\|b", "\\", "", "[Source](https://example.com/a-(b))", "<b>x</b> & y", "*a* _b_ `c` # ~d~ + - . ! > {}"],
    [12, true, false, 0.5, -3, "q", "a  b"],
    ["\\|", "|\\", "\\\\|", "a\\", "\\\\", "| |", "z"],
    ["", "", "", "", "", "", "end"],
  ];
  const code = `root = Card([TextContent("Above"), Table([${headings.map((h, i) => col(h, columns[i]!)).join(", ")}]), TextContent("Below")])`;
  const result = telegramOpenUi(message(`Before.\n\n${fence(code)}\n\nAfter.`), [])!;
  const rows = columns[0]!.map((_, r) => columns.map((column) => shownCell(column[r])));
  assert.equal(rows[4]![0], "Source (https://example.com/a-(b))", "a link keeps its target");
  const html = `<table><tr>${headings.map((h) => `<th align="left">${escapeHtml(h)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((c) => `<td align="left">${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  const lines = [`| ${headings.join(" | ")} |`, "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
  const planned = deliveries(result.text, true);
  assert.equal(planned.length, 3);
  assert.deepEqual(planned[0]!.chunks.map((c) => c.plain), ["Before.\n\nAbove"]);
  assert.equal(planned[1]!.richHtml, html);
  assert.equal(planned[1]!.chunks.map((c) => c.plain).join("\n"), lines);
  assert.deepEqual(planned[2]!.chunks.map((c) => c.plain), ["Below\n\nAfter."]);
  // Through the actual sender: taken as a rich message, or refused with
  // its lines sent instead, as HTML or, refused again, as plain text.
  for (const refusal of ["none", "table", "table and HTML"] as const) {
    const calls: Array<{ method: string; body: any }> = [];
    const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      if ((refusal !== "none" && method === "sendRichMessage") || (refusal === "table and HTML" && body.parse_mode)) {
        return Response.json({ ok: false, error_code: 400, description: "fixture refuses" }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: calls.length } });
    });
    await send("TEST", 10101, result.text, result.markdown);
    fetch.mock.restore();
    const shown = calls.filter((c) => c.method === "sendRichMessage" ? refusal === "none" : !(c.body.parse_mode && refusal === "table and HTML"));
    assert.deepEqual(shown.map((c) => c.method), ["sendMessage", refusal === "none" ? "sendRichMessage" : "sendMessage", "sendMessage"], refusal);
    if (refusal === "none") assert.equal(shown[1]!.body.rich_message.html, html);
    else assert.equal(refusal === "table" ? unescapeHtml(shown[1]!.body.text) : shown[1]!.body.text, lines, refusal);
  }
});

test("headings or cells the rich table would alter keep the labelled lines", () => {
  const clipped = "z".repeat(MAX_STRING + 1);
  const cases: Array<[string, string]> = [
    ["a cell on two lines", tableOf(col("Name", ["a\nb"]))],
    ["a cell with a carriage return", tableOf(col("Name", ["a\rb"]))],
    ["a heading on two lines", tableOf(col("Name\nmore", ["a"]))],
    ["a heading with a carriage return", tableOf(col("Name\rmore", ["a"]))],
    ["a cell with a leading space", tableOf(col("Name", [" a"]))],
    ["a cell with a trailing space", tableOf(col("Name", ["a "]))],
    ["a cell with a trailing tab", tableOf(col("Name", ["a\t"]))],
    ["a heading with a leading space", tableOf(col(" Name", ["a"]))],
    ["a heading with a trailing space", tableOf(col("Name ", ["a"]))],
    ["Markdown code shown with a leading space", tableOf(col("Name", ["` a`"]))],
    ["a Markdown link shown with a leading space", tableOf(col("Name", ["[ a](https://example.com/a)"]))],
    ["a possibly clipped cell", tableOf(col("Name", [clipped]))],
    ["a possibly clipped heading", tableOf(col(clipped, ["a"]))],
    ["columns of unequal length", tableOf(col("Name", ["a", "b"]), col("Weight", ["1"]))],
    ["a cell with no value", tableOf(col("Name", [null]))],
    ["21 columns", tableOf(...Array.from({ length: 21 }, (_, i) => col(`C${i + 1}`, [`v${i + 1}`])))],
    // Each euro sign is three bytes of HTML: one row over the rich bound.
    ["a row too big for one rich message", tableOf(...Array.from({ length: 3 }, (_, i) => col(`C${i + 1}`, ["€".repeat(3_990)])))],
  ];
  for (const [name, code] of cases) {
    const result = telegramOpenUi(message(fence(code)), []);
    assert.ok(result, name);
    assert.deepEqual(rich(result.text), [], name);
    assert.ok(plain(result.text).includes("Row 1"), name);
  }
  // A heading that is not text never reaches either form: the parser
  // drops its column, and a stored tree holding one is withheld.
  assert.ok(plain(telegramOpenUi(message(fence(tableOf(col(5, ["a"])))), [])!.text).includes("could not be displayed"));
  const stored = message(fence(tableOf(col("Name", ["a"]))));
  (stored.ui![0]!.tree.props.children as any)[0].props.columns[0].props.label = 5;
  const kept = telegramOpenUi(stored, [])!;
  assert.deepEqual(rich(kept.text), []);
  assert.equal(plain(kept.text), "Some of this interface could not be displayed here.");
  // The same shapes without what alters them are rich, so each case above
  // is kept labelled for its own reason.
  for (const code of [tableOf(...Array.from({ length: 3 }, (_, i) => col(`C${i + 1}`, ["€".repeat(3_000)]))), tableOf(col("Name", ["a"])), tableOf(col("Name", ["a", "b"]), col("Weight", ["1", "2"])), tableOf(...Array.from({ length: 20 }, (_, i) => col(`C${i + 1}`, [`v${i + 1}`])))]) {
    assert.equal(rich(telegramOpenUi(message(fence(code)), [])!.text).length, 1, code);
  }
});

// A fence's source is at most 24,000 characters; eight columns of short
// values are well within it and still need more than one rich message.
const longTable = (after = "") => {
  const names = Array.from({ length: 150 }, (_, i) => `Item ${i + 1}`);
  const others = Array.from({ length: 7 }, (_, c) => Array.from({ length: 150 }, (_, i) => `c${c + 2}-${i + 1}`));
  const code = `root = Card([Table([${[col("Name", names), ...others.map((data, c) => col(`C${c + 2}`, data))].join(", ")}])${after ? `, TextContent(${JSON.stringify(after)})` : ""}])`;
  assert.ok(code.length < MAX_SOURCE);
  const rows = names.map((name, i) => [name, ...others.map((data) => data[i]!)]);
  return { names, rows, result: telegramOpenUi(message(fence(code)), [])! };
};
const rowsIn = (html: string) => [...html.matchAll(/<tr>((?:<td align="left">[^<]*<\/td>)+)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<td align="left">([^<]*)<\/td>/g)].map((c) => c[1]!));
const heading = `<table><tr>${["Name", ...Array.from({ length: 7 }, (_, c) => `C${c + 2}`)].map((h) => `<th align="left">${h}</th>`).join("")}</tr><tr>`;
const headingLines = `| ${["Name", ...Array.from({ length: 7 }, (_, c) => `C${c + 2}`)].join(" | ")} |\n| ${Array(8).fill("---").join(" | ")} |`;

test("a representable table too big for one rich message is split with its heading on each and every row once, in order", () => {
  const { rows, result } = longTable();
  const parts = deliveries(result.text, true).filter((d) => d.richHtml !== undefined);
  assert.ok(parts.length >= 2, `${parts.length} rich parts`);
  for (const part of parts) {
    assert.ok(part.richHtml!.startsWith(heading));
    assert.ok(Buffer.byteLength(part.richHtml!, "utf8") <= 30_000);
    assert.ok(part.chunks.map((c) => c.plain).join("\n").startsWith(`${headingLines}\n| Item `));
  }
  assert.deepEqual(parts.flatMap((p) => rowsIn(p.richHtml!)), rows);
  // Each part's refusal lines are its own rows, once.
  const fallback = parts.map((p) => p.chunks.map((c) => c.plain).join("\n").split("\n").slice(2).map((line) => line.slice(2, -2).split(" | ")));
  assert.deepEqual(fallback, parts.map((p) => rowsIn(p.richHtml!)));
});

for (const failure of ["refused", "uncertain"] as const) test(`actual sender never replays an accepted rich part when a later one is ${failure}`, async (t) => {
  const { names, result } = longTable("After the table.");
  const parts = deliveries(result.text, true).filter((d) => d.richHtml !== undefined);
  assert.equal(parts.length, 2);
  const calls: Array<{ method: string; body: any }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "sendRichMessage" && calls.filter((c) => c.method === method).length === 2) {
      if (failure === "uncertain") throw new TypeError("fixture connection lost");
      return Response.json({ ok: false, error_code: 400, description: "fixture refuses the table" }, { status: 400 });
    }
    return Response.json({ ok: true, result: { message_id: calls.length } });
  });
  const sending = send("TEST", 10101, result.text, result.markdown);
  if (failure === "uncertain") await assert.rejects(sending); else await sending;
  assert.deepEqual(calls.slice(0, 2).map((c) => [c.method, c.body.rich_message?.html]), parts.map((p) => ["sendRichMessage", p.richHtml]));
  const after = calls.slice(2);
  if (failure === "uncertain") {
    assert.deepEqual(after, [], "nothing more after an uncertain part, and nothing again");
    return;
  }
  // The refused part's own lines, then the words after the table. The
  // part Telegram took is not sent again in any form.
  assert.ok(after.every((c) => c.method === "sendMessage"));
  const text = after.map((c) => unescapeHtml(c.body.text)).join("\n");
  const second = rowsIn(parts[1]!.richHtml!).map(([name]) => name!);
  const lines = [...text.matchAll(/^\| (Item \d+) \|/gm)].map((m) => m[1]);
  assert.deepEqual(lines, second);
  assert.ok(second.length < names.length && !lines.includes("Item 1"));
  assert.ok(text.startsWith(headingLines));
  assert.ok(text.endsWith("After the table."));
});

test("parser 1.1 state defaults show their evaluated value, never the state itself", () => {
  const code = [
    "root = Card([t, w, m])",
    "$count = 2 + 3",
    '$unused = "STATE_ONLY_VALUE"',
    "$weights = [1 + 1, 3]",
    't = TextContent("Count: " + $count)',
    'w = Table([Col("Weight", $weights)])',
    "m = MetricIndicator(",
    '  "Rounded",',
    '  "" + @Round([2.345, 1.25], 1)',
    ")",
  ].join("\n");
  const selected = message(fence(code));
  assert.equal((selected.ui?.[0] as any)?.state?.$unused, "STATE_ONLY_VALUE", "the stored tree keeps its state");
  const result = telegramOpenUi(selected, [])!;
  const text = plain(result.text);
  assert.ok(text.includes("Count: 5"));
  assert.deepEqual(rich(result.text), ['<table><tr><th align="left">Weight</th></tr><tr><td align="left">2</td></tr><tr><td align="left">3</td></tr></table>']);
  assert.ok(text.includes("Rounded"));
  assert.match(text, /2\.3,1\.[23]/);
  assert.doesNotMatch(result.text, /STATE_ONLY_VALUE|\$count|\$weights|\$unused/);
  assert.ok(!text.includes("could not be displayed"));
});
