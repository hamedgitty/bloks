// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
// GitHub 472: which engines are handed the agent's own browser and a
// computer, what the ACP agents are sent for them in session/new, what an
// agent is told when its engine cannot take one, and Chrome without a
// window on a server with no display. No real CLI anywhere: a stand-in
// ACP agent writes down what it was sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { PlaceRun, SendTurnInput } from "../server/contracts.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { screenServers } from "../server/drivers/screen-servers.ts";
import { hasDisplay, launchArgs } from "../server/cdp.ts";
import { ALL_SCREENS, barredComputer, CLOUD_ONLY, engineNoBrowserLine, engineNoComputerLine, NO_SCREENS, type EngineScreens } from "../server/screens.ts";
import { barredScreen } from "../src/lib/hosted.ts";
import { NATIVE_DIR } from "../server/config.ts";

// where the native copy of a conversation goes, made as the server makes it
mkdirSync(NATIVE_DIR, { recursive: true });

// built at runtime, so nothing token-shaped sits in the source
const BOX_TOKEN = ["box", "secret", "for", "the", "test", String(Date.now())].join("-");
const GATE = ["gate", "secret", String(Date.now())].join("-");

// ── which engine takes what ─────────────────────────────────────────────

/** What each built-in engine says it takes, as a turn's dispatch reads it. */
async function screensOf(kind: string, config: Record<string, unknown> = {}): Promise<EngineScreens | undefined> {
  // an ACP agent without its catalog probe, so nothing is started to ask
  const spec = ACP_SPECS.find((s) => s.kind === kind);
  const driver = spec ? acpDriver({ ...spec, probeModels: false }) : BUILT_IN_DRIVERS.find((d) => d.driverKind === kind);
  assert.ok(driver, `no ${kind} driver`);
  const instance = await driver.create({ instanceId: kind, displayName: kind, enabled: true, config, environment: {} } as any);
  try {
    return instance.adapter.capabilities.screens;
  } finally {
    await instance.dispose?.();
  }
}

describe("what each engine is handed", () => {
  test("Claude Code and the ACP agents that mount MCP servers take the browser and every computer", async () => {
    assert.deepEqual(await screensOf("claudeAgent", { cli: "/nonexistent/claude" }), ALL_SCREENS);
    for (const kind of ["opencode", "devin", "geminiCli", "cursor", "grokCli", "commandcode"]) {
      assert.deepEqual(await screensOf(kind, { cli: "/nonexistent/acp-stand-in" }), ALL_SCREENS, kind);
    }
  });

  test("Pi and Cline drop MCP servers they are sent, so they take none", async () => {
    for (const kind of ["pi", "cline"]) assert.deepEqual(await screensOf(kind, { cli: "/nonexistent/acp-stand-in" }), NO_SCREENS, kind);
  });

  test("an API model reaches the cloud box through its tool loop and nothing else; without tools, not even that", async () => {
    assert.deepEqual(await screensOf("custom", { baseUrl: "http://127.0.0.1:9", tools: true }), CLOUD_ONLY);
    assert.deepEqual(await screensOf("custom", { baseUrl: "http://127.0.0.1:9", tools: false }), NO_SCREENS);
  });

  test("the cloud engine works the box it runs on, and engines that say nothing take nothing", async () => {
    assert.deepEqual(await screensOf("boxAgent"), CLOUD_ONLY);
    assert.equal(await screensOf("codex", { cli: "/nonexistent/codex" }), undefined);
  });
});

// ── the screen a setting asks for, and whether the engine can have it ──

