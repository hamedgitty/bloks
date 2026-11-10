// The approval bridge on Windows itself (GitHub 501). Everywhere else the
// bridge is a unix socket and the other tests cover it; on Windows it is a
// named pipe, and a file path there listened on nothing, so every approval
// was denied as "permission broker unavailable". This asks one question
// down the real pipe and reads the answer back. It runs only on Windows:
// the Windows build runs it before packaging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

import { bridgeSocketPath, createAskBroker } from "../server/harness/ask-broker.ts";

test("an approval asked down the Windows pipe reaches the person and comes back", { skip: process.platform !== "win32" }, async () => {
  const socketPath = bridgeSocketPath("C:\\unused\\perm.sock")!;
  assert.match(socketPath, /^\\\\\.\\pipe\\bloks-/);
  const broker = createAskBroker({
    socketPath,
    onAsk: (ask) => setImmediate(() => broker.answer(ask.id, "allow")),
    onResolve: () => {},
  });
  try {
    const answer = await new Promise<any>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("error", reject);
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
        const line = seen.split("\n")[0];
        if (seen.includes("\n")) { socket.destroy(); resolve(JSON.parse(line)); }
      });
      socket.write(JSON.stringify({ t: "ask", id: "q1", tool: "WebSearch", input: { query: "bloks" } }) + "\n");
    });
    assert.equal(answer.t, "answer");
    assert.equal(answer.id, "q1");
    assert.equal(answer.behavior, "allow");
  } finally {
    broker.close();
  }
});
