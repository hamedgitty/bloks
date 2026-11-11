// OpenUI inside one already-selected Telegram answer. Never reads other rows.
import { createParser } from "@openuidev/lang-core";
import { extractUi, MAX_FENCES, MAX_SOURCE, MAX_STRING, safeHttpUrl, withheldShapes, type UiNode, type UiValue } from "./genui.ts";
import { GENUI_ROOT, genuiShapes, isOpenUiLang } from "./genui-library.ts";
import { messages } from "./telegram-format.ts";
import type { Message } from "./store.ts";
import type { TelegramText } from "./telegram-reply.ts";

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const LIMITATION = "Some of this interface could not be displayed here.";
const INTERACTIVE = "These controls cannot be used here.";
let parser: ReturnType<typeof createParser> | undefined;

/** Protect displayed data from being interpreted as a new Markdown block. */
const literal = (s: string) => s.replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, "\\$&");
const node = (v: unknown): v is UiNode => Boolean(v && typeof v === "object" && !Array.isArray(v) && typeof (v as UiNode).type === "string" && (v as UiNode).props && typeof (v as UiNode).props === "object");
const array = (v: unknown): UiValue[] => Array.isArray(v) ? v : [];

/** The formatter already knows how to preserve a Markdown link's target in
 * its plain fallback. Use a single uncut field here, then escape it as data. */
function shownMarkdown(s: string): string {
  // The ordinary formatter collapses consecutive blank prose lines. A
  // component value can contain them as data, so read its lines separately.
  return s.split("\n").map((line) => messages(line, true, Number.MAX_SAFE_INTEGER).map((part) => part.plain).join("\n")).join("\n");
}

