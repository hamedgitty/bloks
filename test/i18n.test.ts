// The interface in other languages (src/lib/i18n.ts, src/locales).
//
// Two halves. The machinery: a sentence filled, a count read in each
// language's own plural rules, a missing word said in English. And the
// catalogues held to their rules: nothing the code asks for is missing,
// nothing in them is dead, no translation invents a placeholder, no dash
// the house style forbids, and no English sentence slipping back into a
// screen as text written inline. That last one is a scanner over every
// component, with an allowlist (test/i18n-allowlist.json) for the few
// words that are never translated.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { createElement } from "react";

import {
  addCatalogue,
  formatList,
  formatNumber,
  getLanguage,
  hasMessage,
  LANGUAGES,
  matchLanguage,
  setLanguage,
  t,
  tr,
  type Language,
  type MessageKey,
} from "../src/lib/i18n.ts";
import { menuLanguage, menuWords } from "../electron/menu-words.mjs";
import { appMenuTemplate, type MenuTemplateItem } from "../electron/app-menu.mjs";
import { inlineEnglish, readAllowlist } from "./helpers/i18n-scan.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCALES = path.join(ROOT, "src", "locales");
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLURAL = /_(zero|one|two|few|many|other)$/;

const placeholders = (text: string) => new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
const stem = (key: string) => key.replace(PLURAL, "");

// keys made up for the machinery's tests, so they never depend on what
// the interface happens to say today
const k = (key: string) => key as MessageKey;

async function inLanguage<T>(language: Language, run: () => T): Promise<T> {
  const was = getLanguage();
  await setLanguage(language);
  try {
    return run();
  } finally {
    await setLanguage(was);
  }
}

describe("the words", () => {
  test("a sentence is filled from its params, and a number written the reader's way", async () => {
    addCatalogue("en", { "test.hello": "Hello {name}, you have {count} new" });
    assert.equal(t(k("test.hello"), { name: "Ana", count: 3 }), "Hello Ana, you have 3 new");
    addCatalogue("de", { "test.hello": "Hallo {name}, {count} neue" });
    assert.equal(await inLanguage("de", () => t(k("test.hello"), { name: "Ana", count: 12345 })), "Hallo Ana, 12.345 neue");
    // a string is kept as it is: a port or a year must not grow a separator
    assert.equal(await inLanguage("de", () => t(k("test.hello"), { name: "Ana", count: "8080" })), "Hallo Ana, 8080 neue");
  });

  test("a placeholder with nothing to fill it stays visible rather than vanishing", () => {
    assert.equal(t(k("test.hello"), { name: "Ana" }), "Hello Ana, you have {count} new");
  });

  test("a word a language lacks is said in English, and never as its key", async () => {
    addCatalogue("en", { "test.onlyEnglish": "Only in English" });
    addCatalogue("fr", { "test.hello": "Bonjour {name}" });
    assert.equal(await inLanguage("fr", () => t(k("test.onlyEnglish"))), "Only in English");
    assert.equal(await inLanguage("fr", () => t(k("test.hello"), { name: "Léa" })), "Bonjour Léa");
    // only a key nobody has comes back as itself, which the typecheck refuses
    assert.equal(t(k("test.nowhere")), "test.nowhere");
    assert.equal(hasMessage("test.onlyEnglish"), true);
    assert.equal(hasMessage("test.nowhere"), false);
  });

  test("a sentence with something drawn in it keeps the element where the translation puts it", async () => {
    addCatalogue("en", { "test.rich": "Press {key} to send" });
    addCatalogue("ja", { "test.rich": "{key} を押して送信" });
    const kbd = createElement("kbd", null, "↩");
    const english = tr(k("test.rich"), { key: "↩" }) as { props: { children: unknown[] } };
    assert.deepEqual(english.props.children, ["Press ", "↩", " to send"]);
    const japanese = (await inLanguage("ja", () => tr(k("test.rich"), { key: kbd }))) as { props: { children: Array<{ type?: string }> } };
    assert.equal(japanese.props.children.length, 2);
    assert.equal(japanese.props.children[0].type, "kbd", "the key cap moves to where Japanese puts it");
    assert.equal(japanese.props.children[1], " を押して送信");
  });
});

