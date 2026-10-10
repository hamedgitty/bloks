#!/usr/bin/env node
// A stand-in for Chrome, as far as server/cdp.ts can tell, for the tests.
//
// Started with --user-data-dir and --remote-debugging-port, it listens
// where it was asked (0 is any free port), writes DevToolsActivePort into
// the profile the way Chrome does, answers /json/version and /json/list,
// and quits when Browser.close arrives on its browser socket. Its one page
// is titled with the profile, so a test can tell whose browser it reached.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = flag("user-data-dir");
const asked = Number(flag("remote-debugging-port") ?? 9222);
const browserPath = `/devtools/browser/${randomUUID()}`;

const server = createServer((req, res) => {
  const ws = `ws://127.0.0.1:${server.address().port}`;
  res.setHeader("content-type", "application/json");
  if (req.url === "/json/version") {
    return res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: `${ws}${browserPath}` }));
  }
  if (req.url === "/json/list") {
    return res.end(JSON.stringify([{ id: "page", type: "page", title: profile, url: "about:blank", webSocketDebuggerUrl: `${ws}/devtools/page/page` }]));
  }
  res.statusCode = 404;
  res.end("{}");
});

/** One text frame from the client, which masks everything it sends. */
function unframe(data) {
  let length = data[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    length = data.readUInt16BE(2);
    at = 4;
  }
  const mask = data.subarray(at, at + 4);
  const body = Buffer.from(data.subarray(at + 4, at + 4 + length));
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return body.toString("utf8");
}

server.on("upgrade", (req, socket, head) => {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const receive = (data) => {
    if (!data.length || (data[0] & 0x0f) !== 1) return;
    let message;
    try {
      message = JSON.parse(unframe(data));
    } catch {
      return;
    }
    const reply = Buffer.from(JSON.stringify({ id: message.id, result: {} }));
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    if (message.method === "Browser.close" && req.url === browserPath) setTimeout(() => process.exit(0), 20);
  };
  if (head.length) receive(head);
  socket.on("data", receive);
});

server.listen(asked, "127.0.0.1", () => {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "DevToolsActivePort"), `${server.address().port}\n${browserPath}`);
});

// never outlives a test run that forgot it
setTimeout(() => process.exit(0), 120_000).unref();
