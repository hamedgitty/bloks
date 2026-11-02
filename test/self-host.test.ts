// A server of the person's own, reached their own way (server/self-host.ts,
// docs/SELF_HOSTING.md, docs/DOCKER.md).
//
// What this holds: the settings read where Bloks runs are read strictly,
// so a typo keeps it on loopback rather than opening it; a bloks-server
// given an address of its owner's pairs devices there, with links both
// apps read, and the desktop app paired that way reaches it through a
// reverse proxy with its own token; a request a proxy forwarded is never
// the person at the server, even from loopback; BLOKS_CLOUD=off sends
// nothing to Bloks Cloud and says so; agents run to the end whether the
// relay is unreachable or turned off; and a model server named in the
// environment is an engine.
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { describe, test } from "node:test";

import { parseDirectLink, claimDirectLink, reachOf, startLanProxy } from "../electron/remote.mjs";
import { addRemote, parseRegistry, settle, snapshot } from "../electron/workspaces.mjs";
import { instanceConfigs } from "../server/config.ts";
import { forwarded, isLocalRequest } from "../server/http-guard.ts";
import {
  CLOUD_OFF,
  cloudOff,
  directDoor,
  directPairLink,
  envModelEndpoint,
  listenAddress,
  listenProblem,
  publicUrlProblems,
  publicUrls,
  reachView,
} from "../server/self-host.ts";
import { installOf, manualSteps, type InstallFacts } from "../server/server-update.ts";
import { cli, scriptingWorkspace } from "./helpers/scripting.ts";
import { startHarness } from "./helpers/server.ts";

// built here, so no token-shaped literal sits in the repository
const TOKEN = `bloks_pair_${"Ab3-".repeat(8)}`;

describe("the settings, read where Bloks runs", () => {
  test("BLOKS_CLOUD is off in the ways an .env file says off, and on otherwise", () => {
    for (const off of ["off", "OFF", "0", "false", "no", " off "]) assert.equal(cloudOff({ BLOKS_CLOUD: off }), true, off);
    for (const on of ["", "on", "1", "yes", "offline"]) assert.equal(cloudOff({ BLOKS_CLOUD: on }), false, on);
    assert.equal(cloudOff({}), false);
  });

  test("BLOKS_LISTEN takes every interface and nothing narrower, and says why not", () => {
    assert.equal(listenAddress({ BLOKS_LISTEN: "0.0.0.0" }), "0.0.0.0");
    assert.equal(listenAddress({ BLOKS_LISTEN: "::" }), "::");
    assert.equal(listenAddress({ BLOKS_LISTEN: "[::]" }), "::");
    for (const narrow of ["", "127.0.0.1", "localhost", "100.101.102.103", "fd7a::1", "0.0.0.0.0", "all"]) {
      assert.equal(listenAddress({ BLOKS_LISTEN: narrow }), null, narrow);
    }
    assert.equal(listenProblem({ BLOKS_LISTEN: "127.0.0.1" }), null, "loopback is what it does anyway");
    assert.equal(listenProblem({}), null);
    assert.match(listenProblem({ BLOKS_LISTEN: "100.101.102.103" }) ?? "", /loopback only/);
  });

  test("BLOKS_PUBLIC_URL is a list of origins; a path, credentials or another scheme are refused and said", () => {
    const env = {
      BLOKS_PUBLIC_URL: "https://bloks.example.test/, http://[fd7a:115c:a1e0::1]:8799 http://100.101.102.103:8799,https://bloks.example.test,https://x.test/bloks,ftp://x.test,https://u:p@x.test,nonsense",
    };
    assert.deepEqual(publicUrls(env), ["https://bloks.example.test", "http://[fd7a:115c:a1e0::1]:8799", "http://100.101.102.103:8799"]);
    const problems = publicUrlProblems(env).join("\n");
    assert.match(problems, /x\.test\/bloks has a path/);
    assert.match(problems, /ftp:\/\/x\.test is not http or https/);
    assert.match(problems, /carries a name or password/);
    assert.match(problems, /nonsense is not an address/);
    assert.equal(publicUrls({ BLOKS_PUBLIC_URL: "https://a.test,https://b.test,https://c.test,https://d.test,https://e.test" }).length, 4);
  });

  test("a direct door is a bloks-server's alone, and never a hosted machine's", () => {
    const own = { BLOKS_LOOPBACK_ONLY: "1", BLOKS_PUBLIC_URL: "https://bloks.example.test" };
    assert.equal(directDoor(own), true);
    assert.equal(directDoor({ BLOKS_LOOPBACK_ONLY: "1", BLOKS_LISTEN: "0.0.0.0" }), true);
    assert.equal(directDoor({ BLOKS_LOOPBACK_ONLY: "1" }), false, "loopback and Bloks Cloud, as before");
    assert.equal(directDoor({ BLOKS_PUBLIC_URL: "https://bloks.example.test" }), false, "the desktop app's servers pair as they always did");
    assert.equal(directDoor({ ...own, BLOKS_HOSTED: "1" }), false, "a hosted machine's public URL is the provider's door, not a device's");
    assert.deepEqual(reachView({ ...own, BLOKS_CLOUD: "off" }), { cloud: "off", direct: true, publicUrls: ["https://bloks.example.test"] });
    assert.deepEqual(reachView({}), { cloud: "on", direct: false, publicUrls: [] });
  });
});

