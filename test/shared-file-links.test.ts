// A file an agent shared, read out of a reply: which links open the
// in-app viewer, which stay links, and which file each one names.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseInline, type InlineToken } from "../src/lib/inlineMarkdown.ts";
import { readFileSync } from "node:fs";

import { artifactHref, cleanName, failureActions, failureKind, fileBase, fileTarget, linkPath, looksShared, openFailure, shareRequestText, viewerFor } from "../src/lib/sharedFile.ts";
import { attachmentHeader, mimeOf, parseRange, safeName } from "../server/artifacts.ts";

const text = (t: string): InlineToken => ({ kind: "text", text: t });
const file = (href: string, label = href): InlineToken => ({ kind: "file", href, children: [text(label)] });

describe("a link to a shared file", () => {
  test("the route a file is served at, encoded or not, with folders", () => {
    assert.deepEqual(fileTarget("/api/bots/b1/artifacts/report.pdf"), { kind: "artifact", botId: "b1", name: "report.pdf" });
    assert.deepEqual(fileTarget("/api/bots/b1/artifacts/reports%2Fq3%20final.pdf"), {
      kind: "artifact",
      botId: "b1",
      name: "reports/q3 final.pdf",
    });
    assert.deepEqual(fileTarget("/api/bots/b1/artifacts/reports/q3.pdf?download"), {
      kind: "artifact",
      botId: "b1",
      name: "reports/q3.pdf",
    });
    // this computer's own address in front, as an agent may write it
    assert.deepEqual(fileTarget("http://127.0.0.1:8799/api/bots/b1/artifacts/clip.mp4"), {
      kind: "artifact",
      botId: "b1",
      name: "clip.mp4",
    });
    assert.equal(artifactHref("b1", "reports/q3 final.pdf"), "/api/bots/b1/artifacts/reports%2Fq3%20final.pdf");
  });

  test("a name that climbs out, or hides, is not a shared file", () => {
    for (const href of [
      "/api/bots/b1/artifacts/..%2F..%2Fconfig.json",
      "/api/bots/b1/artifacts/reports/../../x",
      "/api/bots/b1/artifacts/%2e%2e/x",
      "/api/bots/b1/artifacts/.env",
      "/api/bots/b1/artifacts/a%5Cb",
      "/api/bots/b1/artifacts/%E0%A4%A",
      "https://example.com/api/bots/b1/artifacts/x.pdf",
    ]) {
      const target = fileTarget(href);
      assert.ok(!target || target.kind !== "artifact", href);
    }
  });

  test("a path on the server is passed on for the server to judge", () => {
    assert.deepEqual(fileTarget("/Users/a/.bloks/artifacts/b1/q3.pdf"), { kind: "path", path: "/Users/a/.bloks/artifacts/b1/q3.pdf" });
    assert.deepEqual(fileTarget("file:///tmp/x.pdf"), { kind: "path", path: "file:///tmp/x.pdf" });
    assert.deepEqual(fileTarget("~/Desktop/x.pdf"), { kind: "path", path: "~/Desktop/x.pdf" });
    // a web address, protocol-relative or not, stays a web address
    assert.equal(fileTarget("//evil.example/x"), null);
    assert.equal(fileTarget("https://example.com/x.pdf"), null);
    assert.equal(fileTarget("mailto:a@b.com"), null);
    assert.equal(fileTarget("javascript:alert(1)"), null);
  });

  test("a code span is offered only when it reads like a deliverable", () => {
    assert.ok(looksShared("/Users/a/.bloks/artifacts/b1/reports/q3.pdf"));
    assert.ok(looksShared("file:///Users/a/.bloks/artifacts/b1/q3.md"));
    assert.ok(looksShared("/api/bots/b1/artifacts/q3.md"));
    assert.ok(!looksShared("/usr/bin/env"));
    assert.ok(!looksShared("src/index.ts"));
    assert.ok(!looksShared("/Users/a/project/server/artifacts.ts"));
    assert.ok(!looksShared("npm test"));
  });

  test("names judged the same way the server judges them", () => {
    for (const name of ["q3.pdf", "reports/q3.pdf", "a/b/c/d.md", "Café menu.pdf", "data (2).csv"]) {
      assert.equal(cleanName(name), name);
      assert.equal(safeName(name), name);
    }
    for (const bad of ["", "../x", "a/../b", "a//b", ".env", "a/.git/config", "/abs", "a\\b", "a\u0000b", "a/b/c/d/e/f/g/h/i"]) {
      assert.equal(cleanName(bad), null, bad);
      assert.equal(safeName(bad), null, bad);
    }
    assert.equal(fileBase("reports/q3.pdf"), "q3.pdf");
  });
});