function project(root: UiNode, truncated: boolean, disabled: Set<string>, redact: (text: string) => string): string {
  const lines: string[] = [];
  let limited = truncated;
  let controls = false;
  const safe = (s: string) => literal(redact(s));
  const codeBlock = (s: string) => {
    const longest = Math.max(2, ...s.split("\n").map((line) => /^\s*(`+)\s*$/.exec(line)?.[1]?.length ?? 0));
    const marker = "`".repeat(longest + 1);
    return `${marker}\n${s}\n${marker}`;
  };
  const emit = (s: string, label?: string) => {
    const value = redact(s);
    const heading = label === undefined ? undefined : redact(label);
    if (value.includes("\r") || heading?.includes("\r")) limited = true;
    const apart = heading !== undefined && (heading.includes("\n") || value.includes("\n") || heading.length + 2 + value.length > 4_000);
    if (apart) {
      if (heading.includes("\n")) {
        if (heading.trim()) lines.push(codeBlock(heading)); else limited = true;
      } else lines.push(`${literal(heading)}${heading.length < 4_000 ? ":" : ""}`);
    }
    if (value.includes("\n")) {
      if (value.trim()) lines.push(codeBlock(value));
      else limited = true;
    } else if (apart) {
      // A value fits on its own, but the label could make the formatter
      // cut at and discard one of the value's literal spaces.
      lines.push(literal(value));
    } else {
      lines.push(heading === undefined ? literal(value) : `${literal(heading)}: ${literal(value)}`);
    }
  };
  const string = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    // toTree clips at this exact length. A fence-wide flag cannot tell which
    // field was cut, so do not show or link a potentially incomplete value.
    if (truncated && v.length >= MAX_STRING) { limited = true; return undefined; }
    return v;
  };
  const say = (v: unknown, markdown = false) => {
    const s = string(v);
    if (s !== undefined && s !== "") emit(markdown ? shownMarkdown(s) : s);
  };
  const labelValue = (label: string, value: unknown, markdown = false) => {
    const s = string(value);
    if (s !== undefined) emit(markdown ? shownMarkdown(s) : s, label);
    else limited = true;
  };
  const visibleValue = (v: unknown): string | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return string(v);
  };
  const walk = (value: unknown): void => {
    if (!node(value)) { if (value !== undefined) limited = true; return; }
    if (disabled.has(value.type)) { limited = true; return; }
    const p = value.props;
    const children = (items: unknown) => { for (const child of array(items)) walk(child); };
    const fields = (...names: string[]) => { for (const name of names) say(p[name]); };
    switch (value.type) {
      case "Card": children(p.children); break;
      case "CardHeader": fields("title", "subtitle"); break;
      case "TextContent": say(p.text, true); break;
      case "Callout": fields("title"); say(p.description, true); break;
      case "Separator": break;
      case "Image": {
        say(p.alt);
        // An image source is not necessarily a displayed link, and the
        // picture itself cannot be reconstructed from its alt text here.
        if (p.src) limited = true;
        break;
      }
      case "CodeBlock": {
        const language = string(p.language);
        const code = string(p.codeString);
        if (language) say(language);
        if (code === undefined) { limited = true; break; }
        // Preserve code as code through the existing formatter, even when
        // it contains its own fence. A longer marker cannot close within it.
        const shownCode = redact(code);
        lines.push(codeBlock(shownCode));
        if (code.includes("\r")) limited = true;
        break;
      }
      case "Quote": fields("text", "from", "where"); break;
      case "Tag": fields("text"); break;
      case "TagBlock": for (const tag of array(p.tags)) say(tag); break;
      case "MetricIndicator": fields("label", "value", "change", "trend"); break;
      case "Table": {
        const cols = array(p.columns);
        if (!cols.length || cols.some((c) => !node(c) || c.type !== "Col")) { limited = true; break; }
        const columns = cols as UiNode[];
        const data = columns.map((c) => array(c.props.data));
        const headings = columns.map((c, i) => string(c.props.label) ?? `Column ${i + 1}`);
        const count = Math.max(0, ...data.map((c) => c.length));
        if (!count) headings.forEach((heading, i) => labelValue(`Column ${i + 1}`, heading));
        for (let r = 0; r < count; r++) {
          lines.push(`Row ${r + 1}`);
          for (let c = 0; c < columns.length; c++) {
            const label = headings[c] || `Column ${c + 1} (blank heading)`;
            const entry = data[c][r];
            const text = visibleValue(entry);
            if (text === undefined) { limited = true; continue; }
            emit(typeof entry === "string" ? shownMarkdown(text) : text, label);
          }
        }
        break;
      }
      case "BarChart":
      case "LineChart":
      case "PieChart": {
        fields("xLabel", "yLabel");
        const labels = array(p.labels);
        const series = value.type === "PieChart" ? [{ type: "Series", props: { category: "", values: p.values } } as UiNode] : array(p.series);
        if (!labels.length || !series.length) limited = true;
        for (const item of series) {
          if (!node(item) || item.type !== "Series") { limited = true; continue; }
          say(item.props.category);
          const values = array(item.props.values);
          if (values.length !== labels.length) {
            limited = true;
            labels.forEach((name, i) => labelValue(`Label ${i + 1}`, name));
            values.forEach((amount, i) => labelValue(`Value ${i + 1}`, visibleValue(amount)));
            continue;
          }
          const count = Math.max(labels.length, values.length);
          for (let i = 0; i < count; i++) {
            const name = string(labels[i]);
            const amount = visibleValue(values[i]);
            if (name !== undefined && amount !== undefined) emit(amount, name);
            else {
              limited = true;
              if (name !== undefined) labelValue(`Label ${i + 1}`, name);
              if (amount !== undefined) labelValue(`Value ${i + 1}`, amount);
            }
          }
        }
        break;
      }
      case "Steps": children(p.items); break;
      case "StepsItem": fields("title", "details", "state"); break;
      case "ListBlock": children(p.items); break;
      case "ListItem": {
        fields("title", "subtitle");
        if (p.image && typeof p.image === "object" && !Array.isArray(p.image)) say((p.image as Record<string, UiValue>).alt);
        if (p.actionLabel !== undefined) { controls = true; say(p.actionLabel); }
        break;
      }
      case "OptionCards": fields("title"); children(p.items); fields("note"); controls = true; break;
      case "OptionCard": fields("title", "subtitle"); if (p.recommended === true) lines.push("Recommended"); controls = true; break;
      case "Sources":
        for (const item of array(p.items)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) { limited = true; continue; }
          const source = item as Record<string, UiValue>;
          say(source.title); say(source.sourceName);
          const url = string(source.url);
          if (url && safeHttpUrl(url) && redact(url) === url) lines.push(safe(url)); else if (source.url) limited = true;
        }
        break;
      case "Tabs": case "Accordion": children(p.items); break;
      case "TabItem": case "AccordionItem": fields("trigger"); children(p.content); break;
      case "Buttons": children(p.buttons); controls = true; break;
      case "Button": fields("label"); controls = true; break;
      case "FollowUpBlock": children(p.items); controls = true; break;
      case "FollowUpItem": fields("text"); controls = true; break;
      case "Form": children(p.fields); walk(p.buttons); controls = true; break;
      case "FormControl": fields("label"); walk(p.input); fields("hint"); controls = true; break;
      case "Input": case "TextArea": fields("placeholder"); controls = true; break;
      case "Select": fields("placeholder"); children(p.items); controls = true; break;
      case "SelectItem": fields("label"); controls = true; break;
      case "RadioGroup": case "CheckBoxGroup": children(p.items); controls = true; break;
      case "RadioItem": case "CheckBoxItem": fields("label", "description"); controls = true; break;
      case "Slider": {
        fields("label");
        for (const name of ["min", "max", "step"]) if (typeof p[name] === "number" && Number.isFinite(p[name])) lines.push(`${safe(name)}: ${p[name]}`);
        controls = true; break;
      }
      case "DatePicker": controls = true; break;
      default: limited = true;
    }
  };
  walk(root);
  if (controls) lines.push(INTERACTIVE);
  if (limited) lines.push(LIMITATION);
  return lines.join("\n");
}

