// An agent's own cloud computer.
//
// A box is a persistent Linux machine with a real X11 desktop, Chrome and
// a shell, one per agent. It sleeps when idle (billing stops, the disk
// survives) and wakes on demand, so an agent that has not worked in a week
// still finds its files where it left them.
//
// Facts about the substrate that shaped this file, each one learned the
// expensive way:
//
//   - The only execution primitive is POST /commands, which runs a shell
//     line synchronously. There is no long-lived connection to hold.
//   - Waking from archived takes seconds, not milliseconds, and creating
//     from scratch can take well over a minute.
//   - The machine's IP and its desktop stream token both rotate whenever
//     it sleeps and wakes. Neither may ever be cached.
//   - Binary over command stdout is not trustworthy: a complete-looking
//     PNG came back with a corrupted length. Screenshots therefore go to a
//     file on the box and come back through the files API.
import type { AppConfig } from "./config.ts";

const BOX_API = "https://ascii.dev/api/box/v1";

/** States in which a box will actually answer a command. */
const AWAKE = new Set(["idle", "ready", "running"]);

/** Where the bootstrap installs things on the box itself. */
const BOX_PREFIX = "/opt/bloks";
const SHOT_PATH = "/tmp/bloks-shot.png";

function request(cfg: AppConfig, path: string, init: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** The API reports failure two ways: an HTTP status, and an `ok:false` in
 * an otherwise-200 body. Both have to be checked. */
async function call(cfg: AppConfig, path: string, init: RequestInit = {}) {
  const response = await request(cfg, path, init);
  const body: any = await response.json().catch(() => null);
  return { ok: response.ok && body?.ok !== false, status: response.status, body };
}

export function boxConfigured(cfg: AppConfig) {
  return Boolean(cfg.box?.token);
}

// ── naming ─────────────────────────────────────────────────────────────

/** A stable name derived from the agent id, so the same agent always finds
 * the same machine without anything being written down. The hash suffix is
 * there because the truncated id alone collides. */
async function nameFor(botId: string, prefix: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botId));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  const stem = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${prefix}-${stem}-${hash}`;
}

/** Boxes provisioned before the rename still carry the old prefix. Looking
 * for both means an existing machine is adopted rather than orphaned and
 * silently replaced by a second one on the same bill. */
async function candidateNames(botId: string) {
  return [await nameFor(botId, "bloks"), await nameFor(botId, "ogb")];
}

export async function findBox(cfg: AppConfig, botId: string) {
  const names = await candidateNames(botId);
  const { body } = await call(cfg, "/boxes");
  const boxes: any[] = body?.boxes ?? [];
  return boxes.find((box) => names.includes(box.name) && box.state !== "error") ?? null;
}

// ── waking ─────────────────────────────────────────────────────────────

/**
 * Wait for a box to reach a state where it will answer.
 *
 * An archived box is nudged rather than merely waited on, because archiving
 * has to finish writing its snapshot before a resume will take, and the
 * first resume request during that window is simply dropped.
 */
async function waitUntilAwake(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const { body } = await call(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;

    if (AWAKE.has(state)) return body.box;
    if (state === "error") return null;
    if (state === "archived") {
      await call(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    }
    await sleep(2500);
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── desktop access ─────────────────────────────────────────────────────

/**
 * Mint a fresh URL for watching the desktop.
 *
 * VNC first because it is a plain WebSocket and survives networks that
 * block peer-to-peer; the WebRTC path is STUN-only and can hang on exactly
 * those networks. The VNC endpoint answers `provisioning: true` before it
 * answers a URL, so this polls rather than treating the first reply as
 * final. The `desktopUrl` stored on the box record is never usable on its
 * own: the token in it has already rotated.
 */
async function mintDesktopUrl(cfg: AppConfig, boxId: string, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const { body } = await call(cfg, `/boxes/${boxId}/desktop?vnc=1`, { method: "POST" });
    const url = body?.desktopUrl ?? body?.url;
    if (url) return url;
    if (!body?.provisioning) break;
    await sleep(3000);
  }

  const { body } = await call(cfg, `/boxes/${boxId}/desktop`, { method: "POST" });
  return body?.desktopUrl ?? body?.url ?? null;
}

// ── running commands ───────────────────────────────────────────────────

export async function runCommand(
  cfg: AppConfig,
  boxId: string,
  command: string,
  { timeoutMs = 120_000 } = {},
) {
  const response = await request(cfg, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await response.json().catch(() => null);

  return {
    ok: response.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

// ── the bootstrap ──────────────────────────────────────────────────────

/**
 * Everything the box needs, written so that running it twice is harmless.
 *
 * Layered deliberately. The X11 tools are small, fast and enough on their
 * own for every computer action, so they install in the foreground. CUA is
 * better but its first install takes minutes, so it goes to the background
 * behind a marker file and the box stays usable in the meantime. Once it
 * is there, the server runs on loopback only: commands reach it through
 * the box's own command endpoint, so nothing is ever exposed.
 */
function bootstrapScript(botName: string) {
  const installCua = [
    "sudo apt-get update -qq || true",
    "sudo apt-get install -y -qq gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true",
    "curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true",
    'export PATH="$HOME/.local/bin:$PATH"',
    `sudo mkdir -p ${BOX_PREFIX} && sudo chown "$(whoami)" ${BOX_PREFIX}`,
    `uv venv ${BOX_PREFIX}/venv --python 3.13 >/dev/null 2>&1 || uv venv ${BOX_PREFIX}/venv >/dev/null 2>&1 || true`,
    `[ -x ${BOX_PREFIX}/venv/bin/python ] && uv pip install --python ${BOX_PREFIX}/venv/bin/python cua-computer-server >/dev/null 2>&1 || true`,
    `[ -x ${BOX_PREFIX}/venv/bin/python ] && ${BOX_PREFIX}/venv/bin/python -c 'import computer_server' 2>/dev/null && touch ${BOX_PREFIX}/cua-ready || true`,
  ].join("; ");

  // A welcome line in tmux, with anything shell-significant stripped out
  // of the agent's name.
  const safeName = botName.replace(/["'\\]/g, "");

  return [
    `command -v xdotool >/dev/null || sudo apt-get install -y -qq xdotool scrot imagemagick >/dev/null 2>&1 || true`,

    // nohup so the install outlives the command that started it
    `[ -f ${BOX_PREFIX}/cua-ready ] || [ -f /tmp/bloks-cua-installing ] || { touch /tmp/bloks-cua-installing; nohup bash -c '${installCua.replace(/'/g, "'\\''")}; rm -f /tmp/bloks-cua-installing' > /tmp/bloks-cua-install.log 2>&1 & }`,

    // pgrep on the module name cannot match this script's own shell, so no
    // pidfile is needed to avoid the usual self-match
    `if [ -f ${BOX_PREFIX}/cua-ready ] && ! pgrep -f "computer_server" >/dev/null 2>&1; then DISPLAY=\${DISPLAY:-:0} nohup ${BOX_PREFIX}/venv/bin/python -m computer_server --host 127.0.0.1 --port 8000 --width 1280 --height 800 > /tmp/bloks-cua-server.log 2>&1 & fi`,

    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work 'echo; echo "  ▦ ${safeName}'"'"'s computer, Bloks"; echo; exec bash -i'`,

    "echo bootstrapped",
  ].join("\n");
}

// ── the operations the app calls ───────────────────────────────────────

/** Box state for the computer panel. */
export async function boxStatus(cfg: AppConfig, botId: string) {
  if (!boxConfigured(cfg)) return { configured: false, box: null };

  const box = await findBox(cfg, botId);
  return {
    configured: true,
    box: box
      ? { boxId: box.id, state: box.state, desktopAvailable: box.desktopAvailable ?? null }
      : null,
  };
}

/** Find or create this agent's box, wake it, bootstrap it, and hand back a
 * fresh desktop URL. */
export async function provisionBox(cfg: AppConfig, botId: string, botName: string) {
  if (!boxConfigured(cfg)) {
    throw new Error('box provider not enabled. Add {"box":{"token":"…"}} to ~/.bloks/config.json');
  }

  const name = await nameFor(botId, "bloks");
  let box = await findBox(cfg, botId);
  const existed = Boolean(box);

  if (!box) {
    const created = await call(cfg, "/boxes", {
      method: "POST",
      // A backstop on the substrate's side: if every path that should put
      // this box to sleep fails, it archives itself and stops billing.
      body: JSON.stringify({ ttlSeconds: 8 * 60 * 60 }),
    });
    if (!created.ok || !created.body?.box?.id) {
      throw new Error(`box create failed (${created.status})`);
    }
    box = created.body.box;
    await call(cfg, `/boxes/${box.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
  }

  const awake = await waitUntilAwake(cfg, box.id);
  if (!awake) throw new Error("box did not become ready within 90s, retry in a minute");

  // A box that has just woken sometimes refuses the first few commands.
  // Retry until it answers at all; a non-zero exit still counts, since
  // that means the box is alive and the script simply had a bad line.
  const script = bootstrapScript(botName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runCommand(cfg, box.id, script);
    if (result.ok || result.exitCode !== null) break;
    await sleep(3000);
  }

  return {
    boxId: box.id,
    machineName: name,
    reused: existed,
    state: awake.state,
    joinUrl: await mintDesktopUrl(cfg, box.id),
  };
}