describe("plurals", () => {
  const forms = {
    en: { one: "{count} agent", other: "{count} agents" },
    es: { one: "{count} agente", many: "{count} de agentes", other: "{count} agentes" },
    fr: { one: "{count} agent", many: "{count} d’agents", other: "{count} agents" },
    de: { one: "{count} Agent", other: "{count} Agenten" },
    "pt-BR": { one: "{count} agente", many: "{count} de agentes", other: "{count} agentes" },
    ja: { other: "{count} 件のエージェント" },
    "zh-CN": { other: "{count} 个智能体" },
  } satisfies Record<Language, Record<string, string>>;

  for (const [language, words] of Object.entries(forms) as Array<[Language, Record<string, string>]>) {
    addCatalogue(language, Object.fromEntries(Object.entries(words).map(([form, text]) => [`test.agents_${form}`, text])));
  }

  const say = (language: Language, count: number) => inLanguage(language, () => t(k("test.agents"), { count }));
  const million = (language: Language) => inLanguage(language, () => formatNumber(1_000_000));

  test("English: one and other", async () => {
    assert.equal(await say("en", 1), "1 agent");
    assert.equal(await say("en", 0), "0 agents");
    assert.equal(await say("en", 2), "2 agents");
  });

  test("French and Brazilian Portuguese read zero as one, and a million as many", async () => {
    assert.equal(await say("fr", 0), "0 agent");
    assert.equal(await say("fr", 1), "1 agent");
    assert.equal(await say("fr", 2), "2 agents");
    assert.equal(await say("fr", 1_000_000), `${await million("fr")} d’agents`);
    assert.equal(await say("pt-BR", 0), "0 agente");
    assert.equal(await say("pt-BR", 1_000_000), `${await million("pt-BR")} de agentes`);
  });

  test("Spanish and German: one is one, and Spanish has its many", async () => {
    assert.equal(await say("es", 1), "1 agente");
    assert.equal(await say("es", 0), "0 agentes");
    assert.equal(await say("es", 1_000_000), `${await million("es")} de agentes`);
    assert.equal(await say("de", 1), "1 Agent");
    assert.equal(await say("de", 5), "5 Agenten");
  });

  test("Japanese and Chinese have one form for every count", async () => {
    assert.equal(await say("ja", 1), "1 件のエージェント");
    assert.equal(await say("zh-CN", 3), "3 个智能体");
  });

  test("a language that wrote only some forms falls back to its own other, then to English", async () => {
    addCatalogue("de", { "test.partial_other": "{count} Stück" });
    addCatalogue("en", { "test.partial_one": "{count} piece", "test.partial_other": "{count} pieces" });
    assert.equal(await inLanguage("de", () => t(k("test.partial"), { count: 1 })), "1 Stück");
    assert.equal(await inLanguage("es", () => t(k("test.partial"), { count: 1 })), "1 piece");
  });
});

