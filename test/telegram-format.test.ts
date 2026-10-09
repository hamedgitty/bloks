// What an agent's reply looks like by the time it reaches a phone.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MESSAGE_CHARS, messages } from "../server/telegram-format.ts";
import { send } from "../server/telegram.ts";

/** Every tag a message opens is closed in that same message, in order.
 * Telegram refuses the whole message otherwise. */
function balanced(html: string): boolean {
  const open: string[] = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)(\w+)[^>]*>/g)) {
    if (!closing) open.push(name!);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

/** What Telegram counts: the text once the tags are read. */
function shown(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("long replies", () => {
  // The bug: one sendMessage of text.slice(0, 4000), and the tail of the
  // answer gone without a word.
  test("a long reply arrives whole, in order, in messages Telegram will take", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"Some words in it. ".repeat(12)}`);
    const reply = `${paragraphs.join("\n\n")}\n\nEND_OF_REPLY`;
    const sent = messages(reply, true);
    assert.ok(sent.length > 1);
    for (const chunk of sent) {
      assert.ok(chunk.plain.length <= MESSAGE_CHARS);
      assert.ok(shown(chunk.html!).length <= MESSAGE_CHARS);
    }
    assert.deepEqual(words(sent.map((chunk) => chunk.plain).join("\n")), words(reply));
    assert.match(sent.at(-1)!.plain, /END_OF_REPLY$/);
  });

  test("a break falls between paragraphs where it can", () => {
    const reply = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"x".repeat(300)}`).join("\n\n");
    for (const chunk of messages(reply, true, 1_000)) {
      assert.match(chunk.plain, /^Paragraph \d+ x+$/m);
      assert.match(chunk.plain, /x$/, "no message ends partway through a paragraph");
      assert.match(chunk.plain, /^Paragraph/, "and none starts partway through one");
    }
  });

  test("one enormous line is cut at spaces, never through a word", () => {
    const reply = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const sent = messages(reply, true, 500);
    assert.ok(sent.length > 10);
    assert.deepEqual(words(sent.map((chunk) => chunk.plain).join(" ")), words(reply));
  });

  test("a line with no spaces at all still arrives whole", () => {
    const reply = "a".repeat(2_500);
    const sent = messages(reply, false, 1_000);
    assert.deepEqual(sent.map((chunk) => chunk.plain.length), [1_000, 1_000, 500]);
    assert.equal(sent.map((chunk) => chunk.plain).join(""), reply);
  });

  test("an emoji is never cut in half", () => {
    const reply = "😀".repeat(800);
    const sent = messages(reply, true, 301);
    assert.equal(sent.map((chunk) => chunk.plain).join(""), reply);
    for (const chunk of sent) assert.doesNotMatch(chunk.plain, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });

  test("bold and links that cross a break are closed and reopened, with the same target", () => {
    const reply = `**${"bold words ".repeat(60).trim()}** and [${"link words ".repeat(60)}](https://example.com/far)`;
    const sent = messages(reply, true, 400);
    assert.ok(sent.length > 2);
    for (const chunk of sent) {
      assert.ok(balanced(chunk.html!), chunk.html!);
      assert.doesNotMatch(chunk.html!, /\*\*|\]\(/, "no half of a marker is left showing");
    }
    const linked = sent.filter((chunk) => chunk.html!.includes("<a "));
    assert.ok(linked.length > 1);
    for (const chunk of linked) assert.match(chunk.html!, /<a href="https:\/\/example\.com\/far">/);
    for (const chunk of linked) assert.match(chunk.plain, /\(https:\/\/example\.com\/far\)/);
  });

  test("a long line of markers and brackets that never close is read in one pass", () => {
    // Each opening star searched the rest of its line for a close, so a
    // 24,000 character line of them held the server for seconds; a line
    // of brackets did the same looking for a link.
    const lines = ["*a ", "_a ", "**a ", "~~a ", "[a "].map((piece) => piece.repeat(Math.ceil(60_000 / piece.length)));
    lines.push(`${"[a ".repeat(20_000)}](not a link)`);
    const started = Date.now();
    for (const line of lines) {
      const sent = messages(line, true);
      assert.deepEqual(words(sent.map((chunk) => chunk.plain).join(" ")), words(line));
      for (const chunk of sent) assert.doesNotMatch(chunk.html!, /<[ibsa][ >]/, "nothing in it closes");
    }
    // the old reading took about ten seconds for these; this takes milliseconds
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
  });

  test("a link to an address longer than a message goes as text, not a message per letter", () => {
    const address = `https://example.com/${"x".repeat(9_000)}`;
    const sent = messages(`See [the long one](${address}) for more.`, true);
    assert.ok(sent.length <= 4, `${sent.length} messages`);
    for (const chunk of sent) {
      assert.ok(chunk.plain.length <= MESSAGE_CHARS);
      assert.ok(shown(chunk.html!).length <= MESSAGE_CHARS);
      assert.ok(balanced(chunk.html!));
    }
    const all = sent.map((chunk) => chunk.plain).join("");
    assert.ok(all.includes(`the long one(${address})`) || all.includes(`the long one (${address})`), "the words or the address went missing");
    // an ordinary link in the same reply is still a link
    const [chunk] = messages(`[short](https://example.com/a) and [long](${address})`, true);
    assert.match(chunk!.html!, /<a href="https:\/\/example\.com\/a">short<\/a>/);
  });

  test("a code block too long for one message is a code block in each", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line_${i} = value_${i}`).join("\n");
    const sent = messages(`Here it is:\n\n\`\`\`python\n${code}\n\`\`\`\n\nDone.`, true, 1_000);
    const blocks = sent.filter((chunk) => chunk.html!.includes("<pre>"));
    assert.ok(blocks.length > 2);
    for (const chunk of blocks) {
      assert.ok(balanced(chunk.html!));
      assert.match(chunk.html!, /<pre><code class="language-python">/);
    }
    const lines = sent.flatMap((chunk) => chunk.plain.split("\n")).filter((line) => line.startsWith("line_"));
    assert.equal(lines.join("\n"), code, "every line, once, in order, untouched");
  });
});

