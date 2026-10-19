// A real server and local relay with synthetic owner/member devices.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { deviceKey, inviteKey, open, peek, seal } from "../../server/relay-crypto.ts";
import { startHarness } from "./server.ts";
import { waitFor } from "./turns.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function alertWorkspace(t: TestContext, staticDir = "") {
  const home = mkdtempSync(join(tmpdir(), "bloks-alerts-"));
  const folder = join(home, ".bloks");
  mkdirSync(folder);
  const roomId = "room-example";
  const devices = [
    { id: "owner-device", name: "Host", token: "example-owner-token" },
    { id: "aya-device", name: "Aya", token: "example-aya-token", personId: "p_aya" },
    { id: "ben-device", name: "Ben", token: "example-ben-token", personId: "p_ben" },
  ].map((d) => ({ ...d, hash: digest(d.token), pairedAt: 1 }));
  const cli = join(home, "claude.mjs");
  writeFileSync(join(folder, "config.json"), JSON.stringify({
    profile: { name: "Host" }, brief: { enabled: false },
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
    remote: { enabled: true, devices: devices.filter((d) => !d.personId), memberDevices: devices.filter((d) => d.personId) },
  }));
  writeFileSync(join(folder, "people.json"), JSON.stringify({
    people: devices.filter((d) => d.personId).map((d) => ({ id: d.personId, name: d.name, createdAt: 1, relayTokenHash: d.hash })),
    memberships: devices.filter((d) => d.personId).map((d) => ({ personId: d.personId, roomId, role: "collaborator", joinedAt: 1, invitedBy: "owner" })),
    invites: [{ id: "inv_example", secretHash: digest("example-invite-secret"), roomId, role: "collaborator", createdAt: Date.now(), expiresAt: Date.now() + 3600_000, invitedBy: "owner", status: "open" }], knocks: [],
  }));
  writeFileSync(join(folder, "bloks.json"), JSON.stringify([{
    id: roomId, name: "Draft room", memberIds: [], createdAt: 1,
    sharing: { since: 1, history: "all", collaboratorsInvite: false, activityDetail: true, tools: "conversation", collaboratorsApprove: true, spendCap: 0.01 },
  }]));
  // The stand-in talks to the real permission broker through the socket
  // the driver supplies. Nothing it asks to run is actually executed.
  writeFileSync(cli, `#!${process.execPath}
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const send = (v) => console.log(JSON.stringify(v));
let input = "", began = false;
const finish = () => {
  send({ type: "assistant", message: { content: [{ type: "text", text: "Example complete" }] } });
  send({ type: "result", subtype: "success", is_error: false, result: "Example complete", session_id: "example-session-" + process.pid, total_cost_usd: 0.02 });
  setTimeout(() => process.exit(0), 20);
};
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let at; (at = input.indexOf("\\n")) >= 0;) {
    const line = input.slice(0, at); input = input.slice(at + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (began || frame.type !== "user") continue;
    began = true;
    const text = String(frame.message?.content ?? "");
    writeFileSync(${JSON.stringify(join(home, "turn-token.part"))}, process.env.BLOKS_TOKEN, { mode: 0o600 });
    renameSync(${JSON.stringify(join(home, "turn-token.part"))}, ${JSON.stringify(join(home, "turn-token"))});
    send({ type: "system", subtype: "init", session_id: "example-session", model: "claude-sonnet-5" });
    if (text.includes("BROKER")) {
      const config = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
      const socket = connect(config.mcpServers.bloks.args[1]);
      const question = text.includes("QUESTION");
      socket.on("error", () => process.exit(1));
      socket.on("connect", () => socket.write(JSON.stringify({
        t: "ask", id: "example-ask-" + process.pid, kind: question ? "question" : "permission",
        tool: question ? "ask_user" : "Bash", input: question ? { question: "Which draft should I publish?", choices: ["Blue", "Green"] } : { command: "echo publish the example draft" },
      }) + "\\n"));
      socket.on("data", () => { socket.end(); finish(); });
    } else if (text.includes("HOLD FOR AGENT POST")) {
      // Stay alive so the test can speak with this turn's credential.
    } else finish();
  }
});
`, { mode: 0o755 });
  const start = async () => {
    const harness = await startHarness({ HOME: home, USERPROFILE: home, BLOKS_LOOPBACK_ONLY: "1", BLOKS_STATIC_DIR: staticDir });
    if (staticDir) {
      // A served UI uses its own origin; the default harness speaks as
      // the dev UI, which a production-mode server correctly refuses.
      harness.fetch = (path, init) => harness.fetchAs(harness.url, path, init);
      harness.json = async (path, init) => (await harness.fetch(path, init)).json();
    }
    return harness;
  };
  let h = await start();
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  type Push = { frames: Array<{ device: string; frame: any }>; wake: any; previews: Record<string, any> };
  const pushes: Push[] = [];
  const results = new Map<string, any>();
  let send: ((frame: unknown) => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/space/agent/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "example-space" });
      return;
    }
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      if (req.url === "/space/agent/events") {
        const frames = (data.frames ?? []).map((encoded: string) => {
          const envelope = peek(encoded)!;
          const device = devices.find((d) => d.id === envelope.d)!;
          return { device: device.id, frame: open(deviceKey(device.hash, "mac-to-phone"), envelope) };
        });
        const previews = Object.fromEntries(Object.entries(data.wake?.sealed ?? {}).map(([id, encoded]) => {
          const device = devices.find((d) => d.id === id)!;
          return [id, open(deviceKey(device.hash, "mac-to-phone"), peek(encoded as string)!)];
        }));
        pushes.push({ frames, wake: data.wake, previews });
      }
      if (req.url === "/space/agent/result") results.set(data.id, data);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ plan: "team" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const relay = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, agentToken: "example-agent-token", clientToken: devices[0].token, enabled: true };
  const configure = async () => {
    assert.equal((await h.fetch("/api/relay", { method: "PUT", body: JSON.stringify(relay) })).status, 200);
    assert.ok(await waitFor(() => send ? true : null), "the isolated relay was not connected");
  };
  await configure();
  const ownerFrames = () => pushes.flatMap((p) => p.frames).filter((f) => f.device === devices[0].id).map((f) => f.frame);
  const captured = (id: string, kind = "message") => pushes.find((p) => p.frames.some((f) => f.device === devices[0].id && f.frame.kind === kind && f.frame.message?.id === id));
  const hire = async (name = "Editor") => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ approvals: "edits", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) })).status, 200);
    return bot;
  };
  return {
    get h() { return h; }, home, roomId, devices, pushes, ownerFrames, captured, hire,
    member: (n: number, path: string, body?: unknown) => h.fetchRemote(path, { method: body === undefined ? "GET" : "POST", token: devices[n].token, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    async inviteClaim(inviteId: string, secretHash: string, body: unknown) {
      const id = "claim-example";
      send!({ kind: "ask", id, payload: seal(inviteKey(secretHash, "phone-to-mac"), inviteId, { method: "POST", path: "/api/member/claim", body, ts: Date.now(), nonce: "example-claim-nonce" }) });
      assert.ok(await waitFor(() => results.get(id) ?? null), "the invite claim did not return through the relay");
      return results.get(id);
    },
    async restart() { await h.crash(); send = undefined; h = await start(); await configure(); },
  };
}