/** Null means preserve the baseline reply exactly. */
export function telegramOpenUi(message: Message, without: string[] | undefined, redact: (text: string) => string = (text) => text): TelegramText | null {
  if (!message.text) return null;
  const lines = message.text.split("\n");
  const out: string[] = [];
  const disabled = new Set(withheldShapes(without));
  let fenceIndex = 0;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(FENCE);
    if (!open) { out.push(lines[i]!); continue; }
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== open[1]) end++;
    if (!isOpenUiLang(open[2]!)) {
      out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
      i = end;
      continue;
    }
    found = true;
    const code = lines.slice(i + 1, end).join("\n");
    const index = fenceIndex++;
    const kept = message.ui?.find((entry) => entry.fence === index);
    if (without?.includes("openui") || end >= lines.length || !code.trim() || code.length > MAX_SOURCE) {
      out.push(LIMITATION);
    } else {
      try {
        parser ??= createParser(genuiShapes.toJSONSchema(), GENUI_ROOT);
        const parsed = parser.parse(code);
        // Parse each fence separately: stored UI keeps only the first six.
        const fresh = extractUi(`\`\`\`openui\n${code}\n\`\`\``)?.[0];
        const entry = index < MAX_FENCES ? kept : fresh;
        if (!entry || !fresh || (kept && JSON.stringify({ ...kept, fence: 0 }) !== JSON.stringify(fresh))) {
          out.push(LIMITATION);
        } else {
          const rendered = project(entry.tree, Boolean(entry.truncated), disabled, redact);
          out.push(rendered || LIMITATION);
          if (parsed.meta.errors.length && !rendered.includes(LIMITATION)) out.push(LIMITATION);
        }
      } catch {
        out.push(LIMITATION);
      }
    }
    i = end;
  }
  if (!found) return null;
  return { text: out.join("\n").trim() || LIMITATION, markdown: true };
}
