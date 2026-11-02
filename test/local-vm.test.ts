// The Local VM's pure parts: the recipe, the run flags, and the lease.
// The container runtime itself is exercised by hand and by the setup
// checklist; what a unit test can hold still is everything decided
// before a runtime is ever called.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { describe, test } from "node:test";

import {
  claimVm,
  configureVmLease,
  currentVmLease,
  releaseVm,
  desktopService,
  desktopServiceDockerfile,
  serviceStatus,
  vmDockerfile,
  DRIVER_VERSION,
  vmRunArgs,
  BASE_IMAGE,
  IMAGE,
  CONTAINER,
  type VmStatus,
} from "../server/local-vm.ts";
import { desktopRequest, viewerUrl, DesktopTickets, DESKTOP_PATH, VM_DESKTOP_PATH } from "../server/hosted.ts";

describe("the Local VM image recipe", () => {
  test("pins everything that matters", () => {
    const dockerfile = vmDockerfile();
    assert.ok(dockerfile.startsWith(`FROM ${BASE_IMAGE}`), "base is digest-pinned");
    assert.match(dockerfile, /sha256sum -c -/, "the driver wheel is checksum-verified");
    assert.match(dockerfile, /cua-driver 0\.20\.0/, "the driver version is asserted at build");
    assert.match(dockerfile, /aarch64\|arm64/, "both architectures are handled");
    assert.match(dockerfile, /unsupported architecture/, "anything else fails loudly");
    assert.match(dockerfile, /supervisord\.conf/, "the driver runs under the supervisor");
    assert.match(dockerfile, /dev\.bloks\.vm="1"/, "the image is labeled as ours");
  });
});

describe("the Local VM run invocation", () => {
  test("is hardened, loopback-only, and single-mount", () => {
    const args = vmRunArgs("docker", "pw");
    const joined = args.join(" ");
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /--memory 4g/);
    assert.match(joined, /--pids-limit 512/);
    assert.match(joined, /-p 127\.0\.0\.1:6080:6901/, "the viewer binds loopback only");
    assert.equal(args.filter((a) => a === "--mount").length, 1, "exactly one mount");
    assert.equal(args[args.length - 1], IMAGE);
    assert.ok(args.includes(CONTAINER));
  });

  test("skips the flags Apple's container CLI does not take", () => {
    const joined = vmRunArgs("container", "pw").join(" ");
    assert.doesNotMatch(joined, /--memory-swap/);
    assert.doesNotMatch(joined, /--pids-limit/);
    assert.doesNotMatch(joined, /--hostname/);
  });

  test("podman gets the rootless mount options", () => {
    const joined = vmRunArgs("podman", "pw").join(" ");
    assert.match(joined, /relabel=private,U=true/);
  });
});

describe("the Local VM lease", () => {
  test("one thread at a time, and it dies with the turn", () => {
    const busy = new Set<string>(["t1"]);
    configureVmLease((threadId) => busy.has(threadId));

    assert.equal(claimVm("t1", "bot-a"), true);
    assert.equal(claimVm("t2", "bot-b"), false, "a second thread is refused");
    assert.equal(claimVm("t1", "bot-a"), true, "the holder may re-claim");
    assert.equal(currentVmLease()?.threadId, "t1");

    // the turn settles; the lease self-invalidates on the next look
    busy.delete("t1");
    assert.equal(currentVmLease(), null);
    assert.equal(claimVm("t2", "bot-b"), true, "the line is open again");
    releaseVm("t2");
    assert.equal(currentVmLease(), null);
  });
});

// ── the desktop beside Bloks, on a server run with Docker ──

/** A stand-in for the desktop service: answers each question as told, or
 * not at all for one it was not given. */