describe("the pairing link", () => {
  test("http is written the way a Mac's code always was, https whole, and both apps' readers agree", () => {
    const https = directPairLink("https://bloks.example.test", TOKEN, "123456", "Home lab");
    assert.equal(https, `bloks://pair?url=${encodeURIComponent("https://bloks.example.test")}&token=${TOKEN}&code=123456&name=Home%20lab`);
    const v4 = directPairLink("http://100.101.102.103:8799", TOKEN, "123456");
    assert.equal(v4, `bloks://pair?address=${encodeURIComponent("100.101.102.103:8799")}&token=${TOKEN}&code=123456`);
    const v6 = directPairLink("http://[fd7a:115c:a1e0::1]:8799", TOKEN, "123456");
    assert.match(v6 ?? "", /address=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A8799/, "bracketed, as the iPhone app reads it");
    assert.match(directPairLink("http://homelab", TOKEN, "123456") ?? "", /address=homelab%3A80&/, "http with no port is 80");

    assert.deepEqual(parseDirectLink(https ?? ""), { url: "https://bloks.example.test", credential: TOKEN, host: "Home lab" });
    assert.deepEqual(parseDirectLink(v4 ?? ""), { url: "http://100.101.102.103:8799", credential: TOKEN, host: "" });
    assert.equal(parseDirectLink(v6 ?? "")?.url, "http://[fd7a:115c:a1e0::1]:8799");

    assert.equal(directPairLink("https://bloks.example.test", "not-a-token", "123456"), null);
    assert.equal(directPairLink("https://bloks.example.test", TOKEN, "12345"), null);
    assert.equal(directPairLink("https://bloks.example.test/x", TOKEN, "123456"), null);
  });

  test("a link with anything odd in it is no link at all", () => {
    const good = `bloks://pair?url=${encodeURIComponent("https://bloks.example.test")}&code=123456`;
    assert.equal(parseDirectLink(good)?.credential, "123456", "a code alone will do");
    for (const bad of [
      `${good}&code=654321`, // a key twice
      `bloks://pair?url=${encodeURIComponent("https://bloks.example.test/bloks")}&code=123456`,
      `bloks://pair?url=${encodeURIComponent("https://me:pw@bloks.example.test")}&code=123456`,
      `bloks://pair?url=${encodeURIComponent("file:///etc/passwd")}&code=123456`,
      `bloks://pair?url=${encodeURIComponent("https://a.test")}&address=b.test%3A80&code=123456`,
      `bloks://pair?url=${encodeURIComponent("https://bloks.example.test")}&code=12ab56`,
      `bloks://join?url=${encodeURIComponent("https://bloks.example.test")}&code=123456`,
      `https://bloks.dev/pair#abc`,
      "not a link",
    ]) {
      assert.equal(parseDirectLink(bad), null, bad);
    }
    // a Bloks Cloud link is a different thing, read by the other reader
    assert.equal(parseDirectLink("bloks://pair#eyJ2IjoxfQ"), null);
  });

  test("a direct profile is reached directly, and the switcher says where", () => {
    assert.equal(reachOf({ url: "https://bloks.example.test", deviceId: "d", deviceToken: "t" }), "direct");
    assert.equal(reachOf({ url: "https://bloks.example.test/path", deviceId: "d", deviceToken: "t" }), null);
    assert.equal(reachOf({ relayUrl: "https://relay.test", relayToken: "x", url: "https://bloks.example.test", deviceId: "d", deviceToken: "t" }), "relay");
    const fresh = () => settle(parseRegistry(null), { personalDataDir: "/home/fixture/.bloks", now: 1, random: () => 0.5 });
    const added = addRemote(fresh(), { name: "Home lab", direct: "https://bloks.example.test" }, { id: "ws_direct1" });
    assert.equal(added.entry.host?.direct, "https://bloks.example.test");
    assert.equal(snapshot(added.registry).workspaces.find((w) => w.id === "ws_direct1")?.direct, "https://bloks.example.test");
    // and it is kept across a restart, and read back as strictly
    const kept = parseRegistry(JSON.stringify(added.registry));
    assert.equal(kept.workspaces.find((w) => w.id === "ws_direct1")?.host?.direct, "https://bloks.example.test");
    assert.equal(addRemote(fresh(), { direct: "javascript:alert(1)" }, { id: "ws_direct2" }).entry.host?.direct, undefined);
  });
});

