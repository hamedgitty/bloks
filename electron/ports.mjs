// Which port the server gets, and what to say when none will do.
//
// The usual ports are a habit, not a requirement: a stray process on one
// of them should cost a moment, never the whole app. So a busy port is
// skipped at once (no server forked just to find out), and when every
// usual port is busy the system is asked for any free one. The port that
// last worked is tried first, because a phone paired on this network
// remembers it. A port you chose comes before all of them: "port" in
// ~/.bloks/config.json, which works however the app was opened, or
// BLOKS_PORT, which only reaches an app started from a terminal.
//
// When it still fails, the page says which ports were tried and what was
// on each, and when the server itself stopped rather than a port being
// busy, it says that instead of blaming the ports. The pure parts live
// here so they can be tested without starting anything.
import net from "node:net";

export const USUAL_PORTS = [8799, 18799, 28799];

/** Ports to try, in order, without repeats or nonsense. */
export function portOrder({ env, configured, last, usual = USUAL_PORTS }) {
  const wanted = [Number(env), Number(configured), Number(last), ...usual];
  const out = [];
  for (const port of wanted) {
    if (Number.isInteger(port) && port > 0 && port < 65536 && !out.includes(port)) out.push(port);
  }
  return out;
}

/** Whether nothing is listening on this port on loopback. */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** A port the system says is free right now. */
export function anyFreePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The name and pid in `lsof -F cp` output, if there are any. */
export function parseLsof(text) {
  let pid = null;
  let name = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("p") && pid === null) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("c") && name === null) name = line.slice(1).trim() || null;
  }
  return name ? { name, pid } : null;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** What one attempt found, in a line a person can act on. */
export function describeAttempt(attempt) {
  if (attempt.why === "busy") {
    return attempt.holder
      ? `Port ${attempt.port} is in use by ${attempt.holder.name}${attempt.holder.pid ? ` (pid ${attempt.holder.pid})` : ""}.`
      : `Port ${attempt.port} is in use by another program.`;
  }
  if (attempt.why === "other-server") return `Port ${attempt.port} answered, but not as Bloks.`;
  if (attempt.why === "exited") return `The server stopped while starting on port ${attempt.port}.`;
  return `The server on port ${attempt.port} did not answer in time.`;
}

/**
 * The page shown when no port worked. A server that crashed is not a
 * port problem, so its own last words lead when there are any; otherwise
 * the ports and what held them, and the way to pick one yourself.
 */
export function failurePage({ attempts, crash, backdrop, machine, inUse = null }) {
  const crashed = !inUse && attempts.some((a) => a.why === "exited") && crash;
  const title = inUse
    ? "Bloks is already running on this " + machine
    : crashed
      ? "The Bloks server stopped while starting"
      : "Couldn't find a free port for Bloks";
  const lead = inUse
    ? `Another Bloks server (process ${inUse.pid}) is using your Bloks data in ~/.bloks, at http://127.0.0.1:${inUse.port}. ` +
      "Two servers on one data folder overwrite each other's changes, so this window does not start a second one. " +
      "Open that address in a browser to use it, or stop that server and reopen Bloks."
    : crashed
    ? "This is not about ports. Its last words are below; quit and reopen Bloks, and if it happens again, please include them in a bug report."
    : `Every port Bloks tried was taken. Quit whatever is using them, or choose a port by adding "port": 9123 to ~/.bloks/config.json, then reopen Bloks. If it keeps happening, restart your ${machine}.`;
  const lines = inUse ? "" : attempts.map((a) => `<li>${escapeHtml(describeAttempt(a))}</li>`).join("");
  const tail = crashed
    ? `<pre style="text-align:left;white-space:pre-wrap;background:#1b1b1f;color:#c9c9d1;border-radius:10px;padding:10px 12px;font:12px ui-monospace,Menlo,monospace;max-height:180px;overflow:auto">${escapeHtml(crash.slice(-1500))}</pre>`
    : "";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${backdrop};color:#ededf0;font:15px -apple-system,system-ui">` +
        `<div style="text-align:center;max-width:460px;padding:24px">` +
        `<div style="font-size:42px;color:#7c8aff">▦</div>` +
        `<h2 style="font-weight:600;margin:12px 0 6px">${title}</h2>` +
        `<p style="color:#8f8f99;line-height:1.5">${lead}</p>` +
        `<ul style="text-align:left;color:#b4b4bd;line-height:1.6;font-size:13px;padding-left:20px">${lines}</ul>` +
        tail +
        `</div></body>`,
    )
  );
}
