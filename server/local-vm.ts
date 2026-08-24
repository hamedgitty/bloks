// The Local VM: a whole Linux desktop on this machine, free of charge.
//
// The cloud box rents an agent a computer somewhere else; this builds one
// right here. A pinned Cua XFCE desktop image runs in a container, the
// Cua driver serves desktop automation over a socket inside it, and the
// harness bridges agents to that socket through the runtime's own exec.
// Bloks owns the boundary and nothing inside it: image preparation,
// container lifecycle, resource limits, the loopback-only viewer, and the
// one-bot-at-a-time lease. Clicking, typing and seeing are the driver's
// job, reached as an ordinary MCP server.
//
// Everything that matters is pinned. The base image is addressed by
// digest, the driver wheel by exact version and SHA-256, and the built
// image carries labels that say precisely what went into it. When any pin
// changes, the labels stop matching and setup resurfaces, which is how an
// upgrade happens on purpose instead of by accident.
//
// One deliberate oddity: a stopped VM is never started again. The desktop
// image leaves a stale X lock behind on stop, so resume produces a black
// screen; the honest lifecycle is create, use, remove, recreate. Cheap,
// because the durable workspace is a bind mount that survives all of it.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "./config.ts";

export const DRIVER_VERSION = "0.20.0";
// the official multi-arch Cua XFCE manifest, addressed by digest so a
// re-tag upstream can never silently change what runs here
const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `docker.io/trycua/xfce-cua@${BASE_IMAGE_DIGEST}`;
const IMAGE_LAYER = "1";
export const IMAGE = `bloks/cua-vm:driver-${DRIVER_VERSION}-v${IMAGE_LAYER}`;
export const CONTAINER = "bloks-vm";
const LABEL_MANAGED = "dev.bloks.vm";
const LABEL_DRIVER = "dev.bloks.vm-driver";
const LABEL_BASE = "dev.bloks.vm-base";
const LABEL_LAYER = "dev.bloks.vm-layer";
export const VM_HOME = join(DATA_DIR, "vm-home");
const GUEST_HOME = "/home/cua/workspace";
const SOCKET = "/run/user/1000/bloks-cua.sock";
const DRIVER_BIN = "/usr/local/libexec/bloks/cua-driver";
const VIEWER_HOST_PORT = 6080;
const VIEWER_GUEST_PORT = 6901;

// exact-version driver wheels, one per architecture, checksum-verified
// inside the build so a tampered download fails loudly
const WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

/** Overridable for tests, exactly like the sandbox runtime is. */
const RUNTIME_OVERRIDE = process.env.BLOKS_VM_RUNTIME;

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function sh(binary: string, args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      // screenshots come back through stdout as base64; give them room
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as any)?.code;
        resolve({
          ok: !error,
          code: typeof code === "number" ? code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

/**
 * The image recipe, generated rather than shipped: a file on disk can
 * drift from the constants above, a template literal cannot.
 *
 * Three layers on the pinned base: the driver wheel (arch-matched and
 * checksum-checked, with a version assertion at build time), a workspace
 * script that keeps browser profiles in the durable mount so sign-ins
 * survive recreation, and a supervisor entry that waits for X and then
 * serves the driver on its socket for the container's lifetime.
 */
export function vmDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) url='${WHEELS.x86_64.url}'; sum='${WHEELS.x86_64.sha256}'; whl='/tmp/cua_driver-${DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl' ;; \\
      aarch64|arm64) url='${WHEELS.aarch64.url}'; sum='${WHEELS.aarch64.sha256}'; whl='/tmp/cua_driver-${DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL "$url" -o "$whl"; \\
    echo "$sum  $whl" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$whl"; \\
    rm -f "$whl"; \\
    bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$bin"; \\
    install -D -m 0755 "$bin" ${DRIVER_BIN}; \\
    install -d -o cua -g cua -m 0700 ${GUEST_HOME}; \\
    test "$(${DRIVER_BIN} --version)" = "cua-driver ${DRIVER_VERSION}"
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'ws=${GUEST_HOME}' \\
      'profiles="$ws/.browser-profiles"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \\
      'chmod 0700 "$ws" "$profiles" "$profiles/google-chrome" "$profiles/chromium"' \\
      'keep() {' \\
      '  src="$HOME/.config/$1"; dst="$profiles/$1"' \\
      '  if [ -d "$src" ] && [ ! -L "$src" ] && [ -z "$(find "$dst" -mindepth 1 -print -quit)" ]; then cp -a "$src"/. "$dst"/; fi' \\
      '  rm -rf "$src"; ln -s "$dst" "$src"' \\
      '}' \\
      'keep google-chrome' \\
      'keep chromium' \\
      'find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \\) -delete' \\
      > /usr/local/bin/bloks-workspace.sh \\
    && chmod 0755 /usr/local/bin/bloks-workspace.sh
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/bloks-workspace.sh' \\
      'n=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  n=$((n + 1))' \\
      '  if [ "$n" -ge 45 ]; then echo "X display :1 not ready after 45s" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${DRIVER_BIN} serve --socket ${SOCKET} --permission-mode standard' \\
      > /usr/local/bin/bloks-driver.sh \\
    && chmod 0755 /usr/local/bin/bloks-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:bloks-cua-driver]' \\
      'command=/usr/local/bin/bloks-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${LABEL_MANAGED}="1" \\
      ${LABEL_DRIVER}="${DRIVER_VERSION}" \\
      ${LABEL_BASE}="${BASE_IMAGE_DIGEST}" \\
      ${LABEL_LAYER}="${IMAGE_LAYER}"