describe("a request a proxy passed on", () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;

  test("is never the person at the server, even from loopback with a loopback Host", () => {
    assert.equal(isLocalRequest(req({ host: "127.0.0.1:8799" })), true, "the CLI and the app, as before");
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip", "true-client-ip", "tailscale-user-login"]) {
      // NGINX's default: Host rewritten to the upstream, and the client's address added
      const proxied = req({ host: "127.0.0.1:8799", [header]: "203.0.113.9" });
      assert.equal(forwarded(proxied), true, header);
      assert.equal(isLocalRequest(proxied), false, header);
    }
  });
});

describe("the image's own update", () => {
  test("a container from the Bloks image is told to pull, a hand-built one to build", () => {
    const facts = (env: NodeJS.ProcessEnv): InstallFacts => ({
      platform: "linux",
      env: { BLOKS_SERVER_ROOT: "/opt/bloks-server", BLOKS_SERVER_HOME: "/opt/bloks-server", ...env },
      desktop: false,
      hosted: false,
      codeRoot: "/opt/bloks-server",
      container: true,
      cgroup: null,
      exists: () => false,
      writable: () => false,
      packageOf: () => ({ name: "bloks-server", version: "3.2.0" }),
    });
    const image = installOf(facts({ BLOKS_CONTAINER: "image" }));
    assert.equal(image.kind, "container");
    assert.equal(image.canInstall, false);
    assert.equal(image.image, true);
    assert.match(image.why, /Pull the new image/);
    const steps = manualSteps(image, { version: "3.2.1", platform: "linux" }).join("\n");
    assert.match(steps, /BLOKS_VERSION=3\.2\.1[\s\S]*bloks-server drain[\s\S]*docker compose pull[\s\S]*docker compose up -d/);
    assert.match(manualSteps(installOf(facts({})), { version: "3.2.1", platform: "linux" }).join("\n"), /docker build[\s\S]*docker run/);
  });
});

describe("a model server named in the environment", () => {
  const keys = ["BLOKS_MODEL_URL", "BLOKS_MODEL_KEY", "BLOKS_MODEL_NAME", "BLOKS_MODEL_TOOLS", "BLOKS_MODEL_VISION"] as const;

  test("is an engine of its own, with its key in its own environment only", (t) => {
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    });
    assert.equal(envModelEndpoint({}), null);
    assert.equal(envModelEndpoint({ BLOKS_MODEL_URL: "ftp://x" }), null);
    assert.deepEqual(envModelEndpoint({ BLOKS_MODEL_URL: "http://vllm:8000/v1/chat/completions/" }), {
      url: "http://vllm:8000/v1",
      key: "none",
      name: "vllm:8000",
      tools: false,
      vision: false,
    });

    const secret = ["model", "server", "key", "for", "test"].join("-");
    Object.assign(process.env, { BLOKS_MODEL_URL: "http://host.docker.internal:8000/v1", BLOKS_MODEL_KEY: secret, BLOKS_MODEL_NAME: "Qwen", BLOKS_MODEL_TOOLS: "1", BLOKS_MODEL_VISION: "" });
    const map = instanceConfigs({});
    const engine = map.custom_env;
    assert.ok(engine, "listed as an engine");
    assert.equal(engine.driver, "custom");
    assert.equal(engine.displayName, "Qwen");
    assert.deepEqual(engine.config, { url: "http://host.docker.internal:8000/v1", tools: true });
    assert.equal(engine.environment?.CUSTOM_API_KEY, secret);
    for (const [id, other] of Object.entries(map)) {
      if (id !== "custom_env") assert.ok(!Object.values(other.environment ?? {}).includes(secret), `${id} was handed the model server's key`);
    }
    delete process.env.BLOKS_MODEL_URL;
    assert.equal(instanceConfigs({}).custom_env, undefined);
  });
});

