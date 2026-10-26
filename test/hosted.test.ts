// Hosted mode (server/hosted.ts): the workspace is the agents' computer,
// so the cloud box and the Local VM are neither offered nor accepted;
// what needs the person's Mac says so; health answers anything on this
// machine; and the virtual desktop is passed through this server under a
// ticket, its socket included, without a port of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { connect } from "node:net";

import {
  DesktopTickets,
  TICKET_IDLE_MS,
  computerChoices,
  computerRefusal,
  desktopRequest,
  hostedComputer,
  hostedRefusal,
  noComputerLine,
  ownScreenWorks,
  publicDoor,
  viewerUrl,
  vncTarget,
} from "../server/hosted.ts";
import { startHarness } from "./helpers/server.ts";

test("hosted offers this machine and off, and refuses a box or a VM", () => {
  assert.deepEqual(computerChoices(true).map((c) => c.id), ["local", "off"]);
  assert.deepEqual(computerChoices(false, "darwin").map((c) => c.id), ["cloud", "sandbox", "local", "off"]);
  assert.match(computerRefusal("cloud", true) ?? "", /agents' computer already/);
  assert.match(computerRefusal("sandbox", true) ?? "", /Local VM/);
  assert.equal(computerRefusal("local", true), null);
  assert.equal(computerRefusal(null, true), null);
  assert.equal(computerRefusal("cloud", false), null, "on a Mac nothing changes");
  assert.equal(computerRefusal("local", false), null);
  assert.ok(computerRefusal("moon", true), "and nonsense is refused on a hosted workspace");
});

// GitHub 377: on Windows "This computer" was offered, and Automatic fell
// back on it, but nothing there can work the PC's own screen (cua-driver
// ships for macOS only), so the agent quietly had no computer at all.
// GitHub 388: refusing it as well broke what 3.0.8 had saved there, and
// any save that carried it. It is not offered, and still accepted.
test("off a Mac this computer's own screen is not offered, is still accepted, and the Local VM still is", () => {
  for (const platform of ["win32", "linux"]) {
    assert.deepEqual(computerChoices(false, platform).map((c) => c.id), ["cloud", "sandbox", "off"], platform);
  }
  for (const value of ["local", "sandbox", "cloud", "off", null]) {
    assert.equal(computerRefusal(value, false), null, `${value} was refused off a hosted workspace`);
  }
  assert.equal(ownScreenWorks("darwin"), true);
  assert.equal(ownScreenWorks("win32"), false);
  assert.deepEqual(computerChoices(true, "linux").map((c) => c.id), ["local", "off"], "a hosted machine is still its own computer");
});

test("an agent with no computer is told so, and how the person gives it one", () => {
  const pc = noComputerLine("none", { hosted: false, platform: "win32" });
  assert.match(pc, /Bloks has not provided a screen to see or click on this turn/);
  assert.match(pc, /in your settings, under Computer/);
  assert.match(pc, /Local VM/);
  assert.match(pc, /Cloud box/);
  assert.match(pc, /Windows PC's screen needs Bloks running on a Mac/);
  assert.doesNotMatch(pc, /This computer \(/, "a PC is not offered its own screen");

  const mac = noComputerLine("none", { hosted: false, platform: "darwin" });
  assert.match(mac, /This computer \(their own Mac/);
  assert.match(mac, /Local VM/);
  assert.doesNotMatch(mac, /needs Bloks running on a Mac/);

  assert.match(noComputerLine("off", { hosted: false, platform: "win32" }), /switched off in your settings/);
  assert.match(noComputerLine("withheld", { hosted: false, platform: "darwin" }), /the owner did not start it/);
  assert.doesNotMatch(noComputerLine("withheld", { hosted: false }), /under Computer/, "someone else's turn is not told to change the owner's settings");
  assert.equal(noComputerLine("none", { hosted: true }), "", "a hosted machine is the computer");
  assert.match(noComputerLine("off", { hosted: true }), /switched off/);
  const vm = noComputerLine("vm", { hosted: false, platform: "win32", vm: "No container runtime found. Install Docker or Podman." });
  assert.match(vm, /set to use the Local VM, but it is not there this turn \(No container runtime found\. Install Docker or Podman\)/);
});

// GitHub 388: "You have no computer" read to an OpenCode agent as "you
// cannot run anything", and its hourly routine stopped running scripts.
// Computer is a screen; whatever line an agent gets, it is told its
// commands and files are untouched, and never that it has no computer.
test("no line about a missing screen says or implies the agent cannot run commands", () => {
  const lines = [
    ...(["off", "withheld", "vm", "none"] as const).flatMap((why) =>
      ["darwin", "win32", "linux"].map((platform) => noComputerLine(why, { hosted: false, platform, vm: "it is in use by Ada right now" })),
    ),
    noComputerLine("off", { hosted: true }),
    noComputerLine("withheld", { hosted: true }),
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, /no computer/i, line);
    assert.doesNotMatch(line, /cannot (run|act|execute)|can't (run|act|execute)|not act/i, line);
    assert.match(line, /commands and files are not affected/, line);
    assert.doesNotMatch(line, /[\u2013\u2014]/, "no dashes");
  }
});

test("a box or a VM chosen on a Mac becomes this machine once hosted, and off stays off", () => {
  assert.equal(hostedComputer("cloud"), "local");
  assert.equal(hostedComputer("sandbox"), "local");
  assert.equal(hostedComputer("local"), "local");
  assert.equal(hostedComputer("off"), "off");
  assert.equal(hostedComputer(null), null);
});

test("the API refuses what is not here, and nothing else", () => {
  assert.equal(hostedRefusal("GET", "/api/local-vm")?.status, 409);
  assert.equal(hostedRefusal("POST", "/api/local-vm/create")?.status, 409);
  assert.equal(hostedRefusal("GET", "/api/bots/abc/computer")?.status, 409);
  assert.equal(hostedRefusal("POST", "/api/bots/abc/computer/provision")?.status, 409);
  assert.equal(hostedRefusal("PATCH", "/api/box/settings")?.status, 409);
  assert.match(hostedRefusal("POST", "/api/meetings")?.error ?? "", /needs Bloks running on a Mac/);
  assert.equal(hostedRefusal("GET", "/api/meetings"), null, "past meetings stay readable");
  assert.equal(hostedRefusal("GET", "/api/bots"), null);
  assert.equal(hostedRefusal("POST", "/api/bots/abc/sandbox/exec"), null);
});

test("the desktop's address is a port or an http address on loopback, and nothing else", () => {
  assert.deepEqual(vncTarget("6080"), { host: "127.0.0.1", port: 6080, prefix: "/" });
  assert.deepEqual(vncTarget("127.0.0.1:6081"), { host: "127.0.0.1", port: 6081, prefix: "/" });
  assert.deepEqual(vncTarget("http://localhost:6082/novnc"), { host: "127.0.0.1", port: 6082, prefix: "/novnc/" });
  assert.deepEqual(vncTarget("http://127.0.0.1:6083/novnc/vnc.html"), { host: "127.0.0.1", port: 6083, prefix: "/novnc/" });
  assert.deepEqual(vncTarget("http://[::1]:6084/"), { host: "::1", port: 6084, prefix: "/" });
  for (const bad of ["", "0", "70000", "http://10.0.0.5:6080", "http://desktop.example:6080", "https://127.0.0.1:6080", "http://user:pw@127.0.0.1:6080", "file:///tmp/x"]) {
    assert.equal(vncTarget(bad), null, bad);
  }
});

test("the door a hosted machine names is an https origin, or loopback for a test, and nothing more", () => {
  assert.equal(publicDoor("https://machine-1.example.app"), "https://machine-1.example.app");
  assert.equal(publicDoor("https://machine-1.example.app/"), "https://machine-1.example.app");
  assert.equal(publicDoor("http://127.0.0.1:18790"), "http://127.0.0.1:18790");
  for (const bad of ["", undefined, "http://machine-1.example.app", "https://machine-1.example.app/desktop", "https://a:b@example.app", "https://example.app/?x=1", "not a url"]) {
    assert.equal(publicDoor(bad), null, String(bad));
  }
});

test("a ticket opens only its own viewer, and never climbs out of it", () => {
  const ticket = "a".repeat(48);
  assert.deepEqual(desktopRequest(`/hosted/desktop/${ticket}/vnc.html`), { ticket, rest: "vnc.html" });
  assert.deepEqual(desktopRequest(`/hosted/desktop/${ticket}/app/ui.js`), { ticket, rest: "app/ui.js" });
  assert.equal(desktopRequest(`/hosted/desktop/${ticket}/../secret`), null);
  assert.equal(desktopRequest(`/hosted/desktop/${ticket}/%2e%2e/secret`), null);
  assert.equal(desktopRequest("/hosted/desktop/short/vnc.html"), null);
  assert.equal(desktopRequest("/api/bots"), null);
  assert.match(viewerUrl(ticket), new RegExp(`^/hosted/desktop/${ticket}/vnc\\.html\\?autoconnect=true.*path=hosted%2Fdesktop%2F${ticket}%2Fwebsockify`));
});

test("a ticket lasts while it is used, and not after", () => {
  const tickets = new DesktopTickets();
  const id = tickets.mint(0);
  assert.equal(tickets.use(id, TICKET_IDLE_MS - 1), true);
  assert.equal(tickets.use(id, 2 * TICKET_IDLE_MS - 2), true, "each use renews it");
  assert.equal(tickets.use(id, 4 * TICKET_IDLE_MS), false);
  assert.equal(tickets.use("b".repeat(48), 0), false);
});

/** noVNC as a hosting image serves it: a page, and a socket that answers
 * whatever it is sent. It keeps what it was asked, to look for what must
 * not have been passed along. */
async function fakeViewer(t: { after: (fn: () => unknown) => void }) {
  const asked: IncomingMessage["headers"][] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.headers);
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "viewer=1" });
    res.end("<title>noVNC</title>");
  });
  server.on("upgrade", (req, socket) => {
    asked.push(req.headers);
    paths.push(req.url ?? "");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, asked, paths };
}