`;
}

/**
 * The exact run invocation, hardened: 4GB, 2 CPUs, every capability
 * dropped except the two the desktop supervisor needs to demote itself,
 * viewer published to loopback only, and exactly one mount, the durable
 * workspace. Apple's container CLI runs each container in its own
 * lightweight VM and does not take the swap/pids/hostname flags.
 */
export function vmRunArgs(runtime: string, viewerPassword: string): string[] {
  const common = [
    "run", "-d", "--name", CONTAINER,
    "--label", `${LABEL_MANAGED}=1`,
    "--label", `${LABEL_DRIVER}=${DRIVER_VERSION}`,
    "--label", `${LABEL_BASE}=${BASE_IMAGE_DIGEST}`,
    "--label", `${LABEL_LAYER}=${IMAGE_LAYER}`,
    "--memory", "4g", "--cpus", "2",
    "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
    "--shm-size", "512m",
  ];
  const docker = runtime === "container" ? [] : ["--memory-swap", "4g", "--pids-limit", "512", "--hostname", CONTAINER];
  const mount = `type=bind,source=${VM_HOME},target=${GUEST_HOME}${runtime === "podman" ? ",relabel=private,U=true" : ""}`;
  return [
    ...common,
    ...docker,
    "--mount", mount,
    "-e", `VNC_PW=${viewerPassword}`,
    "-p", `127.0.0.1:${VIEWER_HOST_PORT}:${VIEWER_GUEST_PORT}`,
    IMAGE,
  ];
}

// ── runtime discovery ─────────────────────────────────────────────────

const RUNTIMES = ["container", "docker", "podman"] as const;

let cachedRuntimes: string[] | undefined;
let runtimeProbeAt = 0;

/** Every engine present on this machine, Apple's first on a Mac. The
 * name "container" is too generic to trust anywhere else. A miss is
 * retried after a while: people install Docker mid-session. */
async function availableRuntimes(): Promise<string[]> {
  if (RUNTIME_OVERRIDE) return [RUNTIME_OVERRIDE];
  const stale = cachedRuntimes?.length === 0 && Date.now() - runtimeProbeAt > 30_000;
  if (cachedRuntimes !== undefined && !stale) return cachedRuntimes;
  runtimeProbeAt = Date.now();
  const candidates = RUNTIMES.filter((r) => r !== "container" || process.platform === "darwin");
  const found: string[] = [];
  await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await sh(candidate, ["--version"], 5_000);
      if (probe.ok) found.push(candidate);
    }),
  );
  cachedRuntimes = candidates.filter((c) => found.includes(c));
  return cachedRuntimes;
}

async function daemonUp(runtime: string): Promise<boolean> {
  const probe =
    runtime === "container"
      ? await sh(runtime, ["system", "status"], 10_000)
      : await sh(runtime, ["info", "--format", "{{.ServerVersion}}"], 10_000);
  return probe.ok;
}

// ── status ────────────────────────────────────────────────────────────

export interface VmStatus {
  runtime: string | null;
  daemonUp: boolean;
  /** The prepared image exists and its labels match the current pins. */
  imageReady: boolean;
  container: "running" | "stopped" | "missing";
  desktopReady: boolean;
  /** The one thing standing between here and ready, as a sentence. */
  problem: string | null;
  ready: boolean;
  viewerUrl: string | null;
  workspace: string;
  imageRef: string;
  baseRef: string;
  driverVersion: string;
}

/** Labels out of `image inspect` / container inspect, across the JSON
 * dialects: Docker's Config.Labels, Apple's configuration.labels for
 * containers, and Apple's variants[].config.config.Labels for images. */
function labelsOf(inspected: any): Record<string, string> {
  return (
    inspected?.Config?.Labels ??
    inspected?.config?.Labels ??
    inspected?.configuration?.labels ??
    inspected?.variants?.[0]?.config?.config?.Labels ??
    inspected?.Labels ??
    {}
  );
}

function labelsMatch(labels: Record<string, string>): boolean {
  return (
    labels[LABEL_MANAGED] === "1" &&
    labels[LABEL_DRIVER] === DRIVER_VERSION &&
    labels[LABEL_BASE] === BASE_IMAGE_DIGEST &&
    labels[LABEL_LAYER] === IMAGE_LAYER
  );
}

async function inspectJson(runtime: string, args: string[]): Promise<any | null> {
  const res = await sh(runtime, args, 15_000);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

/** The container's state, across both inspect dialects. */
function containerState(inspected: any): "running" | "stopped" {
  const state = inspected?.State?.Running ?? inspected?.status?.state;
  if (state === true || state === "running") return "running";
  return "stopped";
}

async function driverProbe(runtime: string): Promise<{ ready: boolean; error: string | null }> {
  const version = await sh(
    runtime,
    ["exec", "-u", "cua", CONTAINER, DRIVER_BIN, "--version"],
    10_000,
  );
  if (!version.ok || version.stdout.trim() !== `cua-driver ${DRIVER_VERSION}`) {
    // surface the driver's own last words instead of an endless wait
    const log = await sh(
      runtime,
      ["exec", CONTAINER, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
      8_000,
    );
    const line = log.stdout.replace(/\s+/g, " ").trim().slice(0, 300);
    return { ready: false, error: line || "the desktop is still starting" };
  }
  const health = await sh(
    runtime,
    ["exec", "-u", "cua", CONTAINER, DRIVER_BIN, "call", "health_report", "{}", "--socket", SOCKET],
    15_000,
  );
  if (!health.ok) return { ready: false, error: "the desktop driver is not answering yet" };
  return { ready: true, error: null };
}

async function viewerUrl(runtime: string): Promise<string | null> {
  const inspected = await inspectJson(runtime, ["inspect", CONTAINER]);
  if (!inspected) return null;
  const env: unknown =
    inspected?.Config?.Env ??
    inspected?.configuration?.initProcess?.environment ??
    inspected?.configuration?.environment;
  let password: string | null = null;
  if (Array.isArray(env)) {
    const hit = env.find((e) => typeof e === "string" && e.startsWith("VNC_PW="));
    password = hit ? String(hit).slice("VNC_PW=".length) : null;
  } else if (env && typeof env === "object") {
    password = (env as Record<string, string>).VNC_PW ?? null;
  }
  const base = `http://127.0.0.1:${VIEWER_HOST_PORT}/vnc.html`;
  // the password rides in the fragment, which never leaves the browser
  return password ? `${base}#autoconnect=true&resize=scale&password=${password}` : base;
}

