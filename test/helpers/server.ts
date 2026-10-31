// Boots the real harness against a throwaway home directory.
//
// These tests talk to the actual server over HTTP rather than importing
// its internals, because the things worth asserting (the origin check,
// the body limits, the status codes) live in the request path.
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_SPECS } from "../../server/providers.ts";

const ENTRY = fileURLToPath(new URL("../../server/index.ts", import.meta.url));

/** Every provider's key variable (config.ts envVarFor), blanked: a key
 * there connects that provider, and a test must never reach a real one. */
const NO_PROVIDER_KEYS = Object.fromEntries(
  PROVIDER_SPECS.map((spec) => [`${spec.kind.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`, ""]),
);

export interface Harness {
  url: string;
  home: string;
  /** A request with a legitimate loopback origin, like the app makes. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The same request as a website would make it. */
  fetchAs(origin: string, path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<any>;
  /** A request that looks like it arrived from the network rather than
   * from this machine. fetch() will not let us forge a Host header, so
   * this drops to node:http, which will. */
  fetchRemote(
    path: string,
    init?: { method?: string; body?: string; token?: string; origin?: string; host?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: any }>;
  /** Everything the harness has printed. A test that cares whether a
   * credential leaked has to look where a leak would actually land. */
  logs(): string;
  stop(): Promise<void>;
  /** Gone with no chance to tidy up, the way a crash or a force quit
   * ends it. Whatever the server had on disk stays as it was. */
  crash(): Promise<void>;
}

/** `extraEnv` lets one test point the harness somewhere of its own, e.g.
 * at a catalog it is serving, so nothing here depends on the internet. */
export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "bloks-test-"));
  // 0 would be ideal, but the harness picks its port from the
  // environment, so take a high one and retry if something owns it.
  // Test files run side by side, each with harnesses of its own, so two
  // of them landing on one port is rare but real. "Something answered
  // /api/health" is not proof it was this child: the loser of that race
  // exits, and its test would quietly talk to another test's server. The
  // server's own startup line, naming this port, is the proof.
  let port = 0;
  let child!: ChildProcess;
  // one pair per attempt, so a killed attempt writing late cannot land
  // in the logs of the one that won
  let io = { out: "", err: "" };
  let url = "";
  const request = (origin: string | null, path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
        ...init.headers,
      },
    });

  for (let attempt = 0; ; attempt++) {
    port = 20_000 + Math.floor(Math.random() * 20_000);
    url = `http://127.0.0.1:${port}`;
    const mine = (io = { out: "", err: "" });
    child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        BLOKS_PORT: String(port),
        // no inherited credentials: a test must never reach a real provider
        ...NO_PROVIDER_KEYS,
        XAI_API_KEY: "",
        WINDSURF_API_KEY: "",
        GEMINI_API_KEY: "",
        COMPOSIO_KEY: "",
        BOX_TOKEN: "",
        BLOKS_COMPOSIO_KEY: "",
        // Composio's project side and its realtime channel (app watchers):
        // never the real ones; a test that wants them serves its own
        BLOKS_COMPOSIO_BACKEND: "http://127.0.0.1:9",
        BLOKS_COMPOSIO_REALTIME: "ws://127.0.0.1:9",
        BLOKS_BOX_TOKEN: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        CURSOR_API_KEY: "",
        CURSOR_AUTH_TOKEN: "",
        CLINE_API_KEY: "",
        // a test run from inside a Bloks agent would otherwise act as it
        BLOKS_TOKEN: "",
        // the throwaway HOME is the whole point: a data folder named by the
        // shell this ran in would put the test in someone's real workspace
        BLOKS_DATA_DIR: "",
        BLOKS_WORKSPACE_ID: "",
        BLOKS_WORKSPACES_DIR: "",
        // Bloks credits: never the real service, and never a token this
        // machine was started with; a test that wants one brings its own
        BLOKS_CREDITS_URL: "http://127.0.0.1:9/api/ai",
        BLOKS_CREDITS_TOKEN: "",
        // the providers' price list (server/model-prices.ts): never the
        // real one; a test that wants a list serves its own
        BLOKS_PRICES_URL: "http://127.0.0.1:9/api/v1/models",
        // the hosted voice vendors (server/speech.ts): never the real
        // ones; a test that wants one serves its own
        BLOKS_FISH_AUDIO_URL: "http://127.0.0.1:9",
        BLOKS_XAI_SPEECH_URL: "http://127.0.0.1:9",
        // the catalogue of teams and skills (server/catalog.ts): never the
        // repository's own; a test that browses one serves it
        BLOKS_CATALOG_URL: "http://127.0.0.1:9/catalog/index.json",
        BLOKS_HOSTED: "",
        // the platform a test stands the server in for (server/hosted.ts);
        // a test that wants Windows or Linux says so itself
        BLOKS_TEST_PLATFORM: "",
        BLOKS_HOSTED_VNC: "",
        BLOKS_PUBLIC_URL: "",
        // tests speak as the dev UI (origin :5199), which a server serving
        // its own page does not trust
        BLOKS_STATIC_DIR: "",
        PATH: "/nonexistent",
        // widenPath adds $npm_config_prefix/bin, which npx exports, and a
        // claude or codex there would make a test's engine real
        npm_config_prefix: "",
        PREFIX: "",
        // bin/bloks-server.mjs sets this, so a test run from inside a Bloks
        // agent would inherit it and find pairing forced on
        BLOKS_LOOPBACK_ONLY: "",
        // and these, which would make a test's server think it was
        // started by bloks-server and may update itself; a test that
        // wants releases serves its own (server/server-update.ts)
        BLOKS_SERVER_HOME: "",
        BLOKS_SERVER_ROOT: "",
        BLOKS_SERVER_STATIC: "",
        BLOKS_SERVER_UPDATES: "",
        BLOKS_RELEASES_URL: "http://127.0.0.1:9/releases/latest",
        BLOKS_RELEASE_DOWNLOADS: "http://127.0.0.1:9/download",
        // a failed turn is asked again after a wait (GitHub 284), and a
        // minute is longer than most tests wait for a turn to settle
        BLOKS_RETRY_WAIT_MS: "50",
        // a test file the runner kills mid-run never calls stop(), so the
        // server watches this process and goes when it does
        BLOKS_TEST_PARENT_PID: String(process.pid),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (c) => (mine.err += c));
    // Drained as well as kept: an unread stdout pipe fills and then blocks
    // the child mid-write, which looks like a hung test and is not one.
    child.stdout?.on("data", (c) => (mine.out += c));

    const listening = `bloks server on ${url}`;
    let ready = false;
    // Thirty seconds to come up. A loaded machine, CI's included, can take
    // more than ten to start the server, and a test that gave up here
    // failed for the machine, not for anything it tests. A healthy start
    // is as quick as ever: the loop leaves as soon as it answers.
    for (let i = 0; i < 300 && child.exitCode === null; i++) {
      if (mine.out.includes(listening)) {
        try {
          ready = (await request(null, "/api/health")).ok;
        } catch {
          /* bound, not answering yet */
        }
        if (ready) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (ready) break;
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!/EADDRINUSE/.test(mine.err) || attempt >= 4) {
      rmSync(home, { recursive: true, force: true });
      throw new Error(`harness exited ${child.exitCode}: ${mine.err.slice(-800)}`);
    }
  }

  return {
    url,
    home,
    fetch: (path, init) => request("http://localhost:5199", path, init),
    fetchAs: (origin, path, init) => request(origin, path, init),
    async json(path, init) {
      const res = await request("http://localhost:5199", path, init);
      return res.json();
    },
    logs: () => io.out + io.err,
    async stop() {
      child.kill("SIGTERM");
      // Really gone before this returns: a test that starts another
      // server on the same home would otherwise find this one still
      // holding the data folder (server/data-lock.ts).
      const gone = await new Promise<boolean>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) return r(true);
        child.once("exit", () => r(true));
        setTimeout(() => r(false), 10_000);
      });
      if (!gone) {
        child.kill("SIGKILL");
        await new Promise((r) => {
          child.once("exit", r);
          setTimeout(r, 2_000);
        });
      }
      // The harness can outlive SIGTERM by a moment: a sandbox teardown,
      // a helper, a last write of a store on its way out. Removing the
      // home while one of those is still writing raises ENOTEMPTY, which
      // fails a test that had already passed and turns the whole suite
      // red for a reason that is not about the product. So it retries,
      // and if it still cannot, it leaves the directory: a stray temp dir
      // on a runner costs nothing, and a false failure costs an
      // afternoon.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          rmSync(home, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
    },
    async crash() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const gone = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await gone;
      rmSync(home, { recursive: true, force: true });
    },
    fetchRemote(path, init = {}) {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          // the whole point: a phone on the wifi names the Mac, not itself
          host: init.host ?? `192.168.1.20:${port}`,
        };
        if (init.token) headers.authorization = `Bearer ${init.token}`;
        if (init.origin) headers.origin = init.origin;
        Object.assign(headers, init.headers);
        const req = httpRequest(
          { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              let body: any = null;
              try {
                body = data ? JSON.parse(data) : null;
              } catch {
                body = data;
              }
              resolve({ status: res.statusCode ?? 0, body });
            });
          },
        );
        req.on("error", reject);
        if (init.body) req.write(init.body);
        req.end();
      });
    },
  };
}