/** A reverse proxy, the way Caddy is one: it keeps the Host the device
 * sent, says it forwarded, and connects to the server from loopback. */
async function reverseProxy(target: string, host: string): Promise<{ url: string; close: () => void }> {
  const upstream = new URL(target);
  const server: Server = createServer((req, res) => {
    const out = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    out.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("a bloks-server with an address of its owner's pairs the desktop app there, through a proxy, with no Bloks Cloud", { timeout: 180_000 }, async (t) => {
  const h = await startHarness({
    BLOKS_LOOPBACK_ONLY: "1",
    BLOKS_PUBLIC_URL: "https://bloks.example.test,http://100.101.102.103:8799",
    BLOKS_CLOUD: "off",
    BLOKS_COMPUTER_NAME: "Home lab",
  });
  t.after(() => h.stop());

  // at the server, it says where devices reach it
  const status = await h.json("/api/pair");
  assert.equal(status.listening, "network");
  assert.equal(status.restartRequired, false);
  assert.deepEqual(status.addresses, ["https://bloks.example.test", "http://100.101.102.103:8799"]);
  const config = await h.json("/api/config");
  assert.deepEqual(config.deployment.reach, { cloud: "off", direct: true, publicUrls: ["https://bloks.example.test", "http://100.101.102.103:8799"] });
  assert.match(h.logs(), /your devices pair at https:\/\/bloks\.example\.test, http:\/\/100\.101\.102\.103:8799/);
  assert.match(h.logs(), /Bloks Cloud is turned off here/);

  // a proxy on this machine is not the person at it, whatever Host it sends
  const proxy = await reverseProxy(h.url, "bloks.example.test");
  t.after(() => proxy.close());
  const nginxDefault = await h.fetchRemote("/api/config", { host: `127.0.0.1:${new URL(h.url).port}`, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(nginxDefault.status, 401, "a forwarded request with Host rewritten to loopback got the local surface");
  assert.equal((await fetch(`${proxy.url}/api/config`)).status, 401, "a stranger through the proxy got past the token");
  assert.equal((await fetch(`${proxy.url}/api/health`)).status, 200, "the proxy reaches Bloks");

  // `bloks-server pair` prints a link for each address, and the code
  const printed = await cli(h, ["pair"]);
  assert.equal(printed.code, 0, printed.err);
  assert.match(printed.out, /https:\/\/bloks\.example\.test\n  bloks:\/\/pair\?url=https%3A%2F%2Fbloks\.example\.test&token=bloks_pair_/);
  assert.match(printed.out, /bloks:\/\/pair\?address=100\.101\.102\.103%3A8799&token=/);
  assert.match(printed.out, /The code is \d{6}/);
  assert.doesNotMatch(printed.out, /Bloks Cloud:/, "no Bloks Cloud link when it is off");
  const said = await cli(h, ["status"]);
  assert.match(said.out, /for your devices at https:\/\/bloks\.example\.test/);
  assert.match(said.out, /Bloks Cloud is turned off here/);

  // the desktop app spends the link at the address, through the proxy
  const started = await h.json("/api/pair/start", { method: "POST" });
  assert.equal(started.links.length, 2);
  const link = started.links[0].link as string;
  assert.equal(started.links[0].url, "https://bloks.example.test");
  // the device dials https://bloks.example.test, which is this proxy
  const viaProxy: typeof fetch = (input, init) => fetch(String(input).replace("https://bloks.example.test", proxy.url), init);
  const profile = await claimDirectLink(link, "Fixture MacBook (desktop)", { fetcher: viaProxy });
  assert.equal(profile.url, "https://bloks.example.test");
  assert.equal(profile.host, "Home lab");
  assert.ok(profile.deviceToken.length > 20);
  await assert.rejects(claimDirectLink(link, "Again", { fetcher: viaProxy }), /already used or has expired/, "a link works once");

  // and the window works through the stand-in, as that device
  const standIn = await startLanProxy(profile, { fetcher: viaProxy });
  t.after(() => standIn.stop());
  const asDevice = await fetch(`http://127.0.0.1:${standIn.port}/api/pair`);
  assert.equal(asDevice.status, 200);
  const seen = await asDevice.json();
  assert.equal(seen.thisDevice, profile.deviceId, "the server saw the paired device, not the person at it");
  assert.equal(seen.here, false);

  // and Bloks Cloud is not asked for anything
  for (const [method, path] of [
    ["POST", "/api/relay/activate"],
    ["PUT", "/api/relay"],
    ["DELETE", "/api/relay/space"],
    ["POST", "/api/pair/link"],
    ["GET", "/api/plan"],
  ] as const) {
    const res = await h.fetch(path, { method, body: method === "GET" ? undefined : JSON.stringify({ key: `blok_live_${"0".repeat(32)}`, enabled: true }) });
    const body = await res.json();
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(body.error, CLOUD_OFF, `${method} ${path}`);
  }
  const relay = await h.json("/api/relay");
  assert.equal(relay.enabled, false);
  assert.equal(relay.cloud, "off");
  const activated = await cli(h, ["activate", `blok_live_${"0".repeat(32)}`]);
  assert.notEqual(activated.code, 0);
  assert.match(activated.err, /BLOKS_CLOUD=off/);
});

test("without an address of its own, a bloks-server pairs through Bloks Cloud as before", { timeout: 120_000 }, async (t) => {
  const h = await startHarness({ BLOKS_LOOPBACK_ONLY: "1" });
  t.after(() => h.stop());
  const status = await h.json("/api/pair");
  assert.equal(status.listening, "loopback");
  assert.deepEqual(status.addresses, []);
  const refused = await h.fetch("/api/pair/start", { method: "POST" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "cloud-only");
  assert.equal((await h.json("/api/config")).deployment.reach.direct, false);
});

test("BLOKS_LISTEN=0.0.0.0 puts a bloks-server on the network, where only a token gets past /api/health", { timeout: 120_000 }, async (t) => {
  // an address of this machine's that is not loopback, to come in on
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
  if (!lan) return t.skip("this machine has no network address to try");
  const h = await startHarness({ BLOKS_LOOPBACK_ONLY: "1", BLOKS_LISTEN: "0.0.0.0" });
  t.after(() => h.stop());
  const port = new URL(h.url).port;
  assert.match(h.logs(), new RegExp(`listening on 0\\.0\\.0\\.0:${port} for paired devices`));
  const over = (path: string) => fetch(`http://${lan}:${port}${path}`);
  assert.equal((await over("/api/health")).status, 200, "the network reaches it");
  assert.equal((await over("/api/config")).status, 401, "and gets no further without a token");
  // and loopback, where `bloks-server pair` and a health check talk, still does
  assert.equal((await h.fetch("/api/config")).status, 200);
  assert.equal((await h.json("/api/config")).deployment.reach.direct, true);
});

/** A stand-in relay that only counts who called it. */
async function countingRelay(): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(503);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, close: () => server.close() };
}

const relayConfig = (url: string) => ({ relay: { enabled: true, url, agentToken: ["fixture", "agent", "token"].join("-"), clientToken: ["fixture", "client", "token"].join("-") } });

test("agents run to the end while the relay cannot be reached", { timeout: 180_000 }, async (t) => {
  // nothing listens on port 9: every dial is refused
  const { h, hire } = await scriptingWorkspace(t, { BLOKS_LOOPBACK_ONLY: "1" }, relayConfig("http://127.0.0.1:9"));
  await hire("Ada");
  const ran = await cli(h, ["run", "Ada", "PLAIN please"]);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.out, "PLAIN-REPLY\n");
  const relay = await h.json("/api/relay");
  assert.equal(relay.enabled, true, "Bloks Cloud is on");
  assert.equal(relay.connected, false, "and its relay is out of reach the whole time");
});

test("with BLOKS_CLOUD=off, agents run and the relay is never called, whatever the config kept", { timeout: 180_000 }, async (t) => {
  const relay = await countingRelay();
  t.after(() => relay.close());
  const { h, hire } = await scriptingWorkspace(t, { BLOKS_LOOPBACK_ONLY: "1", BLOKS_CLOUD: "off" }, relayConfig(relay.url));
  await hire("Ada");
  const ran = await cli(h, ["run", "Ada", "PLAIN please"]);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.out, "PLAIN-REPLY\n");
  // the people and plan pages, the credits screen and the galleries all ask nothing
  await h.fetch("/api/credits");
  await h.fetch("/api/plan");
  const status = await h.json("/api/relay/status");
  assert.equal(status.enabled, false);
  assert.equal(status.problem, CLOUD_OFF);
  assert.equal(relay.hits(), 0, "something called the relay with Bloks Cloud turned off");
});