describe("languages", () => {
  test("each is named in its own words", () => {
    assert.deepEqual(
      LANGUAGES.map((l) => l.name),
      ["English", "Español", "Français", "Deutsch", "Português (Brasil)", "日本語", "简体中文"],
    );
  });

  test("the system's languages come to the nearest one Bloks speaks", () => {
    assert.equal(matchLanguage(["es-MX", "en-US"]), "es");
    assert.equal(matchLanguage(["pt-PT"]), "pt-BR");
    assert.equal(matchLanguage(["zh-Hant-TW"]), "zh-CN");
    assert.equal(matchLanguage(["nl-NL", "de-AT"]), "de");
    assert.equal(matchLanguage(["en-GB", "fr-FR"]), "en");
    assert.equal(matchLanguage(["ko-KR"]), "en");
    assert.equal(matchLanguage([]), "en");
  });

  test("the menu bar matches the system the same way the window does", () => {
    for (const tags of [["es-MX"], ["pt-PT"], ["zh_TW"], ["nl", "ja-JP"], ["ko"], []]) {
      assert.equal(menuLanguage(null, tags), matchLanguage(tags), tags.join(","));
    }
    assert.equal(menuLanguage("fr", ["de-DE"]), "fr", "a choice wins over the system");
  });

  test("a list is joined with the reader's own and", async () => {
    assert.equal(await inLanguage("en", () => formatList(["Ana", "Ben", "Cleo"])), "Ana, Ben, and Cleo");
    assert.equal(await inLanguage("de", () => formatList(["Ana", "Ben", "Cleo"])), "Ana, Ben und Cleo");
  });
});

describe("the menu bar", () => {
  const labels = (items: MenuTemplateItem[]): string[] =>
    items.flatMap((item) => [...(item.label ? [item.label] : []), ...labels(item.submenu ?? [])]);

  test("every item has its words in the catalogue, the roles' included", () => {
    const words = menuWords(LOCALES, "en");
    const menu = appMenuTemplate({ name: "Bloks", packaged: false, command: () => {}, quit: () => {}, words });
    const said = labels(menu);
    assert.ok(said.includes("Quit Bloks"));
    assert.ok(said.includes("Settings…"));
    assert.ok(said.every((label) => !label.startsWith("menu.")), "no label may fall through to its key");
    for (const item of menu) assert.ok(item.label, `${item.role ?? "a menu"} needs a label`);
  });

  test("a language with no word for an item says the English one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bloks-menu-"));
    fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ "menu.quit": "Quit {name}", "menu.edit": "Edit" }));
    fs.writeFileSync(path.join(dir, "de.json"), JSON.stringify({ "menu.edit": "Bearbeiten" }));
    const words = menuWords(dir, "de");
    assert.equal(words("menu.edit"), "Bearbeiten");
    assert.equal(words("menu.quit", { name: "Bloks" }), "Quit Bloks");
    // no catalogue at all, which only a broken install would see
    assert.equal(menuWords(path.join(dir, "gone"), "de")("menu.quit"), "menu.quit");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── the catalogues ─────────────────────────────────────────────────────

function readCatalogue(code: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8"));
}

const shipped = JSON.parse(fs.readFileSync(path.join(LOCALES, "en.json"), "utf8")) as Record<string, string>;

describe("the catalogues", () => {
  test("every language has a file, and every word in it is a string under an English key", () => {
    for (const { code } of LANGUAGES) {
      const words = readCatalogue(code);
      for (const [key, value] of Object.entries(words)) {
        assert.equal(typeof value, "string", `${code}: ${key}`);
        const known = key in shipped || (PLURAL.test(key) && `${stem(key)}_other` in shipped);
        assert.ok(known, `${code}.json has ${key}, which English does not`);
      }
    }
  });

  test("no em dash and no en dash, in any language", () => {
    for (const { code } of LANGUAGES) {
      for (const [key, value] of Object.entries(readCatalogue(code))) {
        assert.ok(!/[–—]/.test(value), `${code}: ${key} has a dash the house style forbids`);
      }
    }
  });

  test("a translation uses only the placeholders the English sentence has", () => {
    const englishOf = (key: string) => {
      const forms = Object.keys(shipped).filter((k) => k === key || stem(k) === stem(key));
      return new Set(forms.flatMap((k) => [...placeholders(shipped[k])]));
    };
    for (const { code } of LANGUAGES) {
      for (const [key, value] of Object.entries(readCatalogue(code))) {
        const allowed = englishOf(key);
        for (const name of placeholders(value)) assert.ok(allowed.has(name), `${code}: ${key} has {${name}}, which English does not`);
      }
    }
  });

  test("a plural has its other form, and its forms agree on their placeholders", () => {
    for (const key of Object.keys(shipped).filter((k) => PLURAL.test(k))) {
      assert.ok(`${stem(key)}_other` in shipped, `${key} has no _other`);
      const other = placeholders(shipped[`${stem(key)}_other`]);
      for (const name of placeholders(shipped[key])) assert.ok(other.has(name) || name === "count", `${key}: {${name}} is not in its _other`);
    }
  });

  test("the keys are sorted, so a translator's diff reads area by area", () => {
    const keys = Object.keys(shipped);
    assert.deepEqual(keys, [...keys].sort());
  });
});

