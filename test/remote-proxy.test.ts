// The desktop app's window, when it runs against another computer, is
// served by a small proxy on this one (electron/remote.mjs). Its storage
// (folded sections, the sidebar, cards you closed) belongs to the page's
// origin, which includes the port, so the port has to be one it can keep.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type ServerResponse } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { startRemoteProxy } from "../electron/remote.mjs";

const ui = mkdtempSync(join(tmpdir(), "bloks-remote-ui-"));
writeFileSync(join(ui, "index.html"), "<!doctype html><title>Bloks</title>");
after(() => rmSync(ui, { recursive: true, force: true }));

// a relay nobody answers on: the proxy keeps retrying it quietly
const profile = { relayUrl: "http://127.0.0.1:9", relayToken: "t", deviceId: "d", deviceToken: "token" };

test("the proxy comes back on the port it is given, so the window keeps its storage", async () => {
  const first = await startRemoteProxy(profile, { staticDir: ui });
  const port = first.port;
  first.stop();
  await new Promise((r) => setTimeout(r, 50));
  const again = await startRemoteProxy(profile, { staticDir: ui, port });
  try {
    assert.equal(again.port, port);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
  } finally {
    again.stop();
  }
});

test("a port someone else took fails at once instead of hanging", async () => {
  const squatter = createServer();
  await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", () => r()));
  const taken = (squatter.address() as { port: number }).port;
  try {
    const outcome = await Promise.race([
      startRemoteProxy(profile, { staticDir: ui, port: taken }).then(
        (proxy) => (proxy.stop(), "started"),
        () => "refused",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    assert.equal(outcome, "refused");
  } finally {
    squatter.close();
  }
});

// The proxy signs everything it forwards as this device, so it has to
// hold the same line the server does: only the window on this computer.
test("a page from elsewhere is turned away, and the window's own page is pinned like the server's", async () => {
  const proxy = await startRemoteProxy(profile, { staticDir: ui });
  const port = proxy.port;
  const ask = (headers: Record<string, string>, path = "/api/bots") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on("error", reject);
      req.end("{}");
    });
  try {
    // another site in a browser on this machine
    assert.equal((await ask({ host: `127.0.0.1:${port}`, origin: "https://somewhere.example" })).status, 403);
    // a hostile name pointed at 127.0.0.1 still carries its own Host
    assert.equal((await ask({ host: `rebound.example:${port}` })).status, 403);
    // a page on another loopback port, or a sandboxed one
    assert.equal((await ask({ host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:3000" })).status, 403);
    assert.equal((await ask({ host: `127.0.0.1:${port}`, origin: "null" })).status, 403);
    // the window's own page, same origin
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    // and its own requests get past the door (the relay here answers
    // nobody, so what comes back is the proxy's own "could not reach")
    const own = await ask({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` });
    assert.notEqual(own.status, 403);
  } finally {
    proxy.stop();
  }
});

/** A relay whose event stream does what `line` says with each dial, and
 * which notes when each dial came. */
async function relay(line: (res: ServerResponse) => void) {
  const dials: number[] = [];
  const server = createHttpServer((req, res) => {
    if (req.url !== "/space/client/stream") return void res.writeHead(404).end();
    dials.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    line(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    dials,
    profile: { ...profile, relayUrl: url },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const until = async (check: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await new Promise((r) => setTimeout(r, 20));
  return check();
};

// The wait between dials went back to a second on any answer at all, so
// a relay that answered and dropped the line at once was dialled every
// second, forever, while the window still said connected.
test("a relay that drops the line before saying hello is dialled less and less often", async () => {
  const r = await relay((res) => res.end());
  const proxy = await startRemoteProxy(r.profile, { staticDir: ui });
  try {
    assert.ok(await until(() => r.dials.length >= 3, 8_000), `only ${r.dials.length} dials`);
    const [first, second, third] = r.dials;
    assert.ok(second - first >= 800, `the second dial came ${second - first} ms after the first`);
    assert.ok(third - second >= 1_800, `the third dial came ${third - second} ms after the second, no later than the one before`);
  } finally {
    proxy.stop();
    r.close();
  }
});

test("a line the relay ends cleanly is reported gone, not left showing connected", async () => {
  const r = await relay((res) => res.end(`data: ${JSON.stringify({ kind: "hello", online: true })}\n\n`));
  const states: Array<Record<string, unknown>> = [];
  const proxy = await startRemoteProxy(r.profile, { staticDir: ui, onState: (state) => states.push(state) });
  try {
    assert.ok(await until(() => states.length >= 2, 900), `heard only ${JSON.stringify(states)}`);
    assert.deepEqual(states.slice(0, 2), [{ connected: true }, { connected: false }]);
  } finally {
    proxy.stop();
    r.close();
  }
});