describe("links in a reply", () => {
  test("a link to a shared file or a path becomes a file, not a link", () => {
    assert.deepEqual(parseInline("see [the report](/api/bots/b1/artifacts/reports%2Fq3.pdf)"), [
      text("see "),
      file("/api/bots/b1/artifacts/reports%2Fq3.pdf", "the report"),
    ]);
    assert.deepEqual(parseInline("[x](/relative)"), [file("/relative", "x")]);
    assert.deepEqual(parseInline("[x](file:///etc/passwd)"), [file("file:///etc/passwd", "x")]);
    // a target with spaces, written the markdown way
    assert.deepEqual(parseInline("[clip](</Users/a/.bloks/artifacts/b1/my clip.mp4>) now"), [
      file("/Users/a/.bloks/artifacts/b1/my clip.mp4", "clip"),
      text(" now"),
    ]);
    // a bare address of this computer's file route opens the viewer too
    assert.deepEqual(parseInline("at http://127.0.0.1:8799/api/bots/b1/artifacts/q3.pdf"), [
      text("at "),
      file("http://127.0.0.1:8799/api/bots/b1/artifacts/q3.pdf"),
    ]);
  });

  test("a web link with spaces, or a scheme nobody allowed, is still text", () => {
    // only the bare address inside is linked, as before
    assert.ok(!parseInline("[x](<https://a.com/b c>)").some((t) => t.kind === "file"));
    assert.deepEqual(parseInline("[x](javascript:alert(1))"), [text("[x](javascript:alert(1))")]);
    assert.deepEqual(parseInline("[x](//evil.example/x)"), [text("[x](//evil.example/x)")]);
  });

  test("an unclosed angle target costs one pass", () => {
    const start = performance.now();
    parseInline("[a](</x".repeat(30_000));
    assert.ok(performance.now() - start < 1000);
  });
});

describe("what opens a file", () => {
  test("each type has its viewer, video included", () => {
    assert.equal(viewerFor(mimeOf("a.pdf"), "a.pdf"), "pdf");
    assert.equal(viewerFor(mimeOf("a.png"), "a.png"), "image");
    assert.equal(viewerFor(mimeOf("a.md"), "a.md"), "markdown");
    assert.equal(viewerFor(mimeOf("a.txt"), "a.txt"), "text");
    for (const ext of ["mp4", "mov", "webm", "m4v"]) {
      assert.match(mimeOf(`clip.${ext}`), /^video\//, ext);
      assert.equal(viewerFor(mimeOf(`clip.${ext}`), `clip.${ext}`), "video", ext);
    }
    assert.equal(mimeOf("clip.mov"), "video/quicktime");
    assert.equal(mimeOf("clip.webm"), "video/webm");
    assert.equal(viewerFor(mimeOf("a.zip"), "a.zip"), "none");
  });

  test("a failure reads as what to do about it", () => {
    assert.match(openFailure(404), /moved or deleted/);
    assert.match(openFailure(0), /reach/);
    assert.match(openFailure(403), /can.t open/);
    assert.equal(openFailure(404, "Ask the agent to share it."), "Ask the agent to share it.");
  });
});

describe("serving a file", () => {
  test("a byte range, the way a video player seeks", () => {
    assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 });
    assert.equal(parseRange("bytes=1000-", 1000), null);
    assert.equal(parseRange(undefined, 1000), undefined);
    assert.equal(parseRange("bytes=0-1,5-9", 1000), undefined);
    assert.equal(parseRange("items=0-1", 1000), undefined);
  });

  test("a download's name survives any characters", () => {
    const header = attachmentHeader("reports/Café \"menu\".pdf");
    assert.match(header, /^attachment; filename="Caf_ menu.pdf"; filename\*=UTF-8''Caf%C3%A9%20%22menu%22\.pdf$/);
    assert.ok(/^[\x20-\x7e]*$/.test(header), "a header must be plain ASCII");
  });
});

