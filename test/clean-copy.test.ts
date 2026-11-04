// What a copy out of the chat puts on the clipboard as HTML
// (src/lib/cleanCopy.ts): structure kept bare, the app's own chrome and
// styling left behind, and nothing of the page passed through as markup.
// The nodes here are plain objects with the few DOM fields it reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCopyHtml, droppedFromCopy, type CopyNode } from "../src/lib/cleanCopy.ts";

type Child = CopyNode | string;

function text(value: string): CopyNode {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] };
}

function h(tag: string, attrs: Record<string, string> | null, ...children: Child[]): CopyNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: children.map((child) => (typeof child === "string" ? text(child) : child)),
    getAttribute: (name) => attrs?.[name] ?? null,
  };
}

function fragment(...children: Child[]): CopyNode {
  return { nodeType: 11, nodeName: "#document-fragment", nodeValue: null, childNodes: children.map((child) => (typeof child === "string" ? text(child) : child)) };
}

test("a reply keeps its headings, paragraphs, lists, emphasis and code, bare", () => {
  const reply = h(
    "div",
    { class: "w-full min-w-0 text-lead text-foreground", style: "color: white" },
    h("h2", { class: "mt-6 text-title font-semibold" }, "Plan"),
    "\n",
    h("p", { class: "mt-3" }, "Ship ", h("strong", { class: "font-semibold" }, "today"), ", then ", h("em", null, "rest"), "."),
    h("ul", { class: "pl-6 list-disc" }, h("li", { class: "pl-1" }, h("span", null, "one")), "\n", h("li", { class: "mt-1" }, h("span", null, "two"))),
    h("ol", { start: "3" }, h("li", null, "three")),
    h("p", null, "Run ", h("code", { class: "rounded-[5px] font-mono" }, "pnpm test"), "."),
  );
  assert.equal(
    cleanCopyHtml(fragment(reply)),
    "<h2>Plan</h2><p>Ship <strong>today</strong>, then <em>rest</em>.</p><ul><li>one</li><li>two</li></ul><ol><li>three</li></ol><p>Run <code>pnpm test</code>.</p>",
  );
});

test("b and i are said as strong and em, and nothing keeps a style, class or id", () => {
  const html = cleanCopyHtml(fragment(h("p", { id: "x", class: "c", style: "color:#fff;background:#000" }, h("b", { style: "x" }, "bold"), " ", h("i", null, "it"))));
  assert.equal(html, "<p><strong>bold</strong> <em>it</em></p>");
  assert.doesNotMatch(html, /style|class|id=/);
});

test("links keep http, https and mailto addresses and lose every other", () => {
  const link = (href: string) => h("a", { href, target: "_blank", rel: "noreferrer", class: "text-brand-ink" }, "here");
  assert.equal(cleanCopyHtml(fragment(h("p", null, link("https://example.com/a?b=1&c=2")))), '<p><a href="https://example.com/a?b=1&amp;c=2">here</a></p>');
  assert.equal(cleanCopyHtml(fragment(h("p", null, link("http://example.com")))), '<p><a href="http://example.com">here</a></p>');
  assert.equal(cleanCopyHtml(fragment(h("p", null, link("mailto:ana@example.com")))), '<p><a href="mailto:ana@example.com">here</a></p>');
  for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/api/bots/x/artifacts/a.md", "bloks://install", "vbscript:x", ""]) {
    assert.equal(cleanCopyHtml(fragment(h("p", null, link(href)))), "<p>here</p>", href);
  }
  // an address cannot break out of its quotes
  assert.equal(cleanCopyHtml(fragment(link('https://e.com/"><script>'))), '<a href="https://e.com/&quot;&gt;&lt;script&gt;">here</a>');
});

test("text is escaped, never passed through as markup", () => {
  assert.equal(cleanCopyHtml(fragment(h("p", null, "<img src=x onerror=alert(1)> & \"q\""))), "<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</p>");
});

test("buttons, icons, pictures, timestamps and hidden things go with what is inside them", () => {
  const html = cleanCopyHtml(
    fragment(
      h(
        "div",
        null,
        h("p", null, "Words", h("svg", { "aria-hidden": "true" }, h("path", { d: "M0" }))),
        h("button", { class: "flex" }, h("span", null, "Copy")),
        h("img", { src: "/api/bots/x/avatar", alt: "Ben" }),
        h("time", { dateTime: "2026-11-04" }, "9:12 PM"),
        h("span", { "aria-hidden": "true" }, "✓"),
        h("span", { class: "sr-only" }, "Done "),
        h("span", { hidden: "" }, "secret"),
        h("input", { value: "typed" }),
        h("textarea", null, "draft"),
        h("select", null, h("option", null, "1x")),
        h("style", null, "p{color:red}"),
        h("script", null, "alert(1)"),
      ),
    ),
  );
  assert.equal(html, "<p>Words</p>");
});