describe("a computer the engine cannot take", () => {
  const mac = { hosted: false, withheld: false, boxConfigured: false, ownScreen: true };

  test("is named, so the VM is not claimed and the box not woken for it", () => {
    assert.equal(barredComputer("sandbox", NO_SCREENS, mac), "vm");
    assert.equal(barredComputer("cloud", NO_SCREENS, mac), "cloud");
    assert.equal(barredComputer("local", NO_SCREENS, mac), "mac");
    assert.equal(barredComputer("sandbox", CLOUD_ONLY, mac), "vm");
    assert.equal(barredComputer("cloud", CLOUD_ONLY, mac), null);
    for (const wants of ["sandbox", "cloud", "local", null] as const) assert.equal(barredComputer(wants, ALL_SCREENS, mac), null);
  });

  test("Automatic is barred only when nothing it would pick can be taken", () => {
    assert.equal(barredComputer(null, NO_SCREENS, mac), "any");
    assert.equal(barredComputer(null, CLOUD_ONLY, mac), "any", "an API model on a Mac with no box");
    assert.equal(barredComputer(null, CLOUD_ONLY, { ...mac, boxConfigured: true }), null, "the box is still picked for it");
    assert.equal(barredComputer(null, NO_SCREENS, { ...mac, ownScreen: false }), null, "nothing to pick off a Mac without a box");
  });

  test("never for Off, a withheld computer, a hosted machine, or this computer off a Mac", () => {
    assert.equal(barredComputer("off", NO_SCREENS, mac), null);
    assert.equal(barredComputer("sandbox", NO_SCREENS, { ...mac, withheld: true }), null);
    assert.equal(barredComputer("local", NO_SCREENS, { ...mac, hosted: true }), null);
    assert.equal(barredComputer("local", NO_SCREENS, { ...mac, ownScreen: false }), null);
  });

  test("the settings card gives the server's answer for every setting, engine and machine", () => {
    for (const screens of [ALL_SCREENS, CLOUD_ONLY, NO_SCREENS]) {
      for (const wants of ["cloud", "sandbox", "local", "off", null] as const) {
        for (const hosted of [false, true]) {
          for (const boxConfigured of [false, true]) {
            for (const ownScreen of [false, true]) {
              assert.equal(
                barredScreen(wants, { browser: screens.browser, computers: [...screens.computers] }, { hosted, boxConfigured, ownScreen }),
                barredComputer(wants, screens, { hosted, withheld: false, boxConfigured, ownScreen }),
                JSON.stringify({ screens, wants, hosted, boxConfigured, ownScreen }),
              );
            }
          }
        }
      }
    }
    assert.equal(barredScreen("sandbox", undefined, { hosted: false, boxConfigured: false, ownScreen: true }), null, "an older server says nothing either way");
  });

  test("the agent is told plainly, with its shell untouched and where the person fixes it", () => {
    const vm = engineNoComputerLine("Pi", "vm");
    assert.match(vm, /set to use the Local VM, but Pi, the engine you run on, cannot be handed it/);
    assert.match(vm, /no screen to see or click and no computer tools/);
    assert.match(vm, /commands and files are not affected/);
    assert.match(vm, /under Engine/);
    assert.match(engineNoComputerLine("Pi", "any"), /left on Automatic/);
    assert.match(engineNoBrowserLine("Codex"), /Codex, the engine you run on, cannot be handed it, so you have no browser tools from Bloks/);
    for (const line of [vm, engineNoComputerLine("Pi", "any"), engineNoBrowserLine("Pi")]) assert.doesNotMatch(line, /[\u2013\u2014]/);
  });
});

// ── the servers themselves ──────────────────────────────────────────────

describe("the browser and computer servers", () => {
  test("the cloud box comes first, this Mac's daemon goes verbatim, and the browser sees the display there is", () => {
    const local = { command: "/opt/cua", args: ["mcp"], env: { A: "1" } };
    const both = screenServers({ computer: { boxId: "box-1", token: BOX_TOKEN }, localComputer: local, browser: { profileDir: "/p" } }, { DISPLAY: ":1", HOME: "/h" });
    assert.equal(both.computer!.env.BLOKS_BOX_ID, "box-1");
    assert.match(both.computer!.args[0], /computer-proxy\.(ts|js)$/);
    assert.equal(both.browser!.env.BLOKS_BROWSER_PROFILE, "/p");
    assert.equal(both.browser!.env.DISPLAY, ":1");
    assert.equal(both.browser!.env.HOME, undefined, "only the display travels, not the server's whole environment");
    assert.deepEqual(screenServers({ localComputer: local }).computer, local);
    assert.deepEqual(screenServers(undefined), {});
  });
});

