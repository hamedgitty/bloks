// A sandbox on this machine: the box's little sibling.
//
// The cloud box gives an agent a whole desktop somewhere else; this gives
// it a Linux container right here, for people who want isolation without
// a subscription or a network round trip. Shell and files only in this
// first cut: no display, no browser windows, which keeps the runtime
// requirements to "any container engine" instead of "a VM with a GUI".
//
// Two runtimes are looked for, in order:
//
//   container   Apple's own CLI, which runs each container in its own
//               lightweight VM. The best fit on macOS 26.
//   docker      everywhere else, and on Macs that already have it.
//
// Neither ships with the OS, so the whole feature reports itself
// unavailable with an install hint until one appears; that is the same
// honest posture the cloud box takes about its token.
//
// Persistence matters here the way it does for the box: an agent's
// sandbox keeps its files across turns and across restarts, via a named
// volume mounted at /work. Destroying the sandbox destroys the volume,
// and says so.
import { execFile } from "node:child_process";

/** What the agent's container is built from. Small, current, and enough
 * of a userland to be useful; anything heavier is an apt-get away. */
const IMAGE = "ubuntu:24.04";

/** Overridable so the test suite can point at a stub runtime, and so
 * someone with an exotic setup can force a binary. */
const RUNTIME_OVERRIDE = process.env.BLOKS_SANDBOX_RUNTIME;

const RUNTIMES = ["container", "docker"] as const;
export type SandboxRuntime = (typeof RUNTIMES)[number] | string;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(binary: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const code = (error as any)?.code;
      resolve({
        ok: !error,
        code: typeof code === "number" ? code : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

let cachedRuntime: string | null | undefined;

/** The first container engine that answers, or null. Cached: binaries do
 * not appear mid-process often enough to justify probing every call, and
 * a config reload restarts the server anyway. */
export async function sandboxRuntime(): Promise<string | null> {
  if (cachedRuntime !== undefined) return cachedRuntime;
  if (RUNTIME_OVERRIDE) {
    cachedRuntime = RUNTIME_OVERRIDE;
    return cachedRuntime;
  }
  for (const candidate of RUNTIMES) {
    const probe = await run(candidate, ["--version"], 5_000);
    if (probe.ok) {
      cachedRuntime = candidate;
      return cachedRuntime;
    }
  }
  cachedRuntime = null;
  return null;
}

/** Deterministic names, so the same agent always finds the same sandbox
 * and the same files. Suffix hash for the truncated-id collision case,
 * exactly as the box does it. */
async function nameFor(botId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botId));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  const stem = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  return { container: `bloks-sbx-${stem}-${hash}`, volume: `bloks-work-${stem}-${hash}` };
}

export interface SandboxStatus {
  available: boolean;
  runtime: string | null;
  state: "none" | "running" | "stopped";
  name?: string;
}

/** One line of `runtime ps` truth: does the container exist, is it up. */
export async function sandboxStatus(botId: string): Promise<SandboxStatus> {
  const runtime = await sandboxRuntime();
  if (!runtime) return { available: false, runtime: null, state: "none" };

  const { container } = await nameFor(botId);
  const all = await run(runtime, ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"], 15_000);
  const line = all.stdout.split("\n").find((row) => row.startsWith(container));
  if (!line) return { available: true, runtime, state: "none", name: container };

  const up = /\bUp\b|running/i.test(line);
  return { available: true, runtime, state: up ? "running" : "stopped", name: container };
}

/**
 * Make the agent's sandbox exist and run.
 *
 * Idempotent the way provisioning has to be: create if missing, start if
 * stopped, and land in the same place either way. The container idles on
 * a sleep loop because a container with no live process is a container
 * the runtime considers finished.
 */
export async function provisionSandbox(botId: string): Promise<SandboxStatus> {
  const runtime = await sandboxRuntime();
  if (!runtime) {
    throw new Error(
      "no container runtime found. Install Apple's container CLI (github.com/apple/container) or Docker, then try again",
    );
  }
  const { container, volume } = await nameFor(botId);
  const current = await sandboxStatus(botId);

  if (current.state === "none") {
    await run(runtime, ["volume", "create", volume], 30_000);
    const created = await run(
      runtime,
      [
        "run",
        "--detach",
        "--name", container,
        "--volume", `${volume}:/work`,
        "--workdir", "/work",
        IMAGE,
        "sleep", "infinity",
      ],
      // first run may pull the image, which is minutes, not seconds
      300_000,
    );
    if (!created.ok) {
      throw new Error(`the sandbox could not start: ${created.stderr.slice(0, 300) || "runtime error"}`);
    }
  } else if (current.state === "stopped") {
    const started = await run(runtime, ["start", container], 60_000);
    if (!started.ok) {
      throw new Error(`the sandbox would not wake: ${started.stderr.slice(0, 300) || "runtime error"}`);
    }
  }
  return sandboxStatus(botId);
}

/** Run one shell line inside the sandbox and hand back what it said. */
export async function execInSandbox(botId: string, command: string) {
  const runtime = await sandboxRuntime();
  if (!runtime) throw new Error("no container runtime found");
  const { container } = await nameFor(botId);

  const result = await run(
    runtime,
    ["exec", container, "sh", "-lc", command.slice(0, 4000)],
    120_000,
  );
  return {
    exitCode: result.code,
    stdout: result.stdout.slice(-5000),
    stderr: result.stderr.slice(-2000),
  };
}

/** Stop without destroying: the volume, and therefore the files, stay. */
export async function stopSandbox(botId: string) {
  const runtime = await sandboxRuntime();
  if (!runtime) throw new Error("no container runtime found");
  const { container } = await nameFor(botId);
  await run(runtime, ["stop", container], 60_000);
  return sandboxStatus(botId);
}

/** Destroy everything, files included. The one irreversible call here,
 * so the route that exposes it should say what it costs. */
export async function destroySandbox(botId: string) {
  const runtime = await sandboxRuntime();
  if (!runtime) return;
  const { container, volume } = await nameFor(botId);
  await run(runtime, ["rm", "-f", container], 60_000);
  await run(runtime, ["volume", "rm", volume], 30_000);
}