test("what the page marks as its own is left out, and a link drawn as a button is kept", () => {
  const html = cleanCopyHtml(
    fragment(
      h("div", { "data-bubble": "agent" }, h("div", { "data-copy": "skip" }, "From your routine"), h("p", null, "Saved to ", h("button", { "data-copy": "keep", class: "inline underline" }, h("code", null, "report.md")), "."), h("span", { "data-copy": "skip" }, "(edited)")),
      h("div", { "data-copy": "skip", "data-actions": "" }, h("button", null, "Reply"), h("span", null, "9:12 PM")),
    ),
  );
  assert.equal(html, "<p>Saved to <code>report.md</code>.</p>");
});

test("code keeps its lines and spaces, and loses its bar and line numbers", () => {
  const block = h(
    "div",
    { class: "rounded-xl border" },
    h("div", { "data-copy": "skip", class: "sticky top-0" }, h("span", null, "ts"), h("button", null, h("svg", null), h("span", null, "Copy"))),
    h(
      "pre",
      { class: "overflow-x-auto whitespace-pre" },
      h("code", null, h("span", { class: "text-(--sx-keyword)" }, "const"), h("span", null, " a = 1;\n"), h("span", null, "if (a < 2) {\n  go();\n}")),
    ),
  );
  assert.equal(cleanCopyHtml(fragment(block)), "<pre><code>const a = 1;\nif (a &lt; 2) {\n  go();\n}</code></pre>");
  // a diff's gutter is drawn select-none, so it is no part of a copy
  const diff = h("pre", null, h("div", null, h("span", { class: "mr-3 select-none opacity-60" }, "12"), "+ added"));
  assert.equal(cleanCopyHtml(fragment(diff)), "<pre>+ added</pre>");
});

test("tables keep their rows and cells, empty cells included", () => {
  const table = h(
    "div",
    { class: "overflow-auto" },
    h(
      "table",
      { class: "w-full border-collapse" },
      h("thead", null, h("tr", { class: "border-b" }, h("th", { class: "px-3" }, "Name"), h("th", null, "Score"))),
      "\n",
      h("tbody", null, h("tr", null, h("td", { class: "px-3" }, "Ana"), h("td", null)), "\n"),
    ),
  );
  assert.equal(cleanCopyHtml(fragment(table)), "<table><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Ana</td><td></td></tr></tbody></table>");
});

test("a box of words is a paragraph, a box of boxes is what it holds", () => {
  const transcript = fragment(
    h("div", { "data-bubble": "user" }, h("div", { class: "min-w-0 whitespace-pre-wrap rounded-2xl" }, "Hi\nthere")),
    "\n  ",
    h("div", { "data-bubble": "agent" }, h("div", null, h("p", null, "Hello."), h("p", null, "How can I help?"))),
  );
  assert.equal(cleanCopyHtml(transcript), "<p>Hi<br>there</p><p>Hello.</p><p>How can I help?</p>");
});

test("a person's line breaks are kept as breaks; a reply's source wrapping is a space", () => {
  assert.equal(cleanCopyHtml(fragment(h("span", { class: "whitespace-pre-wrap" }, "one\ntwo\n\nthree"))), "one<br>two<br><br>three");
  assert.equal(cleanCopyHtml(fragment(h("p", null, "one\n   two"))), "<p>one two</p>");
  assert.equal(cleanCopyHtml(fragment(h("p", null, "one", h("br", null), "two"))), "<p>one<br>two</p>");
});

test("words alone stay words, so a phrase pasted into a sentence is not a paragraph", () => {
  assert.equal(cleanCopyHtml(fragment("  a few ", h("strong", null, "words"), " ")), "a few <strong>words</strong>");
  assert.equal(cleanCopyHtml(fragment(h("span", { class: "text-brand-ink" }, "@Kat"), " hi")), "@Kat hi");
});

test("a selection of nothing but chrome has no HTML at all", () => {
  assert.equal(cleanCopyHtml(fragment(h("button", null, "Copy"))), "");
  assert.equal(cleanCopyHtml(fragment(h("div", null, "  \n "), h("time", null, "9:12"))), "");
  assert.equal(cleanCopyHtml(fragment()), "");
});

test("quotes and nested lists keep their shape", () => {
  const html = cleanCopyHtml(
    fragment(
      h("blockquote", { class: "border-l-2" }, h("p", null, "Said before")),
      h("ul", null, h("li", null, h("span", null, "outer"), h("ul", null, h("li", null, "inner")))),
    ),
  );
  assert.equal(html, "<blockquote><p>Said before</p></blockquote><ul><li>outer<ul><li>inner</li></ul></li></ul>");
});

test("what is chrome is decided by tag, attribute and class, and keep wins", () => {
  assert.equal(droppedFromCopy(h("button", null)), true);
  assert.equal(droppedFromCopy(h("button", { "data-copy": "keep" })), false);
  assert.equal(droppedFromCopy(h("div", { "data-copy": "skip" })), true);
  assert.equal(droppedFromCopy(h("svg", null)), true);
  assert.equal(droppedFromCopy({ ...h("svg", null), nodeName: "svg" }), true);
  assert.equal(droppedFromCopy(h("span", { class: "a select-none b" })), true);
  assert.equal(droppedFromCopy(h("span", { class: "not-sr-only" })), false);
  assert.equal(droppedFromCopy(h("p", null)), false);
  assert.equal(droppedFromCopy(text("words")), false);
});