// ── Chrome on a server with no display ──────────────────────────────────

describe("Chrome with no display", () => {
  test("Linux without X or Wayland runs it headless; a Mac, Windows or a desktop session opens a window", () => {
    assert.equal(hasDisplay("linux", {}), false);
    assert.equal(hasDisplay("linux", { DISPLAY: ":0" }), true);
    assert.equal(hasDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
    assert.equal(hasDisplay("freebsd", {}), false);
    assert.equal(hasDisplay("darwin", {}), true);
    assert.equal(hasDisplay("win32", {}), true);
    assert.ok(launchArgs("/p", false).includes("--headless=new"));
    assert.ok(!launchArgs("/p", true).some((arg) => arg.startsWith("--headless")));
    assert.equal(launchArgs("/p", false).at(-1), "about:blank");
    assert.ok(launchArgs("/p", false).includes("--user-data-dir=/p"));
  });
});

// ── what an ACP agent is sent ───────────────────────────────────────────

/** A stand-in ACP agent that writes down every request. `http` is what
 * its initialize says about HTTP MCP servers. */
function standIn(dir: string, http: boolean) {
  const log = join(dir, "received.jsonl");
  const cli = join(dir, "acp-stand-in.cjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: ${http} } } });
  else if (msg.method === "session/new") reply({ sessionId: "s1" });
  else if (msg.method === "session/prompt") {
    say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
    reply({ stopReason: "end_turn" });
  } else reply({});
});
`,
    { mode: 0o755 },
  );
  return {
    cli,
    received: (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/** A place that runs the stand-in here, as a container would there, and
 * writes down every server it is asked to carry through its gate. */
function placeHere(dir: string): { place: PlaceRun; carried: Array<{ name: string; server: any }> } {
  const carried: Array<{ name: string; server: any }> = [];
  return {
    carried,
    place: {
      label: "container scout",
      cwd: dir,
      spawn: (command, args, options) => spawn(command, args, { cwd: dir, env: { ...process.env, ...options?.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] }) as any,
      file(name, content) {
        const path = join(dir, name);
        writeFileSync(path, content);
        return path;
      },
      mcp(name, server) {
        carried.push({ name, server });
        return { url: `http://127.0.0.1:1/mcp/${name}`, headers: { Authorization: `Bearer ${GATE}` } };
      },
    },
  };
}

