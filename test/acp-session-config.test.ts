import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";
import { widenPath } from "../server/path.ts";

// How a turn chooses the model and the approval mode. pi-acp 0.0.34
// describes its models as a "model" config option and answers
// session/set_model with -32601; Bloks used to send set_model anyway and
// drop the error, so every turn ran on pi's default model. Its modes are
// thinking levels, so a blind set_mode "yolo" was not full access either.

const SELECT = {
    type: "select",
    id: "model",
    category: "model",
    name: "Model",
    currentValue: "vendor/model-a",
    options: [
        { value: "vendor/model-a", name: "Model A" },
        { value: "vendor/model-b", name: "Model B" },
    ],
};
const MODELS = {
    currentModelId: "vendor/model-a",
    availableModels: [
        { modelId: "vendor/model-a", name: "Model A" },
        { modelId: "vendor/model-b", name: "Model B" },
    ],
};
const THINKING_MODES = { currentModeId: "medium", availableModes: [{ id: "off" }, { id: "medium" }] };
const GEMINI_MODES = { currentModeId: "default", availableModes: [{ id: "default" }, { id: "yolo" }] };

interface Agent {
    /** What session/new answers, besides the sessionId. */
    session: Record<string, unknown>;
    /** Methods answered with a JSON-RPC error instead of {}. */
    fail?: string[];
}

/** A fake agent on PATH as pi-acp that logs every request it receives. */
async function withAgent(agent: Agent, fn: (received: () => any[]) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), "bloks-acp-config-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(home, "received.ndjson");
    const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const log = ${JSON.stringify(log)};`,
        `const session = ${JSON.stringify(agent.session)};`,
        `const fail = ${JSON.stringify(agent.fail ?? [])};`,
        "const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
        "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
        "  let msg; try { msg = JSON.parse(line); } catch { return; }",
        "  if (msg.id === undefined || !msg.method) return;",
        "  fs.appendFileSync(log, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');",
        "  const reply = (result) => say({ jsonrpc: '2.0', id: msg.id, result });",
        "  if (fail.includes(msg.method)) say({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });",
        "  else if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });",
        "  else if (msg.method === 'session/new') reply({ sessionId: 's1', ...session });",
        "  else if (msg.method === 'session/prompt') {",
        "    say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1',",
        "      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ANSWER' } } } });",
        "    reply({ stopReason: 'end_turn' });",
        "  } else reply({});",
        "});",
    ].join("\n");
    writeFileSync(join(bin, "pi-acp"), script + "\n", { mode: 0o755 });

    const prev = { HOME: process.env.HOME, PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = dirname(process.execPath) + delimiter + "/nonexistent";
    widenPath();
    try {
        await fn(() =>
            existsSync(log)
                ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
                : [],
        );
    } finally {
        process.env.HOME = prev.HOME;
        process.env.USERPROFILE = prev.USERPROFILE;
        process.env.PATH = prev.PATH;
    }
}

async function runTurn(opts: { model?: string; fullAuto?: boolean }) {
    const spec = ACP_SPECS.find((s) => s.kind === "pi")!;
    const inst = await acpDriver(spec).create({
        instanceId: "pi",
        displayName: "Pi",
        enabled: true,
        config: { cli: "pi-acp", fullAuto: opts.fullAuto === true },
        environment: {},
    });
    await inst.catalogReady;
    const events: any[] = [];
    inst.adapter.onEvent((e) => events.push(e));
    await inst.adapter.sendTurn({ threadId: "t1", text: "hello", model: opts.model });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "turn.completed"); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    await inst.dispose();
    return { events, models: inst.models };
}

const methods = (received: any[]) => received.map((m) => m.method);

test("the model is chosen through the model config option when the agent has one", async () => {
    await withAgent({ session: { configOptions: [SELECT], models: MODELS, modes: THINKING_MODES } }, async (received) => {
        const { events, models } = await runTurn({ model: "vendor/model-b" });
        const set = received().find((m) => m.method === "session/set_config_option");
        assert.deepEqual(set?.params, { sessionId: "s1", configId: "model", value: "vendor/model-b" });
        assert.ok(!methods(received()).includes("session/set_model"));
        assert.deepEqual(models.options.map((o) => o.id), ["vendor/model-a", "vendor/model-b"]);
        assert.equal(events.find((e) => e.type === "turn.completed")?.ok, true);
    });
});

test("agents without a model config option still get session/set_model", async () => {
    await withAgent({ session: { models: MODELS } }, async (received) => {
        await runTurn({ model: "vendor/model-b" });
        const set = received().find((m) => m.method === "session/set_model");
        assert.deepEqual(set?.params, { sessionId: "s1", modelId: "vendor/model-b" });
        assert.ok(!methods(received()).includes("session/set_config_option"));
    });
});

test("the model the agent already has is not set again", async () => {
    await withAgent({ session: { configOptions: [SELECT], models: MODELS } }, async (received) => {
        await runTurn({ model: "vendor/model-a" });
        assert.ok(!methods(received()).some((m) => m === "session/set_config_option" || m === "session/set_model"));
        assert.ok(methods(received()).includes("session/prompt"));
    });
});

test("a model switch the agent refuses stops the turn and says so", async () => {
    // Running the prompt anyway would answer on a model nobody picked.
    await withAgent({ session: { models: MODELS }, fail: ["session/set_model"] }, async (received) => {
        const { events } = await runTurn({ model: "vendor/model-b" });
        assert.ok(!methods(received()).includes("session/prompt"), "nothing is sent on the wrong model");
        const error = events.find((e) => e.type === "runtime.error");
        assert.match(error?.message ?? "", /could not switch to vendor\/model-b/);
        assert.equal(events.find((e) => e.type === "turn.completed")?.ok, false);
    });
});

test("full access asks for yolo only where the agent offers it", async () => {
    // pi-acp's modes are thinking levels; "yolo" there is not full access.
    await withAgent({ session: { models: MODELS, modes: THINKING_MODES } }, async (received) => {
        await runTurn({ fullAuto: true });
        assert.ok(!methods(received()).includes("session/set_mode"));
        assert.ok(methods(received()).includes("session/prompt"));
    });
    await withAgent({ session: { models: MODELS, modes: GEMINI_MODES } }, async (received) => {
        await runTurn({ fullAuto: true });
        const set = received().find((m) => m.method === "session/set_mode");
        assert.deepEqual(set?.params, { sessionId: "s1", modeId: "yolo" });
    });
});

test("a refused yolo is reported and the turn still runs", async () => {
    await withAgent({ session: { models: MODELS, modes: GEMINI_MODES }, fail: ["session/set_mode"] }, async (received) => {
        const { events } = await runTurn({ fullAuto: true });
        assert.match(events.find((e) => e.type === "runtime.error")?.message ?? "", /did not accept full access/);
        assert.ok(methods(received()).includes("session/prompt"));
        assert.equal(events.find((e) => e.type === "turn.completed")?.ok, true);
    });
});