test("a hosted workspace says so, refuses what is not here, and shows its desktop through itself", async (t) => {
  const viewer = await fakeViewer(t);
  const h = await startHarness({ BLOKS_HOSTED: "1", BLOKS_HOSTED_VNC: `http://127.0.0.1:${viewer.port}/novnc/` });
  t.after(() => h.stop());

  // health, for the platform beside it: whatever Host its proxy chose and
  // whatever credential it happens to carry
  const health = await h.fetchRemote("/api/health", { host: "space-1.hosted.example", token: "stale" });
  assert.equal(health.status, 200, "pairing is off, and loopback is enough");
  assert.equal(health.body.hosted, true);

  const config = await h.json("/api/config");
  assert.equal(config.hosted.on, true);
  assert.equal(config.hosted.desktop, true);
  assert.deepEqual(config.hosted.computers.map((c: any) => c.id), ["local", "off"]);
  assert.equal(config.speech.system, false, "no Mac voices on a machine that is not the person's Mac");

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Hal" }) });
  const patch = (computer: unknown) => h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ computer }) });
  assert.equal((await patch("cloud")).status, 400);
  assert.equal((await patch("sandbox")).status, 400);
  assert.equal((await patch("local")).status, 200);
  assert.equal((await patch("off")).status, 200);

  const vm = await h.fetch("/api/local-vm");
  assert.equal(vm.status, 409);
  assert.equal((await vm.json()).code, "hosted");
  assert.equal((await h.fetch(`/api/bots/${bot.id}/computer`)).status, 409);
  const meeting = await h.fetch("/api/meetings", { method: "POST", body: JSON.stringify({ botId: bot.id }) });
  assert.equal(meeting.status, 409);
  assert.match((await meeting.json()).error, /needs Bloks running on a Mac/);

  // the desktop, through a ticket
  const { url } = await h.json("/api/hosted/desktop", { method: "POST", body: "{}" });
  assert.match(url, /^\/hosted\/desktop\/[0-9a-f]{48}\/vnc\.html\?/);
  const page = await fetch(`${h.url}${url}`, { headers: { authorization: "Bearer person-token", cookie: "session=person" } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<title>noVNC</title>");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("set-cookie"), null, "the viewer sets nothing on this origin");
  assert.match(viewer.paths[0], /^\/novnc\/vnc\.html\?autoconnect=true/);
  assert.equal(viewer.asked[0].authorization, undefined, "the person's credential is not passed along");
  assert.equal(viewer.asked[0].cookie, undefined);

  const forged = await fetch(`${h.url}/hosted/desktop/${"f".repeat(48)}/vnc.html`);
  assert.equal(forged.status, 404);

  // the socket, both ways
  const ticket = /desktop\/([0-9a-f]{48})\//.exec(url)![1];
  const port = Number(new URL(h.url).port);
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /hosted/desktop/${ticket}/websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer person-token\r\n\r\n`,
      );
    });
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (got.includes("\r\n\r\n") && !got.includes("echo:")) socket.write("ping");
      if (got.includes("echo:ping")) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`no echo: ${got}`)), 5_000);
  });
  assert.match(echoed, /^HTTP\/1\.1 101/);
  assert.equal(viewer.paths.at(-1), "/novnc/websockify");
  assert.equal(viewer.asked.at(-1)?.authorization, undefined);
  assert.equal(viewer.asked.at(-1)?.upgrade, "websocket");

  // a socket under no ticket is closed
  const closed = await new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET /hosted/desktop/${"0".repeat(48)}/websockify HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let got = "";
    socket.on("data", (c) => (got += c));
    socket.on("close", () => resolve(got));
  });
  assert.match(closed, /^HTTP\/1\.1 404/);
});

test("on a Mac nothing is hosted: no desktop ticket, and health says so", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  assert.equal((await h.json("/api/health")).hosted, false);
  assert.equal((await h.fetch("/api/hosted/desktop", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await h.fetch(`/hosted/desktop/${"a".repeat(48)}/vnc.html`)).status, 404);
  assert.equal((await h.json("/api/config")).hosted.on, false);
});

test("computer guidance limits its screen claim to Bloks", () => {
  for (const why of ["none", "off", "vm", "withheld"] as const) {
    const said = noComputerLine(why, { hosted: false, platform: "linux" });
    assert.match(said, /Bloks/);
    assert.doesNotMatch(said, /You have no screen/);
    assert.match(said, /commands and files are not affected/);
  }
});
