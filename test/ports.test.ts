// Which port the desktop app's server gets (electron/ports.mjs), from #80:
// a busy usual port failed the whole app, and the page did not say which
// port or why.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import { anyFreePort, describeAttempt, failurePage, parseLsof, portFree, portOrder } from "../electron/ports.mjs";

test("a port you set comes first, then the one that worked last, then the usual ones", () => {
  assert.deepEqual(portOrder({ env: "9123", last: 18799 }), [9123, 18799, 8799, 28799]);
  assert.deepEqual(portOrder({ configured: 9200, last: 18799 }), [9200, 18799, 8799, 28799]);
  assert.deepEqual(portOrder({ env: undefined, last: null }), [8799, 18799, 28799]);
  assert.deepEqual(portOrder({ env: "not a port", last: 70000 }), [8799, 18799, 28799]);
});

test("a server brought back after it died tries the port it had before any other", () => {
  assert.deepEqual(portOrder({ prefer: 18799, configured: 8799, last: 28799 }), [18799, 8799, 28799]);
  assert.deepEqual(portOrder({ prefer: 40123, env: "9123" }), [40123, 9123, 8799, 18799, 28799]);
  assert.deepEqual(portOrder({ prefer: null, last: 18799 }), [18799, 8799, 28799]);
});

test("a busy port is seen as busy, and the system can always offer another", async () => {
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const taken = (holder.address() as { port: number }).port;
  try {
    assert.equal(await portFree(taken), false);
    const spare = await anyFreePort();
    assert.ok(spare && spare !== taken);
    assert.equal(await portFree(spare!), true);
  } finally {
    holder.close();
  }
});

test("the failure page names each port and what was on it", () => {
  assert.deepEqual(parseLsof("p4242\ncnode\n"), { name: "node", pid: 4242 });
  assert.equal(parseLsof(""), null);
  const line = describeAttempt({ port: 8799, why: "busy", holder: { name: "node", pid: 4242 } });
  assert.equal(line, "Port 8799 is in use by node (pid 4242).");
  const page = decodeURIComponent(
    failurePage({
      attempts: [
        { port: 8799, why: "busy", holder: { name: "node", pid: 4242 } },
        { port: 18799, why: "busy", holder: null },
      ],
      crash: "",
      backdrop: "#000",
      machine: "Mac",
    }),
  );
  assert.match(page, /Port 8799 is in use by node \(pid 4242\)/);
  assert.match(page, /Port 18799 is in use by another program/);
  assert.match(page, /config\.json/);
});

test("a server that crashed is not blamed on ports, and its words are shown safely", () => {
  const page = decodeURIComponent(
    failurePage({
      attempts: [{ port: 8799, why: "exited", holder: null }],
      crash: "Error: <boom> & more",
      backdrop: "#000",
      machine: "Mac",
    }),
  );
  assert.match(page, /stopped while starting/);
  assert.match(page, /This is not about ports/);
  assert.match(page, /&lt;boom&gt; &amp; more/);
  assert.doesNotMatch(page, /<boom>/);
});

test("a server that started and kept dying says so, with its last words when it had any", () => {
  const page = decodeURIComponent(
    failurePage({ attempts: [], crash: "FATAL ERROR: <heap> out of memory", stopped: true, backdrop: "#000", machine: "Mac" }),
  );
  assert.match(page, /keeps stopping/);
  assert.match(page, /each time Bloks brought it back/);
  assert.match(page, /&lt;heap&gt; out of memory/);
  assert.doesNotMatch(page, /free port|not about ports/);
  const quiet = decodeURIComponent(failurePage({ attempts: [], crash: "", stopped: true, backdrop: "#000", machine: "Mac" }));
  assert.match(quiet, /keeps stopping/);
  assert.doesNotMatch(quiet, /last words|<pre/);
});

test("another server holding the data folder is explained, not blamed on ports (GitHub 140)", () => {
  const page = decodeURIComponent(
    failurePage({
      attempts: [{ port: 18799, why: "exited", holder: null }],
      crash: "[bloks] DATA_FOLDER_IN_USE pid=4242 port=8799 dir=/Users/x/.bloks",
      inUse: { pid: 4242, port: 8799 },
      backdrop: "#000",
      machine: "Mac",
    }),
  );
  assert.match(page, /Bloks is already running on this Mac/);
  assert.match(page, /process 4242/);
  assert.match(page, /http:\/\/127\.0\.0\.1:8799/);
  assert.doesNotMatch(page, /stopped while starting|not about ports/);
});
