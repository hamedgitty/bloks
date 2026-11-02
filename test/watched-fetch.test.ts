// A watcher's page is somebody else's, and must not be able to point the
// watcher back at this server, or inward from out there
// (server/watched-fetch.ts).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { allowedFrom, fetchWatchedPage, reachOf } from "../server/watched-fetch.ts";

async function serve(handler: (path: string) => { status: number; location?: string; body?: string }): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const said = handler(req.url ?? "/");
    res.writeHead(said.status, said.location ? { location: said.location } : { "content-type": "text/plain" });
    res.end(said.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

test("every address has its place", () => {
  assert.equal(reachOf("8.8.8.8"), "public");
  assert.equal(reachOf("127.0.0.1"), "loopback");
  assert.equal(reachOf("::1"), "loopback");
  assert.equal(reachOf("::ffff:127.0.0.1"), "loopback");
  assert.equal(reachOf("192.168.1.1"), "private");
  assert.equal(reachOf("10.0.0.5"), "private");
  assert.equal(reachOf("100.101.102.103"), "private");
  assert.equal(reachOf("fd7a:115c:a1e0::1"), "private");
  assert.equal(reachOf("169.254.169.254"), "never");
  assert.equal(reachOf("0.0.0.0"), "never");
  assert.equal(reachOf("fe80::1"), "never");
  assert.equal(reachOf("::ffff:169.254.169.254"), "never");
});

test("a page out there never leads inward; one at home may stay home", () => {
  assert.deepEqual([...allowedFrom("public")], ["public"]);
  assert.ok(!allowedFrom("private").has("loopback"));
  assert.ok(allowedFrom("loopback").has("loopback"));
});

test("a page on this machine is watched, but never this server, directly or by redirect", async (t) => {
  const own = await serve(() => ({ status: 200, body: "the owner's webhooks" }));
  const page = await serve((path) =>
    path === "/to-own"
      ? { status: 302, location: `http://127.0.0.1:${own.port}/api/webhooks` }
      : path === "/to-metadata"
        ? { status: 302, location: "http://169.254.169.254/latest/meta-data/" }
        : path === "/hop"
          ? { status: 301, location: "/page" }
          : { status: 200, body: "hello" },
  );
  t.after(() => {
    own.server.close();
    page.server.close();
  });
  const o = { ownPorts: [own.port], timeoutMs: 5_000 };
  assert.equal(await fetchWatchedPage(`http://127.0.0.1:${page.port}/page`, o), "hello");
  assert.equal(await fetchWatchedPage(`http://127.0.0.1:${page.port}/hop`, o), "hello", "a redirect within the same place is followed");
  await assert.rejects(fetchWatchedPage(`http://127.0.0.1:${own.port}/api/webhooks`, o), /this server itself/);
  await assert.rejects(fetchWatchedPage(`http://localhost:${own.port}/api/webhooks`, o), /this server itself/);
  await assert.rejects(fetchWatchedPage(`http://127.0.0.1:${page.port}/to-own`, o), /this server itself/);
  await assert.rejects(fetchWatchedPage(`http://127.0.0.1:${page.port}/to-metadata`, o), /does not look|does not lead/);
  await assert.rejects(fetchWatchedPage("http://169.254.169.254/latest/meta-data/", o), /does not look/);
  await assert.rejects(fetchWatchedPage(`http://user:pw@127.0.0.1:${page.port}/page`, o), /names and passwords/);
});

test("a page that keeps redirecting is given up on", async (t) => {
  const loop = await serve(() => ({ status: 302, location: "/again" }));
  t.after(() => loop.server.close());
  await assert.rejects(fetchWatchedPage(`http://127.0.0.1:${loop.port}/`, { ownPorts: [], timeoutMs: 5_000 }), /too many times/);
});

test("an error answer is said as one", async (t) => {
  const gone = await serve(() => ({ status: 404 }));
  t.after(() => gone.server.close());
  await assert.rejects(fetchWatchedPage(`http://127.0.0.1:${gone.port}/`, { ownPorts: [], timeoutMs: 5_000 }), /answered 404/);
});
