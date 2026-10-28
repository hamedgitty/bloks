// An agent working in a Docker container or on another machine over SSH,
// end to end against the real server, with docker and ssh stood in for
// (test/helpers/fake-places.ts) and an engine on the far side that writes
// down what it was handed. Nothing here reaches a real container or host.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fakePlaces, type FakePlaces } from "./helpers/fake-places.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

const COMPOSIO = "ck_place_canary_51a7";
const LOCAL_ONLY = "local_only_canary_93be";

async function setup(t: TestContext, path?: (fake: FakePlaces) => string) {
  const root = mkdtempSync(join(tmpdir(), "bloks-place-"));
  const seen = join(root, "seen.json");
  const fake = fakePlaces(root, seen);
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(
    join(root, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli: "claude" } } },
      composio: { key: COMPOSIO, url: "http://127.0.0.1:9/mcp" },
    }),
  );
  const h = await startHarness({ HOME: root, ...fake.env, ...(path ? { PATH: path(fake) } : {}), FAKE_SECRET_HERE: LOCAL_ONLY });
  t.after(async () => {
    await h.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.txt"), "before\n");
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ cwd: project, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  return { h, fake, seen, bot: bot as { id: string; threadId: string }, root, project };
}

const putPlace = (h: Harness, botId: string, workplace: unknown) =>
  h.fetch(`/api/bots/${botId}/workplace`, { method: "PUT", body: JSON.stringify({ workplace }) });

const seenOf = async (file: string) => {
  const found = await waitFor(() => existsSync(file), 20_000);
  assert.ok(found, "the engine on the far side never ran");
  return JSON.parse(readFileSync(file, "utf8"));
};

const allArgs = (fake: FakePlaces) => [...fake.dockerCalls(), ...fake.sshCalls()].flat().join("\n");

test("a turn in a container Bloks makes runs its engine there, reaches Bloks only through the gate, and brings its files back", async (t) => {
  const { h, fake, seen, bot, project } = await setup(t);
  const saved = await putPlace(h, bot.id, {
    kind: "docker",
    source: "image",
    image: "node:22-bookworm",
    name: "bloks-scout",
    folder: "mount",
    path: project,
    cpus: 2,
    memoryGb: 1,
    network: true,
    idleMinutes: 15,
  });
  assert.equal(saved.status, 200, await saved.clone().text());

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Write the report." }) });
  const out = await seenOf(seen);

  // made from the image, with what the settings said
  const run = fake.dockerCalls().find((args) => args[0] === "run");
  assert.ok(run, "no container was made");
  const flag = (name: string) => run![run!.indexOf(name) + 1];
  assert.equal(flag("--name"), "bloks-scout");
  assert.ok(run!.includes(`dev.bloks.agent=${bot.id}`));
  assert.equal(flag("--cpus"), "2");
  assert.equal(flag("--memory"), "1024m");
  assert.equal(flag("--volume"), `${project}:${project}`);
  assert.equal(flag("--add-host"), "host.docker.internal:host-gateway");
  assert.ok(!run!.includes("--network"));
  assert.ok(run!.includes("node:22-bookworm"));

  // the engine started there over docker exec -i, as the program it is
  // called there, with the bootstrap ahead of it
  const exec = fake.dockerCalls().find((args) => args[0] === "exec" && args.includes("claude"));
  assert.ok(exec, "the engine was not started with docker exec");
  assert.deepEqual(exec!.slice(0, 5), ["exec", "-i", "bloks-scout", "sh", "-c"]);
  assert.ok(exec!.includes("stream-json"));
  assert.equal(realpathSync(out.cwd), realpathSync(project));

  // Nothing secret on any command line, and nothing of this computer's
  // environment, an engine key or a workspace key over there.
  const argv = allArgs(fake);
  for (const secret of [COMPOSIO, LOCAL_ONLY, "blk_", "blg_"]) assert.ok(!argv.includes(secret), `${secret} is in a command line`);
  assert.equal(out.env.FAKE_SECRET_HERE, null);
  assert.equal(out.env.BLOKS_COMPOSIO_KEY, null);
  assert.equal(out.env.ANTHROPIC_API_KEY, null);
  assert.equal(out.env.token, true);
  assert.match(out.env.BLOKS_URL, /^http:\/\/(host\.docker\.internal|\d+\.\d+\.\d+\.\d+):\d+$/);
  assert.ok(out.env.BLOKS_CLI.startsWith(fake.home) && out.cliThere, "the agent's command line is not there");
  assert.match(out.persona, /You work in container bloks-scout/);

  // through the gate: its own token works, and nothing else does
  assert.equal(out.whoami.status, 200, JSON.stringify(out.whoami));
  assert.equal(out.whoami.body.where.kind, "docker");
  assert.equal(out.whoami.body.where.label, "container bloks-scout");
  assert.equal(out.bare, 401, "the gate answered without a token");
  assert.equal(out.forged, 401, "the gate answered a token that is not a turn's");
  assert.equal(out.selfMove, 403, "an agent moved itself");

  // Every MCP server is reached over HTTP through the gate, the bridge
  // first among them, and none of their keys went with it.
  const servers = out.mcp.mcpServers as Record<string, any>;
  for (const [name, server] of Object.entries(servers)) {
    assert.equal(server.type, "http", `${name} is not over HTTP`);
    assert.ok(!("command" in server), `${name} would run there`);
    assert.match(server.headers.Authorization, /^Bearer blg_/);
    assert.ok(!JSON.stringify(server).includes(COMPOSIO), `${name} carries the Composio key`);
  }
  assert.ok(servers.bloks && servers.composio);
  assert.ok(out.init?.result?.serverInfo, `the bridge did not initialize: ${JSON.stringify(out.init)} ${out.error ?? ""}`);
  assert.ok(out.tools.includes("approve"), `the bridge listed ${out.tools}`);
  assert.equal(out.bridgeWithoutToken, 401);

  // the file it made there came back, as a card, and nothing hidden did
  const settled = await idle(h, bot);
  assert.ok(settled, `the turn did not end: ${JSON.stringify((await messagesOf(h, bot)).map((m) => [m.kind, m.text ?? m.tool?.name])).slice(-1500)} ${h.logs().slice(-3000)}`);
  const card = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.kind === "artifact" && m.artifact?.name === "report.md"));
  assert.ok(card, `the file it made there is not a card here: ${JSON.stringify((await messagesOf(h, bot)).map((m) => [m.kind, m.text ?? m.tool?.name ?? m.artifact?.name]))} ${h.logs().slice(-1500)}`);
  assert.ok(!(await messagesOf(h, bot)).some((m) => m.kind === "artifact" && String(m.artifact?.name).includes("hidden")));
  // its outbox and run folder there are gone
  const leftover = existsSync(join(fake.home, ".bloks", "run")) ? readdirSync(join(fake.home, ".bloks", "run")) : [];
  await waitFor(() => !existsSync(out.env.BLOKS_OUTBOX) && !leftover.some((dir) => existsSync(join(fake.home, ".bloks", "run", dir))));
  assert.ok(!existsSync(out.env.BLOKS_OUTBOX), "the outbox was left there");

  // the header knows where it is
  const { bots } = await h.json("/api/bots?messages=0");
  const now = bots.find((b: any) => b.id === bot.id);
  assert.equal(now.workplaceStatus.label, "container bloks-scout");
  assert.equal(now.workplaceStatus.state, "ready");
});

