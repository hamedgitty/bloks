import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUi, MAX_STRING } from "../server/genui.ts";
import { deliveries } from "../server/telegram-format.ts";
import { telegramOpenUi } from "../server/telegram-openui.ts";
import { send } from "../server/telegram.ts";
import type { Message } from "../server/store.ts";

const fence = (s: string) => `\`\`\`openui\n${s}\n\`\`\``;
const message = (text: string): Message => ({ id: "answer", at: 1, role: "bot", kind: "text", text, ui: extractUi(text) });
const plain = (text: string) => deliveries(text, true).flatMap((d) => d.chunks.map((c) => c.plain)).join("\n");
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
    'root = Card([text, table, src, block])',
    `text = TextContent(${JSON.stringify(`Text ${secret}`)})`,
    `table = Table([Col("Value", [${JSON.stringify(secret)}])])`,
    `src = Sources([{title: "Source", url: ${JSON.stringify(`https://example.com/${secret}`)}}])`,
    `block = CodeBlock("text", ${JSON.stringify(`code ${secret}`)})`,
  ].join("\n");
  const rendered = telegramOpenUi(message(fence(code)), [], (s) => s.replaceAll(secret, "[redacted]"));
  assert.ok(rendered);
  const text = plain(rendered.text);
  assert.doesNotMatch(text, /sk_fixture_SECRET_12345/);
  assert.ok(text.includes("Text [redacted]"));
  assert.ok(text.includes("Value: [redacted]"));
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