// ── the code against the catalogue ─────────────────────────────────────

function sourceFiles(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, match));
    else if (match.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// The index of where things are in the app is the server's as well as the
// app's (server/settings-index.ts), and so are the settings an agent may
// propose (server/settings-proposals.ts), whose names and values a card
// draws by key: their keys are the app's words.
const CODE = [
  ...sourceFiles(path.join(ROOT, "src"), /\.(tsx?|mjs)$/),
  ...sourceFiles(path.join(ROOT, "electron"), /\.mjs$/),
  path.join(ROOT, "server", "settings-index.ts"),
  path.join(ROOT, "server", "settings-proposals.ts"),
];
const parsed = CODE.map((file) => {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return { file: path.relative(ROOT, file), source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind) };
});

/** Every string literal in the code, and the fixed heads of the template
 * keys handed to `t` (t(`plan.tier.${tier}`) uses every plan.tier.*). */
function literals() {
  const strings = new Set<string>();
  const heads = new Set<string>();
  const calls: Array<{ file: string; key: string; line: number }> = [];
  for (const { file, source } of parsed) {
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) strings.add(node.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "tr", "w"].includes(node.expression.text)) {
        const [first] = node.arguments;
        if (first && ts.isStringLiteralLike(first)) {
          calls.push({ file, key: first.text, line: source.getLineAndCharacterOfPosition(first.getStart()).line + 1 });
        } else if (first && ts.isTemplateExpression(first) && first.head.text) heads.add(first.head.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { strings, heads, calls };
}

describe("the code and the catalogue", () => {
  const { strings, heads, calls } = literals();

  test("every key the code asks for is in en.json", () => {
    const missing = calls.filter((c) => c.key.includes(".") && /^[a-zA-Z][\w-]*\./.test(c.key) && !(c.key in shipped) && !(`${c.key}_other` in shipped));
    assert.deepEqual(missing.map((c) => `${c.file}:${c.line} ${c.key}`), []);
  });

  test("every key in en.json is used somewhere, so nothing dead is sent to translate", () => {
    const dead = Object.keys(shipped).filter((key) => {
      const s = stem(key);
      if (strings.has(key) || strings.has(s)) return false;
      for (const head of heads) if (key.startsWith(head)) return false;
      return true;
    });
    assert.deepEqual(dead, []);
  });
});

// ── the guard ──────────────────────────────────────────────────────────

const allow = readAllowlist(ROOT);

test("no component draws English written inline: its words come from the catalogue", () => {
  const found = parsed
    .filter((p) => p.file.endsWith(".tsx"))
    .flatMap(({ file, source }) => inlineEnglish(file, source, allow).map((f) => `${file}:${f.line} ${JSON.stringify(f.text)}`));
  assert.deepEqual(found, [], "move these into src/locales/en.json, or allow them in test/i18n-allowlist.json if they are never translated");
});

test("the guard sees a sentence written inline, and lets a name through", () => {
  const sample = ts.createSourceFile(
    "x.tsx",
    `const a = <div title="Close this">Hello there{ok ? "Saved" : t("x.y")}<span>Bloks</span><b>{"·"}</b></div>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.deepEqual(
    inlineEnglish("x.tsx", sample, allow).map((f) => f.text),
    ["Close this", "Hello there", "Saved"],
  );
});