async function runAcp(kind: string, turn: Partial<SendTurnInput>, http = false) {
  const dir = mkdtempSync(join(tmpdir(), "bloks-472-acp-"));
  try {
    const agent = standIn(dir, http);
    const spec = ACP_SPECS.find((s) => s.kind === kind)!;
    // no throwaway catalog session: only the turn's own is under test
    const instance = await acpDriver({ ...spec, probeModels: false }).create({ instanceId: kind, displayName: spec.name, enabled: true, config: { cli: agent.cli, fullAuto: false }, environment: {} } as any);
    const events: any[] = [];
    instance.adapter.onEvent((e) => events.push(e));
    await instance.adapter.sendTurn({ threadId: "t1", text: "go", system: "You are a test agent.", cwd: dir, ...turn } as SendTurnInput);
    for (let i = 0; i < 100 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 50));
    await instance.dispose?.();
    const received = agent.received();
    const opened = received.find((m) => m.method === "session/new");
    const prompt = received.find((m) => m.method === "session/prompt");
    return { servers: (opened?.params?.mcpServers ?? []) as any[], told: String(prompt?.params?.prompt?.[0]?.text ?? ""), events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const INTEGRATIONS: SendTurnInput["integrations"] = {
  browser: { profileDir: "/profiles/agent-1" },
  localComputer: { command: "/opt/vm/cua", args: ["mcp"], env: { VM: "bloks" } },
};

describe("an ACP turn", () => {
  test("OpenCode is sent its browser and its Local VM as stdio servers in session/new", async () => {
    const { servers, told } = await runAcp("opencode", { integrations: INTEGRATIONS });
    const browser = servers.find((s) => s.name === "bloks_browser");
    assert.ok(browser, JSON.stringify(servers));
    assert.equal(browser.command, process.execPath);
    assert.deepEqual(browser.env.find((e: any) => e.name === "BLOKS_BROWSER_PROFILE"), { name: "BLOKS_BROWSER_PROFILE", value: "/profiles/agent-1" });
    assert.deepEqual(servers.find((s) => s.name === "bloks_computer"), { name: "bloks_computer", command: "/opt/vm/cua", args: ["mcp"], env: [{ name: "VM", value: "bloks" }] });
    assert.doesNotMatch(told, /correction/i);
  });

  test("the cloud box is its computer when it has one, and its key stays out of the native copy", async () => {
    const { servers } = await runAcp("devin", { threadId: "box-thread", integrations: { ...INTEGRATIONS, computer: { boxId: "box-7", token: BOX_TOKEN } } });
    const computer = servers.filter((s) => s.name === "bloks_computer");
    assert.equal(computer.length, 1);
    assert.match(computer[0].args[0], /computer-proxy\.(ts|js)$/);
    assert.ok(computer[0].env.some((e: any) => e.name === "BLOKS_BOX_ID" && e.value === "box-7"));
    // every file this process wrote under its own data folder, the
    // native copy of the conversation's frames among them
    const files: string[] = [];
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(process.env.BLOKS_DATA_DIR!);
    assert.ok(files.length > 0, "no native copy was written to look in");
    for (const file of files) assert.ok(!readFileSync(file, "utf8").includes(BOX_TOKEN), `the box token was written to ${file}`);
  });

  test("Pi is sent neither, whatever the turn carries", async () => {
    const { servers } = await runAcp("pi", { integrations: { ...INTEGRATIONS, computer: { boxId: "box-7", token: BOX_TOKEN } } });
    assert.deepEqual(servers.filter((s) => String(s.name).startsWith("bloks_")), []);
  });

  test("working elsewhere, an agent that takes HTTP servers reaches both through the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-472-place-"));
    try {
      const { place, carried } = placeHere(dir);
      const { servers, told } = await runAcp("opencode", { integrations: INTEGRATIONS, place }, true);
      assert.deepEqual(carried.map((c) => c.name).sort(), ["bloks_browser", "bloks_computer"]);
      assert.equal(carried.find((c) => c.name === "bloks_computer")!.server.command, "/opt/vm/cua", "the server runs here, as given");
      const browser = servers.find((s) => s.name === "bloks_browser");
      assert.equal(browser.type, "http");
      assert.match(browser.url, /\/mcp\/bloks_browser$/);
      assert.ok(!servers.some((s) => s.command), "nothing of this computer's is run there");
      assert.doesNotMatch(told, /correction/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("working elsewhere, an agent that does not take HTTP servers is told it has neither", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-472-place-"));
    try {
      const { place, carried } = placeHere(dir);
      const { servers, told } = await runAcp("opencode", { integrations: INTEGRATIONS, place }, false);
      assert.deepEqual(carried, []);
      assert.deepEqual(servers.filter((s) => String(s.name).startsWith("bloks_")), []);
      assert.match(told, /cannot reach your computer or your browser from there this turn/);
      assert.match(told, /no computer or browser tools/);
      assert.ok(told.endsWith("bloks.\n\ngo") || told.endsWith("plainly.\n\ngo"), `said with the system words, before the person's: ${told}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