test("over SSH the engine runs on the host, reaches Bloks through a reverse tunnel, and a dropped connection fails the turn cleanly", async (t) => {
  const { h, fake, seen, bot, root } = await setup(t);
  const there = join(root, "remote-work");
  const saved = await putPlace(h, bot.id, { kind: "ssh", host: "deploy@build-box", port: 2222, path: there });
  assert.equal(saved.status, 200, await saved.clone().text());

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Build it." }) });
  const out = await seenOf(seen);

  const engine = fake.sshCalls().find((args) => args.at(-1)!.includes("'claude'"));
  assert.ok(engine, "the engine was not started over ssh");
  for (const option of ["-T", "BatchMode=yes", "ServerAliveInterval=15", "ExitOnForwardFailure=yes"]) assert.ok(engine!.includes(option), `no ${option}`);
  assert.equal(engine![engine!.indexOf("-p") + 1], "2222");
  const tunnel = engine![engine!.indexOf("-R") + 1];
  const [, remotePort] = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+$/.exec(tunnel) ?? [];
  assert.ok(remotePort, `the tunnel is ${tunnel}`);
  assert.equal(engine![engine!.indexOf("--") + 1], "deploy@build-box");
  assert.match(engine!.at(-1)!, /^'sh' '-c' /);
  // the far side's loopback is the tunnel's end, and the gate is behind it
  assert.equal(out.env.BLOKS_URL, `http://127.0.0.1:${remotePort}`);
  assert.equal(out.whoami.status, 200);
  assert.equal(out.whoami.body.where.kind, "ssh");
  assert.equal(out.bare, 401);
  assert.equal(realpathSync(out.cwd), realpathSync(there), "the folder there was not made and used");
  assert.ok(!allArgs(fake).includes(COMPOSIO) && !allArgs(fake).includes(LOCAL_ONLY));
  await idle(h, bot);
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).some((m) => m.kind === "artifact" && m.artifact?.name === "report.md")));
  // taking that message back says its files there stay as they are
  const asked = (await messagesOf(h, bot)).find((m) => m.role === "user" && m.text === "Build it.");
  const redo = await h.json(`/api/threads/${bot.threadId}/messages/${asked.id}/redo`);
  assert.equal(redo.filesElsewhere, "on build-box over SSH", JSON.stringify(redo));

  // the link goes partway through the next turn
  rmSync(seen);
  writeFileSync(join(fake.home, ".hold"), "4000");
  fake.setSsh({ dropAfterMs: 1500 });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Again." }) });
  const dropped = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.kind === "notice" && /dropped/.test(m.text ?? "")), 30_000);
  assert.ok(dropped, `a dropped connection was not said: ${JSON.stringify((await messagesOf(h, bot)).slice(-4).map((m) => [m.kind, m.text ?? m.tool?.name]))}`);
  assert.match(dropped!.text, /connection to build-box dropped/i);
  assert.match(dropped!.text, /reconnects for the next message/);
  assert.ok(await idle(h, bot), "the lane stayed busy after the drop");
  // and it looks again, so the header can say when it is back
  const back = await waitFor(async () => {
    const { bots } = await h.json("/api/bots?messages=0");
    return bots.find((b: any) => b.id === bot.id)?.workplaceStatus?.state === "ready";
  }, 20_000);
  assert.ok(back, "it never said the host was back");
});