describe("Markdown, as Telegram shows it", () => {
  test("emphasis, code, a code block and a labelled link", () => {
    const [chunk] = messages(
      "**Status**: *Ready*. Look at `result_value`.\n\n```ts\nconst a = 1;\n```\n\nSee [Reference](https://example.com/reference).",
      true,
    );
    assert.equal(
      chunk!.html,
      [
        "<b>Status</b>: <i>Ready</i>. Look at <code>result_value</code>.",
        "",
        '<pre><code class="language-ts">const a = 1;</code></pre>',
        "",
        'See <a href="https://example.com/reference">Reference</a>.',
      ].join("\n"),
    );
    // The fallback keeps the address, so the link is still a link to follow.
    assert.match(chunk!.plain, /See Reference \(https:\/\/example\.com\/reference\)\./);
    assert.doesNotMatch(chunk!.plain, /\*|`/);
  });

  test("whatever an agent writes cannot become markup of its own", () => {
    // An agent quoting HTML, or a page it read, must not get to style the
    // message, or break it so Telegram refuses it.
    const [chunk] = messages('a <b>not bold</b> & `<i>x</i>` [t](https://e.com/?a="1"&b=2)', true);
    assert.equal(
      chunk!.html,
      'a &lt;b&gt;not bold&lt;/b&gt; &amp; <code>&lt;i&gt;x&lt;/i&gt;</code> <a href="https://e.com/?a=&quot;1&quot;&amp;b=2">t</a>',
    );
  });

  test("only web, mail and Telegram links become links", () => {
    const [chunk] = messages("[run me](javascript:alert(1)) and [file](/etc/passwd)", true);
    assert.doesNotMatch(chunk!.html!, /<a /);
  });

  test("names, sums and stray stars are left as they were written", () => {
    const said = "snake_case_name and __init__ is 2 * 3 * 4, a lone * star, and 5*";
    const [chunk] = messages(said, true);
    assert.match(chunk!.plain, /snake_case_name/);
    assert.match(chunk!.plain, /2 \* 3 \* 4, a lone \* star, and 5\*/);
    assert.doesNotMatch(chunk!.html!, /<i>/);
  });

  test("headings and bullets read the way a chat shows them", () => {
    const [chunk] = messages("## Plan\n- first\n* second", true);
    assert.equal(chunk!.html, "<b>Plan</b>\n• first\n• second");
  });

  test("the bot's own words are sent as written", () => {
    const [chunk] = messages("Run `rm *.log`? *maybe*", false);
    assert.equal(chunk!.html, undefined);
    assert.equal(chunk!.plain, "Run `rm *.log`? *maybe*");
  });
});

describe("sending", () => {
  const record = (t: { mock: { method: Function } }, answer: (body: any, n: number) => Response) => {
    const bodies: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return answer(body, bodies.length);
    });
    return bodies;
  };
  const ok = () => Response.json({ ok: true, result: {} });

  test("a long reply is as many messages as it needs, formatted, in order", async (t) => {
    const bodies = record(t, ok);
    const reply = Array.from({ length: 30 }, (_, i) => `**${i}** ${"words ".repeat(50)}`).join("\n\n");
    await send("T", 42, reply, true);
    assert.ok(bodies.length > 1);
    for (const body of bodies) {
      assert.equal(body.parse_mode, "HTML");
      assert.equal(body.chat_id, 42);
    }
    const order = bodies.flatMap((body) => [...String(body.text).matchAll(/<b>(\d+)<\/b>/g)].map((m) => Number(m[1])));
    assert.deepEqual(order, Array.from({ length: 30 }, (_, i) => i));
  });

  test("a message Telegram will not format goes again as plain text, link kept", async (t) => {
    const bodies = record(t, (body) =>
      body.parse_mode ? Response.json({ ok: false, description: "can't parse entities" }, { status: 400 }) : ok(),
    );
    await send("T", 42, "**Done**, see [the notes](https://example.com/notes)", true);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], { chat_id: 42, text: "Done, see the notes (https://example.com/notes)" });
  });

  test("being told to slow down waits and sends the same message again", async (t) => {
    const bodies = record(t, (_body, n) =>
      n === 1 ? Response.json({ ok: false, parameters: { retry_after: 0 } }, { status: 429 }) : ok(),
    );
    await send("T", 42, "hello", true);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
  });

  test("any other failure stops there rather than leaving a gap", async (t) => {
    const bodies = record(t, () => new Response("{}", { status: 403 }));
    await assert.rejects(send("T", 42, `one\n\n${"x".repeat(5_000)}`, true), /HTTP 403/);
    assert.equal(bodies.length, 1);
  });
});
