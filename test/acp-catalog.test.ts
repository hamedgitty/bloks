import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

import { instanceConfigs } from "../server/config.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { onPath, widenPath } from "../server/path.ts";
import { CLI_PROVIDERS } from "../server/providers.ts";
import { startHarness } from "./helpers/server.ts";

test("Pi is a catalogued ACP engine", () => {
    const spec = ACP_SPECS.find((s) => s.kind === "pi");
    assert.ok(spec, "kind pi belongs in ACP_SPECS");
    assert.equal(spec?.command, "pi-acp");
    assert.deepEqual(spec?.args, []);
    assert.equal(spec?.probePath, true, "pi-acp --version starts a session");
    assert.equal(spec?.probeModels, true, "pi's catalog follows its own settings, so it is probed");
    assert.ok(CLI_PROVIDERS.some((p) => p.kind === "pi"), "kind pi belongs in CLI_PROVIDERS");
    assert.ok(
        BUILT_IN_DRIVERS.some((d) => d.driverKind === "pi"),
        "kind pi is registered via acpDriver",
    );
});

test("the default fleet creates a Pi instance, even if config already has others", () => {
    assert.ok(Object.values(instanceConfigs({})).some((e) => e.driver === "pi"));
    const saved = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    assert.ok(
        Object.values(saved).some((e) => e.driver === "pi"),
        "a saved instances map written before Pi existed must still probe it",
    );
});

test("widenPath puts a well-known global bin on PATH when PATH is empty", () => {
    const home = mkdtempSync(join(tmpdir(), "bloks-pi-path-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi-acp"), "#!/bin/sh\n", { mode: 0o755 });

    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = "/nonexistent";
    try {
        widenPath();
        assert.ok(process.env.PATH?.split(delimiter).includes(bin));
        assert.equal(onPath("pi-acp"), true);
    } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevProfile;
        process.env.PATH = prevPath;
    }
});

async function withPiHome(script: string, fn: () => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), "bloks-pi-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi-acp"), script.endsWith("\n") ? script : script + "\n", { mode: 0o755 });

    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = dirname(process.execPath) + delimiter + "/nonexistent";
    widenPath();
    try {
        await fn();
    } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevProfile;
        process.env.PATH = prevPath;
    }
}

const PLACEHOLDER = { default: "auto", options: [{ id: "auto", label: "Auto" }] };

async function createPi() {
    const spec = ACP_SPECS.find((s) => s.kind === "pi")!;
    return acpDriver(spec).create({
        instanceId: "pi",
        displayName: "Pi",
        enabled: true,
        config: { cli: "pi-acp", fullAuto: false },
        environment: {},
    });
}