/** One lifecycle operation at a time; status stays readable throughout. */
let lifecycleBusy = false;

export async function vmStatus(): Promise<VmStatus> {
  const base: VmStatus = {
    runtime: null,
    daemonUp: false,
    imageReady: false,
    container: "missing",
    desktopReady: false,
    problem: null,
    ready: false,
    viewerUrl: null,
    workspace: VM_HOME,
    imageRef: IMAGE,
    baseRef: BASE_IMAGE,
    driverVersion: DRIVER_VERSION,
  };

  const runtimes = await availableRuntimes();
  if (runtimes.length === 0) {
    base.problem =
      process.platform === "darwin"
        ? "No container runtime found. Install Apple's container CLI or Docker Desktop."
        : "No container runtime found. Install Docker or Podman.";
    return base;
  }

  for (const candidate of runtimes) {
    if (await daemonUp(candidate)) {
      base.runtime = candidate;
      base.daemonUp = true;
      break;
    }
  }
  if (!base.daemonUp) {
    base.runtime = runtimes[0];
    base.problem = `${base.runtime} is installed but not running. Start it first.`;
    return base;
  }

  const runtime = base.runtime!;
  const image = await inspectJson(runtime, ["image", "inspect", IMAGE]);
  base.imageReady = image !== null && labelsMatch(labelsOf(image));
  if (!base.imageReady) {
    base.problem = image
      ? "The desktop image is from an older Bloks. Prepare it again."
      : "The Cua desktop is not prepared yet.";
    return base;
  }

  const container = await inspectJson(runtime, ["inspect", CONTAINER]);
  if (!container) {
    base.problem = "The Local VM has not been created yet.";
    return base;
  }
  if (!labelsMatch(labelsOf(container))) {
    base.container = containerState(container);
    base.problem = "The Local VM was built from an older image. Recreate it.";
    return base;
  }
  base.container = containerState(container);
  if (base.container === "stopped") {
    // a stopped desktop cannot resume (stale X lock); recreate instead
    base.problem = "The Local VM is stopped and must be recreated.";
    return base;
  }

  const probe = await driverProbe(runtime);
  base.desktopReady = probe.ready;
  if (!probe.ready) {
    base.problem = probe.error;
    return base;
  }
  base.viewerUrl = await viewerUrl(runtime);
  base.ready = true;
  return base;
}

