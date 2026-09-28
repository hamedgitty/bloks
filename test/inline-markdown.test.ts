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

  test("mailto is allowed, and only http, https and mailto are", () => {
    assert.deepEqual(parseInline("[mail me](mailto:a@b.com)"), [link("mailto:a@b.com", "mail me")]);
    for (const bad of [
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
});

describe("isSafeHref", () => {
  test("http, https and mailto, any case", () => {
    assert.ok(isSafeHref("https://a.com"));
    assert.ok(isSafeHref("HTTP://a.com"));
    assert.ok(isSafeHref("mailto:a@b.com"));
    assert.ok(!isSafeHref("javascript:alert(1)"));
    assert.ok(!isSafeHref(" https://a.com"));
    assert.ok(!isSafeHref("mailto:"));
  });
});
