// A server's own interface, and the terms it is framed under.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APP_CSP,
  MAX_APP_BYTES,
  allowsTool,
  appFrom,
  appsIn,
  documentIn,
  frameDocument,
  isApp,
  parseAppMessage,
  textOf,
  themeFrom,
} from "../server/mcp-apps.ts";
import { unwrapFrame } from "../server/mcp-client.ts";

describe("finding an interface among a server's resources", () => {
  test("either the scheme or the media type says so", () => {
    assert.equal(isApp({ uri: "ui://dashboard" }), true);
    assert.equal(isApp({ uri: "file:///report.html", mimeType: "text/html" }), true);
    assert.equal(isApp({ uri: "res://notes", mimeType: "text/plain" }), false);
    assert.equal(isApp({ uri: "res://data", mimeType: "application/json" }), false);
    assert.equal(isApp({ uri: 7 as never }), false);
  });

  test("a name a person can read, whatever the server gave", () => {
    assert.equal(appFrom({ uri: "ui://widgets/sales-report" }).name, "sales report");
    assert.equal(appFrom({ uri: "ui://x", name: "Sales" }).name, "Sales");
    assert.equal(appFrom({ uri: "file:///a/b/monthly_view.html" }).name, "monthly view");
  });

  test("only the interfaces come back", () => {
    const apps = appsIn([
      { uri: "ui://one" },
      { uri: "res://two", mimeType: "text/plain" },
      { uri: "file:///three.html", mimeType: "text/html" },
    ]);
    assert.deepEqual(apps.map((a) => a.uri), ["ui://one", "file:///three.html"]);
  });
});

describe("the document out of a read", () => {
  test("text, or base64, or nothing at all", () => {
    assert.equal(documentIn([{ uri: "ui://a", text: "<p>hi</p>" }]), "<p>hi</p>");
    assert.equal(
      documentIn([{ uri: "ui://a", blob: Buffer.from("<p>b</p>").toString("base64") }]),
      "<p>b</p>",
    );
    assert.equal(documentIn([{ uri: "ui://a" }]), null);
    assert.equal(documentIn([{ uri: "ui://a", text: "   " }]), null);
    assert.equal(documentIn([]), null);
  });

  test("something enormous does not become the app", () => {
    const huge = Buffer.alloc(MAX_APP_BYTES + 10, 0x61).toString("base64");
    assert.equal(documentIn([{ uri: "ui://a", blob: huge }]), null);
    const long = "x".repeat(MAX_APP_BYTES + 500);
    assert.equal(documentIn([{ uri: "ui://a", text: long }])?.length, MAX_APP_BYTES);
  });
});

describe("the terms it is framed under", () => {
  const theme = themeFrom({ scheme: "dark", background: "#101013", foreground: "#eee" });

  test("no network of any kind", () => {
    // the one rule that matters: a panel that can call home is a way to
    // move whatever it can see off this machine
    assert.match(APP_CSP, /default-src 'none'/);
    assert.match(APP_CSP, /connect-src 'none'/);
    assert.match(APP_CSP, /form-action 'none'/);
    assert.equal(/img-src[^;]*https?:/.test(APP_CSP), false);
    assert.equal(/script-src[^;]*https?:/.test(APP_CSP), false);
  });

  test("the policy is the first thing the parser meets", () => {
    const framed = frameDocument("<p>hello</p>", theme);
    const csp = framed.indexOf("Content-Security-Policy");
    const body = framed.indexOf("<p>hello</p>");
    assert.ok(csp > 0 && csp < body, "a policy after the document is not a policy");
    assert.match(framed, /^<!doctype html>/);
  });

  test("the app's colours go in, and nothing else about the app does", () => {
    const framed = frameDocument("<p>x</p>", theme);
    assert.match(framed, /--bloks-bg:#101013/);
    assert.match(framed, /color-scheme:dark/);
    assert.equal(framed.includes("localStorage"), false);
  });

  test("a colour with a rule ending in it is not a colour", () => {
    const hostile = themeFrom({
      scheme: "light",
      background: "#fff}</style><script>fetch('//evil')</script><style>",
      foreground: "rgb(1, 2, 3)",
    });
    assert.equal(hostile.background, "#ffffff", "the injection should fall back to the default");
    assert.equal(hostile.foreground, "rgb(1, 2, 3)", "an ordinary colour still works");
    assert.equal(frameDocument("", hostile).includes("evil"), false);
  });
});

describe("what a framed app may ask for", () => {
  test("a tool call, in either of the shapes servers send", () => {
    assert.deepEqual(parseAppMessage({ type: "tool", payload: { toolName: "refresh", params: { id: 2 } } }), {
      kind: "tool",
      tool: "refresh",
      args: { id: 2 },
    });
    assert.deepEqual(parseAppMessage({ type: "tool", name: "refresh", arguments: { a: 1 } }), {
      kind: "tool",
      tool: "refresh",
      args: { a: 1 },
    });
    assert.equal(parseAppMessage({ type: "tool", payload: {} }), null);
  });

  test("something to say, something to show, somewhere to go", () => {
    assert.deepEqual(parseAppMessage({ type: "prompt", payload: { prompt: "summarise this" } }), {
      kind: "prompt",
      text: "summarise this",
    });
    assert.deepEqual(parseAppMessage({ type: "notify", payload: { message: "saved" } }), {
      kind: "notify",
      text: "saved",
    });
    assert.deepEqual(parseAppMessage({ type: "link", payload: { url: "https://example.com/x" } }), {
      kind: "link",
      href: "https://example.com/x",
    });
  });

  test("a link that is not the web is not a link", () => {
    // a framed document does not get to hand the system a path or a
    // scheme that opens another application
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "bloks://x", "//evil.example"]) {
      assert.equal(parseAppMessage({ type: "link", payload: { url } }), null, `${url} should be refused`);
    }
  });

  test("anything else is dropped", () => {
    for (const bad of [null, 7, "tool", {}, { type: "eval", payload: { code: "1" } }, { type: "tool" }]) {
      assert.equal(parseAppMessage(bad), null);
    }
  });

  test("a height, clamped to something a panel could be", () => {
    assert.deepEqual(parseAppMessage({ type: "size", payload: { height: 300 } }), { kind: "size", height: 300 });
    assert.deepEqual(parseAppMessage({ type: "size", payload: { height: 9e9 } }), { kind: "size", height: 4_000 });
    assert.deepEqual(parseAppMessage({ type: "size", payload: { height: 1 } }), { kind: "size", height: 120 });
    assert.equal(parseAppMessage({ type: "size", payload: { height: "tall" } }), null);
  });

  test("only a tool the server published may be called", () => {
    const tools = [{ name: "refresh" }, { name: "export" }];
    assert.equal(allowsTool(tools, "refresh"), true);
    assert.equal(allowsTool(tools, "delete_everything"), false);
    assert.equal(allowsTool([], "refresh"), false);
  });

  test("a result is read for its words", () => {
    assert.equal(textOf({ content: [{ type: "text", text: "done" }] }), "done");
    assert.equal(textOf({ content: [{ type: "image", data: "x" }] }), "");
    assert.equal(textOf(null), "");
  });
});

describe("reading an answer off the wire", () => {
  test("a plain body and an event stream say the same thing", () => {
    assert.deepEqual(unwrapFrame('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'), { tools: [] });
    assert.deepEqual(
      unwrapFrame('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'),
      { ok: true },
    );
  });

  test("an error is raised rather than returned as a result", () => {
    assert.throws(
      () => unwrapFrame('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such method"}}'),
      /no such method/,
    );
    assert.throws(() => unwrapFrame("   "), /returned nothing/);
  });
});