// ── lifecycle ─────────────────────────────────────────────────────────

async function requireRuntime(): Promise<string> {
  const runtimes = await availableRuntimes();
  for (const candidate of runtimes) {
    if (await daemonUp(candidate)) return candidate;
  }
  throw new Error("no running container runtime. Start Docker (or Apple's container) first");
}

function guardLifecycle() {
  if (lifecycleBusy) throw new Error("another Local VM operation is already running");
}

/** Pull the pinned base and build the Bloks layer on top. Minutes on the
 * first run; the button that triggers it should say so. */
export async function vmPrepare(): Promise<void> {
  guardLifecycle();
  lifecycleBusy = true;
  try {
    const runtime = await requireRuntime();
    // Apple's CLI nests pull under image; docker and podman take it bare
    const pullArgs = runtime === "container" ? ["image", "pull", BASE_IMAGE] : ["pull", BASE_IMAGE];
    const pulled = await sh(runtime, pullArgs, 600_000);
    if (!pulled.ok) {
      throw new Error(`the base desktop would not download: ${pulled.stderr.slice(0, 240)}`);
    }
    const context = await mkdtemp(join(tmpdir(), "bloks-vm-"));
    try {
      await writeFile(join(context, "Dockerfile"), vmDockerfile());
      const built = await sh(runtime, ["build", "-t", IMAGE, context], 600_000);
      if (!built.ok) {
        throw new Error(`the desktop image would not build: ${built.stderr.slice(-400)}`);
      }
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  } finally {
    lifecycleBusy = false;
  }
}

/** Create and start the VM. Refuses to double-create; remove first. */
export async function vmCreate(): Promise<void> {
  guardLifecycle();
  lifecycleBusy = true;
  try {
    const runtime = await requireRuntime();
    const existing = await inspectJson(runtime, ["inspect", CONTAINER]);
    if (existing) throw new Error("a Local VM already exists. Remove it before creating a new one");
    mkdirSync(VM_HOME, { recursive: true, mode: 0o700 });
    try {
      chmodSync(VM_HOME, 0o700);
    } catch {}
    const password = randomBytes(6).toString("base64url");
    const created = await sh(runtime, vmRunArgs(runtime, password), 120_000);
    if (!created.ok) {
      throw new Error(`the Local VM would not start: ${created.stderr.slice(0, 300)}`);
    }
  } finally {
    lifecycleBusy = false;
  }
}

export async function vmStop(): Promise<void> {
  guardLifecycle();
  lifecycleBusy = true;
  try {
    const runtime = await requireRuntime();
    await sh(runtime, ["stop", CONTAINER], 120_000);
  } finally {
    lifecycleBusy = false;
  }
}

/** Remove the container. The image and the durable workspace remain, so
 * the next create is fast and keeps every file. */
export async function vmRemove(): Promise<void> {
  guardLifecycle();
  lifecycleBusy = true;
  try {
    const runtime = await requireRuntime();
    const force = runtime === "container" ? ["rm", "--force", CONTAINER] : ["rm", "-f", CONTAINER];
    await sh(runtime, force, 120_000);
  } finally {
    lifecycleBusy = false;
  }
}

// ── what a turn gets ──────────────────────────────────────────────────

/** The MCP spawn contract that puts an agent inside the VM: a stdio
 * bridge child that execs `cua-driver mcp` in the container. The same
 * shape the host-Mac cua connection uses, so drivers need nothing new. */
export async function vmMcpContract(): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
} | null> {
  const runtimes = await availableRuntimes();
  for (const candidate of runtimes) {
    if (await daemonUp(candidate)) {
      // dev runs TypeScript straight; the packaged app ships compiled .js
      const asTs = join(dirname(fileURLToPath(import.meta.url)), "local-vm-mcp.ts");
      const bridge = existsSync(asTs) ? asTs : asTs.replace(/\.ts$/, ".js");
      return {
        command: process.execPath,
        args: [bridge, candidate, CONTAINER, SOCKET],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return null;
}

/** A fresh look at the desktop, as a data URL for the preview pane. */
export async function vmScreenshot(): Promise<string> {
  const runtime = await requireRuntime();
  const shot = await sh(
    runtime,
    [
      "exec", "-u", "cua",
      "-e", "HOME=/home/cua", "-e", "DISPLAY=:1",
      CONTAINER,
      DRIVER_BIN, "call", "get_desktop_state", "{}",
      "--socket", SOCKET,
      "--screenshot-out-file", "/tmp/bloks-preview.png",
    ],
    30_000,
  );
  if (!shot.ok) throw new Error("the desktop did not answer with a frame");
  const encoded = await sh(runtime, ["exec", CONTAINER, "base64", "-w0", "/tmp/bloks-preview.png"], 30_000);
  const data = encoded.stdout.trim();
  if (!encoded.ok || data.length < 100) throw new Error("the frame came back empty");
  return `data:image/png;base64,${data}`;
}

// ── the lease: one bot on the desktop at a time ───────────────────────

const LEASE_TTL_MS = 30 * 60_000;
let lease: { threadId: string; botId: string; expiresAt: number } | null = null;
/** Injected by the harness so a lease dies with the turn that held it. */
let leaseStillHeld: (threadId: string) => boolean = () => true;

export function configureVmLease(isThreadBusy: (threadId: string) => boolean) {
  leaseStillHeld = isThreadBusy;
}

export function currentVmLease(): { threadId: string; botId: string } | null {
  if (!lease) return null;
  if (!leaseStillHeld(lease.threadId)) {
    lease = null;
    return null;
  }
  // still busy: a long turn renews itself rather than losing the desk
  if (lease.expiresAt <= Date.now()) lease.expiresAt = Date.now() + LEASE_TTL_MS;
  return lease;
}

/** Claim the desktop for one thread. Synchronous on purpose: the caller
 * must be able to win or lose the race before its first await. */
export function claimVm(threadId: string, botId: string): boolean {
  // never hand out the desk while it is being created or removed
  if (lifecycleBusy) return false;
  const holder = currentVmLease();
  if (holder && holder.threadId !== threadId) return false;
  lease = { threadId, botId, expiresAt: Date.now() + LEASE_TTL_MS };
  return true;
}

export function touchVmLease(threadId: string) {
  if (lease?.threadId === threadId) lease.expiresAt = Date.now() + LEASE_TTL_MS;
}

export function releaseVm(threadId: string) {
  if (lease?.threadId === threadId) lease = null;
}

// ── idle recycling ────────────────────────────────────────────────────

const IDLE_MS = 8 * 60 * 60_000;
let idleTimer: NodeJS.Timeout | null = null;

/** Eight quiet hours and the container is removed (never merely stopped;
 * see the header). The image and workspace stay, so nothing is lost but
 * the electricity. */
export function touchVmIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void (async () => {
      // a VM mid-use re-arms rather than racing the user
      if (lifecycleBusy || currentVmLease()) {
        touchVmIdle();
        return;
      }
      try {
        const status = await vmStatus();
        // the status look takes seconds; a turn may have claimed since
        if (currentVmLease()) {
          touchVmIdle();
          return;
        }
        if (status.container === "running") await vmRemove();
      } catch {
        touchVmIdle();
      }
    })();
  }, IDLE_MS);
  idleTimer.unref?.();
}
