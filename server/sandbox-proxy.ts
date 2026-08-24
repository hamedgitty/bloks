// The agent's hands inside its local sandbox.
//
// Same job as computer-proxy, smaller world: an MCP stdio server the
// agent CLI spawns, offering the container's shell and nothing else.
// There is no display in the sandbox, so there is nothing to screenshot
// and no browser to point anywhere; a tool list that pretended otherwise
// would earn refusals from the runtime and confusion from the model.
//
// Commands run through the container runtime's own exec, as the harness
// does; this process holds a bot id and a runtime name, never a
// credential.
//
// stdout carries the protocol. Nothing may ever be printed to it.
import { execFile } from "node:child_process";

import { readJsonLines } from "./ndjson.ts";

const runtime = process.env.BLOKS_SBX_RUNTIME ?? "";
const container = process.env.BLOKS_SBX_NAME ?? "";

const emit = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
const say = (id: unknown, text: string, failed = false) =>
  emit({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(failed ? { isError: true } : {}) },
  });

const TOOLS = [
  {
    name: "sandbox_exec",
    description:
      "Run a shell command in your own Linux sandbox (Ubuntu, persistent /work directory). Returns stdout, stderr and the exit code. There is no display: this is a shell and a filesystem, not a desktop.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function exec(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      runtime,
      ["exec", container, "sh", "-lc", command.slice(0, 4000)],
      { timeout: 120_000, maxBuffer: 4_000_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as any).code ?? 1) : 0;
        const tail = stderr ? `\n[stderr]\n${String(stderr).slice(-1500)}` : "";
        resolve(`exit ${code}\n${String(stdout).slice(-5000)}${tail}`);
      },
    );
  });
}

async function dispatch(message: any) {
  switch (message.method) {
    case "initialize":
      return emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bloks-sandbox", version: "1" },
        },
      });

    case "tools/list":
      return emit({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });

    case "tools/call": {
      if (message.params?.name !== "sandbox_exec") {
        return say(message.id, `unknown tool ${message.params?.name}`, true);
      }
      const command = String(message.params?.arguments?.command ?? "");
      if (!command) return say(message.id, "nothing to run", true);
      return say(message.id, await exec(command));
    }
  }

  if (String(message.method ?? "").startsWith("notifications/")) return;
  if (message.id != null) {
    emit({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
  }
}

readJsonLines(process.stdin, (message) => void dispatch(message));
process.stdin.on("end", () => process.exit(0));