// A link to a file nobody shared, opened from another computer (GitHub
// 543): what the dialog offers for each reason it did not open, and what
// Request share writes. The runner has no DOM, so the dialog's wiring is
// read from its source, as the rules it has to keep.
describe("a file link that did not open", () => {
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

  test("each failure is not shared, for now, or final, from what the server answered", () => {
    assert.equal(failureKind(404, { shared: false }), "not-shared");
    // gone is 404 without the server saying it was never shared
    assert.equal(failureKind(404, {}), "final");
    assert.equal(failureKind(404, null), "final");
    assert.equal(failureKind(403, { shared: false }), "final");
    assert.equal(failureKind(413), "final");
    for (const status of [0, 408, 429, 500, 502, 503, 504]) assert.equal(failureKind(status), "temporary", String(status));
  });

  test("Try again only for a failure a second try can change, Request share only for the owner's chat", () => {
    assert.deepEqual(failureActions("not-shared", true), { tryAgain: false, requestShare: true });
    assert.deepEqual(failureActions("not-shared", false), { tryAgain: false, requestShare: false });
    assert.deepEqual(failureActions("temporary", true), { tryAgain: true, requestShare: false });
    assert.deepEqual(failureActions("final", true), { tryAgain: false, requestShare: false });
  });

  test("the request names the exact path, a file: URL as the path it stands for", () => {
    assert.equal(linkPath("/Users/a/Reports/q3 final.pdf"), "/Users/a/Reports/q3 final.pdf");
    assert.equal(linkPath("~/Desktop/x.pdf"), "~/Desktop/x.pdf");
    assert.equal(linkPath("file:///Users/a/Reports/q3%20final.pdf"), "/Users/a/Reports/q3 final.pdf");
    assert.equal(linkPath("file:///C:/Users/a/x.pdf"), "C:/Users/a/x.pdf");
    const text = shareRequestText("file:///Users/a/Reports/q3%20final.pdf");
    assert.ok(text.includes("`/Users/a/Reports/q3 final.pdf`"), text);
    assert.match(text, /share this file into our chat/);
    assert.match(text, /tell me why/);
    // a backtick in the name cannot end the code early
    assert.ok(shareRequestText("/tmp/a`b.txt").includes("`` /tmp/a`b.txt ``"));
  });

  test("the dialog offers Try again and Request share as those rules say, and Request share only fills the composer", () => {
    const dialog = source("components/Artifacts.tsx");
    const link = dialog.slice(dialog.indexOf("export function SharedFileLink"));
    assert.match(link, /failureActions\(opening\.kind, Boolean\(requestShare\)\)/);
    assert.match(link, /\{actions\?\.tryAgain && \(/);
    assert.match(link, /\{actions\?\.requestShare && requestShare && \(/);
    const press = link.slice(link.indexOf("actions?.requestShare && requestShare"), link.indexOf('t("sharedFile.requestShare")'));
    assert.match(press, /requestShare\(href\);/);
    assert.doesNotMatch(press, /fetch\(|api\(|method:/, "Request share sends nothing itself");

    const chat = source("components/ChatView.tsx");
    const ask = chat.slice(chat.indexOf("const requestShare = (href: string) =>"), chat.indexOf("};", chat.indexOf("const requestShare = (href: string) =>")));
    assert.match(ask, /setPrefill\(\{ text: shareRequestText\(href\), nonce: Date\.now\(\), append: true \}\)/);
    assert.doesNotMatch(ask, /fetch\(|api\(|dispatch\(/, "it waits in the composer for the owner to send");
    assert.match(chat, /<ShareRequestContext\.Provider value=\{requestShare\}>/);

    // a draft already typed is kept, with the request after it
    const composer = source("components/Composer.tsx");
    assert.match(composer, /if \(prefill\.append && latest\.current\.text\.trim\(\)\) \{\s*setDraft\(\{ \.\.\.latest\.current, text: `\$\{latest\.current\.text\.trimEnd\(\)\}\\n\\n\$\{back\.text\}` \}\);/);

    // a member's app and a room offer no Request share: nothing provides it there
    for (const file of ["components/member/MemberApp.tsx", "components/member/MemberParts.tsx", "components/member/MemberViews.tsx", "components/RoomView.tsx"]) {
      assert.doesNotMatch(source(file), /ShareRequestContext/, file);
    }
  });
});
