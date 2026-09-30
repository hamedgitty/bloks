import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { launchSpec, onPath, resolveOnPath } from "../server/path.ts";

// npm on Windows writes three launchers per CLI: an extensionless sh
// script, a .cmd and a .ps1. Node can run none of them directly: it only
// tries .com and .exe, and a .cmd needs a shell. These tests pretend to
// be Windows, since that is where the bug lives and CI is not.
function asWindows(fn: (bin: string) => void) {
  const bin = mkdtempSync(join(tmpdir(), "bloks-winpath-"));
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, "platform")!,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    ComSpec: process.env.ComSpec,
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  // one directory, so the POSIX delimiter this runs under does not matter
  process.env.PATH = bin;
  // lower case because a Windows filesystem ignores case and this one does not
  process.env.PATHEXT = ".com;.exe;.bat;.cmd";
  process.env.ComSpec = "C:\\Windows\\system32\\cmd.exe";
  try {
    fn(bin);
  } finally {
    Object.defineProperty(process, "platform", saved.platform);
    for (const key of ["PATH", "PATHEXT", "ComSpec"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("on Windows an extensionless npm shim does not count as installed", () => {
  // Counting it made Pi show as connected while every turn failed with
  // ENOENT, reported as "not installed".
  asWindows((bin) => {
    writeFileSync(join(bin, "pi-acp"), "#!/bin/sh\n");
    assert.equal(resolveOnPath("pi-acp"), null);
    assert.equal(onPath("pi-acp"), false);
  });
});

test("on Windows an npm .cmd launcher is found and run through cmd.exe", () => {
  asWindows((bin) => {
    writeFileSync(join(bin, "pi-acp"), "#!/bin/sh\n");
    writeFileSync(join(bin, "pi-acp.cmd"), "@echo off\r\n");
    const file = join(bin, "pi-acp.cmd");
    assert.equal(resolveOnPath("pi-acp"), file);
    assert.deepEqual(launchSpec("pi-acp", ["--acp", "-m", "vendor/model-a"]), {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${file}" --acp -m vendor/model-a"`],
      windowsVerbatimArguments: true,
      viaShell: true,
    });
  });
});

test("an argument cmd.exe would interpret is refused, not passed", () => {
  asWindows((bin) => {
    writeFileSync(join(bin, "pi-acp.cmd"), "@echo off\r\n");
    for (const hostile of ["a&calc", "x|y", "%PATH%", 'q"uote', "(a)", "^b", "c>d"]) {
      assert.throws(() => launchSpec("pi-acp", [hostile]), /refusing/, hostile);
    }
  });
});

test("on Windows a real .exe is spawned directly", () => {
  asWindows((bin) => {
    writeFileSync(join(bin, "pi-acp.exe"), "");
    writeFileSync(join(bin, "pi-acp.cmd"), "@echo off\r\n");
    const spec = launchSpec("pi-acp", ["acp"]);
    assert.equal(spec.command, join(bin, "pi-acp.exe"));
    assert.deepEqual(spec.args, ["acp"]);
    assert.equal(spec.viaShell, false);
  });
});

test("macOS and Linux spawn the name unchanged", () => {
  if (process.platform === "win32") return;
  assert.deepEqual(launchSpec("pi-acp", ["a&b"]), { command: "pi-acp", args: ["a&b"], viaShell: false });
});