test("a host that cannot be reached stops the turn before any engine, with what to do about it", async (t) => {
  const { h, fake, seen, bot } = await setup(t);
  fake.setSsh({ fail: "ssh: Could not resolve hostname nowhere: nodename nor servname provided, or not known" });
  assert.equal((await putPlace(h, bot.id, { kind: "ssh", host: "nowhere", path: "~/work" })).status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hello?" }) });
  const notice = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.kind === "notice" && /could not find nowhere/i.test(m.text ?? "")));
  assert.ok(notice, "the unreachable host was not said");
  assert.match(notice!.text, /~\/\.ssh\/config/);
  assert.ok(await idle(h, bot));
  assert.ok(!existsSync(seen), "an engine ran anyway");
  const { bots } = await h.json("/api/bots?messages=0");
  assert.equal(bots.find((b: any) => b.id === bot.id).workplaceStatus.state, "unreachable");
});

test("with the network off, a container reaches only Bloks and its engine's own hosts, over the line", async (t) => {
  const { h, fake, seen, bot, project } = await setup(t);
  const inside = join(project, "..", "inside");
  const saved = await putPlace(h, bot.id, { kind: "docker", source: "image", image: "node:22-bookworm", name: "bloks-quiet", folder: "copy", path: inside, network: false });
  assert.equal(saved.status, 200, await saved.clone().text());
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Quietly." }) });
  const out = await seenOf(seen);
  const run = fake.dockerCalls().find((args) => args[0] === "run")!;
  assert.equal(run[run.indexOf("--network") + 1], "none");
  assert.ok(!run.includes("--add-host") && !run.includes("--volume"));
  // copied in once, when the container was made
  assert.ok(fake.dockerCalls().some((args) => args[0] === "cp" && args[2] === `bloks-quiet:${inside}`));
  assert.ok(existsSync(join(inside, "notes.txt")));
  // the line is a node program run with docker exec, and Bloks is at its end
  assert.ok(fake.dockerCalls().some((args) => args[0] === "exec" && args.includes("node") && args.some((a) => a.endsWith("/line.mjs"))));
  assert.match(out.env.BLOKS_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(out.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(out.whoami.status, 200, JSON.stringify(out));
  assert.ok(out.tools.includes("approve"), "the approval bridge did not come through the line");
  assert.match(out.proxyElsewhere, /^HTTP\/1\.1 403/);
  assert.match(out.proxyPort80, /^HTTP\/1\.1 403/);
  // nothing here is undoable, and it says so
  assert.match(out.persona, /cannot undo what you change there/);
  // the turn has ended before the test does: until it has, its stand-ins
  // still write in the folder the test removes
  assert.ok(await idle(h, bot));
});

test("the Test says exactly what is missing there, and a sign-in is copied only on consent, exactly as shown", async (t) => {
  const { h, fake, bot, root, project } = await setup(t);
  const place = { kind: "docker", source: "image", image: "node:22-bookworm", name: "bloks-scout", folder: "mount", path: project };

  // an image Docker cannot find
  fake.setDocker({ containers: {}, missingImages: ["ghcr.io/nobody/nothing:1"] });
  let tested = await h.json(`/api/bots/${bot.id}/workplace/test`, { method: "POST", body: JSON.stringify({ workplace: { ...place, image: "ghcr.io/nobody/nothing:1" } }) });
  assert.equal(tested.report.ok, false);
  assert.match(tested.report.problems[0], /could not find the image ghcr\.io\/nobody\/nothing:1/);

  // an engine that is not there by that name
  fake.setDocker({ containers: {} });
  tested = await h.json(`/api/bots/${bot.id}/workplace/test`, { method: "POST", body: JSON.stringify({ workplace: { ...place, command: "claude-nightly" } }) });
  assert.ok(tested.report.problems.some((p: string) => /Claude Code is not installed in container bloks-scout/.test(p) && /docker exec -it bloks-scout/.test(p)), tested.report.problems.join(" | "));

  // installed, signed out there, with a sign-in file here
  writeFileSync(join(fake.home, ".signed-out"), "1");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", ".credentials.json"), '{"claudeAiOauth":"here-only"}');
  tested = await h.json(`/api/bots/${bot.id}/workplace/test`, { method: "POST", body: JSON.stringify({ workplace: place }) });
  assert.equal(tested.report.checks.find((c: any) => c.id === "engine").ok, true);
  assert.equal(tested.report.checks.find((c: any) => c.id === "signedIn").ok, false);
  assert.equal(tested.report.signIn.command, "docker exec -it bloks-scout sh -lc 'claude'");
  assert.equal(tested.report.canCopySignIn, true);

  // a turn never copies it
  assert.equal((await putPlace(h, bot.id, place)).status, 200);
  assert.ok(!existsSync(join(fake.home, ".claude", ".credentials.json")));

  // the plan names the file, both ends, and what it means
  const asked = await h.json(`/api/bots/${bot.id}/workplace/sign-in-copy`);
  assert.equal(asked.possible, true, JSON.stringify(asked));
  assert.deepEqual(asked.plan.files.map((f: any) => [f.from, f.to]), [["~/.claude/.credentials.json", `${fake.home}/.claude/.credentials.json`]]);
  assert.match(asked.plan.says, /anyone who can use container bloks-scout can then use it as you/);
  // not without consent, and not for a plan that is not the one shown
  assert.equal((await h.fetch(`/api/bots/${bot.id}/workplace/sign-in-copy`, { method: "POST", body: JSON.stringify({ fingerprint: asked.plan.fingerprint }) })).status, 400);
  assert.equal((await h.fetch(`/api/bots/${bot.id}/workplace/sign-in-copy`, { method: "POST", body: JSON.stringify({ consent: true, fingerprint: "0".repeat(24) }) })).status, 409);
  assert.ok(!existsSync(join(fake.home, ".claude", ".credentials.json")));
  const copied = await h.fetch(`/api/bots/${bot.id}/workplace/sign-in-copy`, { method: "POST", body: JSON.stringify({ consent: true, fingerprint: asked.plan.fingerprint }) });
  assert.equal(copied.status, 200, await copied.clone().text());
  const landed = join(fake.home, ".claude", ".credentials.json");
  assert.equal(readFileSync(landed, "utf8"), '{"claudeAiOauth":"here-only"}');
  assert.equal(statSync(landed).mode & 0o777, 0o600);
  // and it never rode a command line
  assert.ok(!allArgs(fake).includes("here-only"));
  const view = await h.json(`/api/bots/${bot.id}/workplace`);
  assert.equal(view.seen.copied.length, 1);
});

test("where an agent works is the owner's to set, for an engine that can work there, and its container only Bloks' own to remove", async (t) => {
  const { h, fake, bot, project } = await setup(t);
  // from a website, never
  const forged = await h.fetchAs("https://evil.example", `/api/bots/${bot.id}/workplace`, { method: "PUT", body: JSON.stringify({ workplace: null }) });
  assert.equal(forged.status, 403);
  // a host that is an option is not a host
  const injected = await putPlace(h, bot.id, { kind: "ssh", host: "-oProxyCommand=touch /tmp/pwned", path: "~" });
  assert.equal(injected.status, 400);

  // a container with that name that Bloks did not make is never touched
  fake.setDocker({ containers: { "bloks-scout": { running: true, labels: {} } } });
  assert.equal((await putPlace(h, bot.id, { kind: "docker", source: "image", image: "node:22-bookworm", name: "bloks-scout", folder: "mount", path: project })).status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Go." }) });
  const notice = await waitFor(async () => (await messagesOf(h, bot)).find((m) => m.kind === "notice" && /Bloks did not make it/.test(m.text ?? "")));
  assert.ok(notice, "a container that is not Bloks' was used or changed");
  assert.ok(!fake.dockerCalls().some((args) => args[0] === "rm" || args[0] === "run"));
  await idle(h, bot);
  assert.equal((await h.fetch(`/api/bots/${bot.id}/workplace/remove`, { method: "POST", body: "{}" })).status, 200);
  assert.ok(fake.docker().containers["bloks-scout"], "removed a container Bloks did not make");

  // a container of the person's that is stopped is said so
  fake.setDocker({ containers: { mine: { running: false, labels: {} } } });
  assert.equal((await putPlace(h, bot.id, { kind: "docker", source: "container", name: "mine", path: project })).status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Go on." }) });
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).some((m) => m.kind === "notice" && /mine is not running\. Start it with docker start mine/.test(m.text ?? ""))));
  await idle(h, bot);

  // an engine that runs no program of its own cannot be moved anywhere
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: "http://127.0.0.1:9" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const api = await putPlace(h, bot.id, { kind: "ssh", host: "build-box", path: "~" });
  assert.equal(api.status, 409);
  assert.match((await api.json()).error, /runs no program of its own/);
  const view = await h.json(`/api/bots/${bot.id}/workplace`);
  assert.equal(view.support.ok, false);
  // and one already set there says why at the next message
  const turn = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hi." }) });
  const said = JSON.stringify(await turn.json()) + JSON.stringify((await messagesOf(h, bot)).slice(-3));
  assert.match(said, /is set to work in container mine/);
});

test("Docker that is not installed is said so, plainly", async (t) => {
  // only the fake tools on the path: a CI runner has a real Docker in
  // /usr/bin, and this is about a computer that has none
  const { h, fake, bot, project } = await setup(t, (f) => `${f.bin}:${f.there}`);
  rmSync(join(fake.bin, "docker"));
  const tested = await h.json(`/api/bots/${bot.id}/workplace/test`, {
    method: "POST",
    body: JSON.stringify({ workplace: { kind: "docker", source: "image", image: "node:22-bookworm", name: "bloks-scout", path: project } }),
  });
  assert.equal(tested.report.ok, false);
  assert.match(tested.report.problems[0], /Docker is not installed on this computer/);
});