async function fakeService(answers: Record<string, { ok: boolean; stdout?: string; stderr?: string }>): Promise<{ server: Server; port: number; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (line) => {
      const op = JSON.parse(String(line)).op as string;
      asked.push(op);
      const answer = answers[op] ?? { ok: false, stderr: "not something this desktop answers" };
      socket.end(JSON.stringify({ stdout: "", stderr: "", ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, asked };
}

const blank = (): VmStatus => ({
  runtime: null, daemonUp: false, imageReady: false, container: "missing", desktopReady: false, problem: null,
  ready: false, viewerUrl: null, service: false, workspace: "", imageRef: "", baseRef: "", driverVersion: DRIVER_VERSION,
});

describe("the desktop beside Bloks", () => {
  test("is named as a neighbour on the network, never as an address elsewhere", () => {
    assert.deepEqual(desktopService("desktop"), { host: "desktop", port: 7301, viewerPort: 6901 });
    assert.deepEqual(desktopService(" Desktop:7400 "), { host: "desktop", port: 7400, viewerPort: 6901 });
    for (const bad of ["", "http://desktop", "desktop/x", "desktop:0", "desktop:99999", "-desktop", "a b"]) {
      assert.equal(desktopService(bad), null, bad);
    }
  });

  test("its recipe is the Local VM's, plus the service and nothing that reaches a shell", () => {
    const recipe = desktopServiceDockerfile();
    assert.ok(recipe.startsWith("# syntax=docker/dockerfile:1\n"), "heredocs need the syntax line first");
    assert.ok(recipe.includes(vmDockerfile()), "the same pins as the Local VM");
    assert.match(recipe, /EXPOSE 7301/);
    assert.match(recipe, /CMD \["\/usr\/local\/bin\/bloks-desktop-start\.sh"\]/);
    assert.match(recipe, /user=cua/, "the service runs as the desktop's account, not root");
    assert.doesNotMatch(recipe, /shell=True/, "nothing it runs goes through a shell");
    for (const op of ["version", "health", "log", "password", "screenshot", "mcp"]) assert.match(recipe, new RegExp(`"${op}"`), op);
  });

  test("docker/desktop/Dockerfile is the recipe, written out", () => {
    const written = readFileSync(new URL("../docker/desktop/Dockerfile", import.meta.url), "utf8");
    assert.equal(written, desktopServiceDockerfile(), "run the line in docker/desktop/README.md to write it again");
  });

  test("not running says how to turn it on", async () => {
    const { server, port } = await fakeService({});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const status = await serviceStatus(blank(), { host: "127.0.0.1", port, viewerPort: 6901 });
    assert.equal(status.ready, false);
    assert.equal(status.service, true);
    assert.equal(status.daemonUp, false);
    assert.match(status.problem ?? "", /COMPOSE_PROFILES=desktop/);
  });

  test("a driver from another Bloks says to pull, and asks nothing further", async () => {
    const fake = await fakeService({ version: { ok: true, stdout: "cua-driver 0.0.1\n" } });
    try {
      const status = await serviceStatus(blank(), { host: "127.0.0.1", port: fake.port, viewerPort: 6901 });
      assert.equal(status.ready, false);
      assert.equal(status.daemonUp, true);
      assert.match(status.problem ?? "", /docker compose pull/);
      assert.deepEqual(fake.asked, ["version"]);
    } finally {
      fake.server.close();
    }
  });

  test("a driver that is not up yet says its own last words, without their colours", async () => {
    const fake = await fakeService({
      version: { ok: true, stdout: `cua-driver ${DRIVER_VERSION}\n` },
      health: { ok: false, stderr: "no socket" },
      log: { ok: true, stdout: "\u001b[33mWARN\u001b[0m X display :1 not ready after 45s\n" },
    });
    try {
      const status = await serviceStatus(blank(), { host: "127.0.0.1", port: fake.port, viewerPort: 6901 });
      assert.equal(status.ready, false);
      assert.equal(status.problem, "WARN X display :1 not ready after 45s");
    } finally {
      fake.server.close();
    }
  });

  test("a healthy driver is ready, with its files where the desktop keeps them", async () => {
    const fake = await fakeService({
      version: { ok: true, stdout: `cua-driver ${DRIVER_VERSION}\n` },
      health: { ok: true, stdout: "{}" },
    });
    try {
      const status = await serviceStatus(blank(), { host: "127.0.0.1", port: fake.port, viewerPort: 6901 });
      assert.equal(status.ready, true);
      assert.equal(status.problem, null);
      assert.equal(status.workspace, "/home/cua/workspace");
      assert.equal(status.viewerUrl, null, "its viewer is only ever reached through Bloks");
    } finally {
      fake.server.close();
    }
  });

  test("the VM's viewer has a path and tickets of its own, so neither opens the other", () => {
    const hosted = new DesktopTickets();
    const vm = new DesktopTickets();
    const ticket = vm.mint();
    const url = viewerUrl(ticket, VM_DESKTOP_PATH);
    assert.ok(url.startsWith(`${VM_DESKTOP_PATH}${ticket}/vnc.html?`));
    assert.match(decodeURIComponent(url), new RegExp(`path=local-vm/desktop/${ticket}/websockify`));
    const asked = desktopRequest(`${VM_DESKTOP_PATH}${ticket}/vnc.html`, VM_DESKTOP_PATH);
    assert.deepEqual(asked, { ticket, rest: "vnc.html" });
    assert.equal(desktopRequest(`${VM_DESKTOP_PATH}${ticket}/vnc.html`), null, "the hosted path does not read it");
    assert.equal(desktopRequest(`${DESKTOP_PATH}${ticket}/vnc.html`, VM_DESKTOP_PATH), null);
    assert.equal(hosted.use(ticket), false, "a VM ticket is not a hosted one");
    assert.equal(vm.use(ticket), true);
    assert.equal(desktopRequest(`${VM_DESKTOP_PATH}${ticket}/../secret`, VM_DESKTOP_PATH), null);
  });
});