async function waitUntil(pred: () => boolean) {
    for (let i = 0; i < 50; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
}

test("Pi's catalog is probed with a throwaway session, before any turn", async () => {
    // Enough ACP to answer the two probe questions: initialize, then
    // session/new carrying the catalog pi would serve.
    const fake = [
        "#!/usr/bin/env node",
        'const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
        'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let msg; try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });',
        '  else if (msg.method === "session/new")',
        '    reply(msg.id, { sessionId: "probe", models: { availableModels: [',
        '      { modelId: "vendor/model-a", name: "Model A" },',
        '      { modelId: "vendor/model-b", name: "Model B" },',
        '    ], currentModelId: "vendor/model-a" } });',
        "});",
    ].join("\n");

    await withPiHome(fake, async () => {
        const inst = await createPi();
        await waitUntil(() => inst.models.options.some((m) => m.id === "vendor/model-a"));
        assert.deepEqual(inst.models, {
            default: "vendor/model-a",
            options: [
                { id: "vendor/model-a", label: "Model A" },
                { id: "vendor/model-b", label: "Model B" },
            ],
        });
        await inst.dispose();
    });
});

test("the catalog probe waits for initialize before opening a session", async () => {
    // A pipelined write would deliver session/new while initialize is still
    // pending; this agent answers that too-soon request with an empty catalog.
    const fake = [
        "#!/usr/bin/env node",
        'const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
        "let ready = false;",
        'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let msg; try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "initialize") {',
        "    setTimeout(() => { ready = true; reply(msg.id, { protocolVersion: 1, agentCapabilities: {} }); }, 50);",
        '  } else if (msg.method === "session/new") {',
        "    reply(msg.id, ready",
        '      ? { sessionId: "probe", models: { availableModels: [{ modelId: "vendor/late", name: "Late" }], currentModelId: "vendor/late" } }',
        '      : { sessionId: "too-soon", models: { availableModels: [] } });',
        "  }",
        "});",
    ].join("\n");

    await withPiHome(fake, async () => {
        const inst = await createPi();
        await waitUntil(() => inst.models.options.some((m) => m.id === "vendor/late"));
        assert.deepEqual(inst.models, {
            default: "vendor/late",
            options: [{ id: "vendor/late", label: "Late" }],
        });
        await inst.dispose();
    });
});

test("a failed catalog probe leaves the placeholder", async () => {
    await withPiHome("#!/bin/sh\nexit 1\n", async () => {
        const inst = await createPi();
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(inst.models, PLACEHOLDER);
        await inst.dispose();
    });
});

test("session/load history replay is not folded into the next turn", async () => {
    // pi-acp (and the ACP spec) replay the whole conversation as
    // session/update during session/load. Those frames must not land in
    // this turn's assistant message; Bloks already has the transcript.
    const fake = [
        "#!/usr/bin/env node",
        "const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
        "const reply = (id, result) => say({ jsonrpc: '2.0', id, result });",
        "const chunk = (text) => say({ jsonrpc: '2.0', method: 'session/update', params: {",
        "  sessionId: 's1',",
        "  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },",
        "} });",
        "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
        "  let msg; try { msg = JSON.parse(line); } catch { return; }",
        "  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });",
        "  else if (msg.method === 'session/new') reply(msg.id, { sessionId: 's1' });",
        "  else if (msg.method === 'session/load') { chunk('OLD'); reply(msg.id, { sessionId: 's1' }); }",
        "  else if (msg.method === 'session/prompt') { chunk('NEW'); reply(msg.id, { stopReason: 'end_turn' }); }",
        "});",
    ].join("\n");

    await withPiHome(fake, async () => {
        const inst = await createPi();
        const events: { type: string; delta?: string; text?: string; itemType?: string }[] = [];
        inst.adapter.onEvent((e) => events.push(e as (typeof events)[number]));
        await inst.adapter.sendTurn({ threadId: "t1", text: "again", resumeCursor: "s1" });
        await waitUntil(() => events.some((e) => e.type === "turn.completed"));
        const deltas = events.filter((e) => e.type === "content.delta").map((e) => e.delta).join("");
        const completed = events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text");
        assert.equal(deltas, "NEW", "replayed history must not stream as this turn");
        assert.equal(completed?.text, "NEW");
        await inst.dispose();
    });
});

test("Pi's snapshot is available when pi-acp is installed off PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "bloks-pi-snap-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi-acp"), "#!/bin/sh\n", { mode: 0o755 });

    const spec = ACP_SPECS.find((s) => s.kind === "pi")!;
    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = "/nonexistent";
    widenPath();
    try {
        const inst = await acpDriver(spec).create({
            instanceId: "pi",
            displayName: "Pi",
            enabled: true,
            config: { cli: "pi-acp", fullAuto: false },
            environment: {},
        });
        const snap = await inst.snapshot();
        assert.equal(snap.state, "available");
        assert.equal(snap.authenticated, false, "installed must not depend on auth");
        await inst.dispose();
    } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevProfile;
        process.env.PATH = prevPath;
    }
});

test("the harness reports Pi available when pi-acp lives in a global bin", async () => {
    const h = await startHarness();
    try {
        const bin = join(h.home, ".local", "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "pi-acp"), "#!/bin/sh\n", { mode: 0o755 });

        const { instances } = await h.json("/api/instances");
        const pi = instances.find((i: { driverKind: string }) => i.driverKind === "pi");
        assert.ok(pi, "default fleet must create a pi instance");
        assert.equal(pi.snapshot.state, "available");
        assert.equal(pi.snapshot.authenticated, false);

        const { providers } = await h.json("/api/providers");
        const row = providers.find((p: { kind: string }) => p.kind === "pi");
        assert.equal(row?.connected, true);
    } finally {
        await h.stop();
    }
});