/** Wake this agent's box and return a fresh desktop URL. */
export async function joinBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer yet, provision it first");

  const awake = await waitUntilAwake(cfg, box.id);
  if (!awake) throw new Error("the box did not wake in time, try again");

  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: awake.state ?? null };
}

/** Archive it now: billing stops, the disk survives. */
export async function sleepBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this agent");

  await call(cfg, `/boxes/${box.id}/stop`, { method: "POST" }).catch(() => {});
  return { ok: true };
}

/** The console in the computer panel. Output is trimmed at both ends: a
 * command that prints a megabyte should not become a megabyte of JSON. */
export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this agent yet");

  const awake = await waitUntilAwake(cfg, box.id, 60_000);
  if (!awake) throw new Error("box did not wake");

  const result = await runCommand(cfg, box.id, String(command ?? "").slice(0, 4000));
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-2000),
  };
}

/** Capture to a file on the box, then read it back through the files API.
 * Never through stdout: see the note at the top of this file. */
const CAPTURE_SCRIPT = [
  "export DISPLAY=${DISPLAY:-:0}",
  `f=${SHOT_PATH}`,
  'scrot -o "$f" 2>/dev/null || import -window root "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1',
  'command -v convert >/dev/null && convert "$f" -resize 1024x "$f" 2>/dev/null || true',
  'test -s "$f" && echo captured',
].join("; ");

export async function screenshotBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this agent yet");
  if (!AWAKE.has(box.state)) throw new Error(`box is ${box.state}`);

  const captured = await runCommand(cfg, box.id, CAPTURE_SCRIPT, { timeoutMs: 60_000 });
  if (!/captured/.test(captured.stdout)) {
    throw new Error(captured.stderr.slice(0, 200) || "screen capture failed on the box");
  }

  const { ok, body } = await call(
    cfg,
    `/boxes/${box.id}/files?path=${encodeURIComponent(SHOT_PATH)}&encoding=base64`,
  );
  const png = body?.content;
  if (!ok || typeof png !== "string" || !png) {
    throw new Error("could not read the frame back from the box");
  }
  return { png, format: "png" };
}
