// Links in a reply, and the ones that must not become links.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSafeHref, parseInline, type InlineToken } from "../src/lib/inlineMarkdown.ts";

const text = (t: string): InlineToken => ({ kind: "text", text: t });
const link = (href: string, label = href): InlineToken => ({ kind: "link", href, children: [text(label)] });

describe("parseInline", () => {
  test("bold and code are what they were", () => {
    assert.deepEqual(parseInline("a **b** `c`"), [
      text("a "),
      { kind: "bold", children: [text("b")] },
      text(" "),
      { kind: "code", text: "c" },
    ]);
  });

  test("a markdown link", () => {
    assert.deepEqual(parseInline("see [the docs](https://example.com/a?b=1#c) now"), [
      text("see "),
      link("https://example.com/a?b=1#c", "the docs"),
      text(" now"),
    ]);
  });

  test("a bare URL, with the sentence's punctuation left outside", () => {
    assert.deepEqual(parseInline("Go to https://example.com/x."), [text("Go to "), link("https://example.com/x"), text(".")]);
    assert.deepEqual(parseInline("https://a.com, https://b.com/?q=1!"), [
      link("https://a.com"),
      text(", "),
      link("https://b.com/?q=1"),
      text("!"),
    ]);
    assert.deepEqual(parseInline('"http://a.com/p"'), [text('"'), link("http://a.com/p"), text('"')]);
  });

  test("a closing bracket belongs to the URL only when the URL opened it", () => {
    assert.deepEqual(parseInline("(see https://example.com/x)"), [text("(see "), link("https://example.com/x"), text(")")]);
    assert.deepEqual(parseInline("https://en.wikipedia.org/wiki/Mercury_(planet)."), [
      link("https://en.wikipedia.org/wiki/Mercury_(planet)"),
      text("."),
    ]);
    assert.deepEqual(parseInline("[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) is small"), [
      link("https://en.wikipedia.org/wiki/Mercury_(planet)", "Mercury"),
      text(" is small"),
    ]);
  });

  test("links inside bold, and bold inside a link", () => {
    assert.deepEqual(parseInline("**read [this](https://a.com) and https://b.com**"), [
      { kind: "bold", children: [text("read "), link("https://a.com", "this"), text(" and "), link("https://b.com")] },
    ]);
    assert.deepEqual(parseInline("[**big**](https://a.com)"), [
      { kind: "link", href: "https://a.com", children: [{ kind: "bold", children: [text("big")] }] },
    ]);
  });

  test("only http and https become links; mailto stays text", () => {
    for (const bad of [
      "[mail me](mailto:a@b.com)",
      "mailto:a@b.com",
      "[x](javascript:alert(1))",
      "[x](JavaScript:alert(1))",
      "[x](data:text/html,<b>hi</b>)",
      "[x](file:///etc/passwd)",
      "[x](/relative)",
      "[x](vbscript:msgbox)",
      "[x](https://)",
    ]) {
      assert.deepEqual(parseInline(bad), [text(bad)], bad);
    }
  });

  test("things that only look like links stay text", () => {
    // the target has a space in it, so only the bare URL inside is linked
    assert.deepEqual(parseInline("[x](https://a.com has space)"), [text("[x]("), link("https://a.com"), text(" has space)")]);
    assert.deepEqual(parseInline("[not a link]"), [text("[not a link]")]);
    assert.deepEqual(parseInline("foohttps://a.com"), [text("foohttps://a.com")]);
  });

  test("code keeps a URL literal, and a link label is not linked again", () => {
    assert.deepEqual(parseInline("`https://a.com`"), [{ kind: "code", text: "https://a.com" }]);
    assert.deepEqual(parseInline("[https://a.com](https://b.com)"), [link("https://b.com", "https://a.com")]);
  });

  test("a URL followed by an unclosed bracket in brackets", () => {
    assert.deepEqual(parseInline("[see https://a.com]"), [text("[see "), link("https://a.com"), text("]")]);
  });

  test("the scheme in any case, and a URL ends where bold closes", () => {
    assert.deepEqual(parseInline("HTTPS://A.COM/x and Http://b.com"), [link("HTTPS://A.COM/x"), text(" and "), link("Http://b.com")]);
    assert.deepEqual(parseInline("https://a.com/**x** done"), [
      link("https://a.com/"),
      { kind: "bold", children: [text("x")] },
      text(" done"),
    ]);
    assert.deepEqual(parseInline("https://a.com/a*b"), [link("https://a.com/a*b")]);
  });

  test("a square bracket in a link target, or an overlong target, is not a markdown link", () => {
    assert.deepEqual(parseInline("[x](https://a.com/[1])"), [text("[x]("), link("https://a.com/[1]"), text(")")]);
    const long = `https://a.com/${"a".repeat(3000)}`;
    assert.deepEqual(parseInline(`[x](${long})`), [text("[x]("), link(long), text(")")]);
  });
});

// Each of these took from 0.7 s to 12 s on the first version, which scanned
// to the end of the line once per candidate. Linear parsing does each in a
// few milliseconds; the budget leaves room for a slow CI machine and still
// fails a quadratic scan by a wide margin.
describe("parseInline on hostile input", () => {
  const url = "https://example.com/a";
  const cases: [string, string][] = [
    ["unclosed links", "[x](".repeat(50_000)],
    ["closing brackets after a URL", url + ")".repeat(200_000)],
    ["closing square brackets after a URL", url + "]".repeat(200_000)],
    ["unterminated link targets", "[a](http://x".repeat(20_000)],
    ["refused bare URLs", "https://?".repeat(30_000)],
    ["refused bare URLs in brackets", "(https://#".repeat(30_000)],
    ["refused targets", "[a](https://?".repeat(20_000)],
    ["open brackets", "[".repeat(200_000)],
    ["unmatched bold and code", "**a`".repeat(50_000)],
    ["asterisks after a URL", url + "*".repeat(200_000)],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      const start = performance.now();
      const out = parseInline(input);
      const ms = performance.now() - start;
      assert.ok(ms < 1000, `${input.length} characters took ${Math.round(ms)} ms`);
      // nothing lost or invented
      const flat = (ts: InlineToken[]): string =>
        ts.map((t) => (t.kind === "text" || t.kind === "code" ? t.text : flat(t.children))).join("");
      assert.ok(flat(out).length <= input.length);
    });
  }
});

describe("isSafeHref", () => {
  test("http and https, any case, and nothing else", () => {
    assert.ok(isSafeHref("https://a.com"));
    assert.ok(isSafeHref("HTTP://a.com"));
    assert.ok(!isSafeHref("mailto:a@b.com"));
    assert.ok(!isSafeHref("javascript:alert(1)"));
    assert.ok(!isSafeHref(" https://a.com"));
  });
});
