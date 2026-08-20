// The Local VM's pure parts: the recipe, the run flags, and the lease.
// The container runtime itself is exercised by hand and by the setup
// checklist; what a unit test can hold still is everything decided
// before a runtime is ever called.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  claimVm,
  configureVmLease,
  currentVmLease,
  releaseVm,
  vmDockerfile,
  vmRunArgs,
  BASE_IMAGE,
  IMAGE,
  CONTAINER,
} from "../server/local-vm.ts";

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
