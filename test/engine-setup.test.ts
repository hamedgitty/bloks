// Setting an engine up from the app (server/engine-setup.ts).
//
// The real installers download from the internet, so these tests never
// run one. What they pin down is what makes setup stop failing on a stock
// Mac: nothing asks for an admin password, npm installs land in the
// person's own folder, a failure comes back as the step that fixes it,
// and only a window on this computer may start any of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { installCommand } from "../server/engine-commands.ts";
import { ENGINE_SETUP, engineSetupView, explainInstallFailure, installEngine, runSetupScript } from "../server/engine-setup.ts";
import { ENGINE_PACKAGES } from "../server/engine-updates.ts";
import { CLI_PROVIDERS } from "../server/providers.ts";
import { installFor } from "../server/workplace.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

describe("engine setup", () => {
  test("onboarding offers every built-in CLI engine with an installer", () => {
    const source = readFileSync(new URL("../src/components/Onboarding.tsx", import.meta.url), "utf8");
    const cards = source.match(/const ENGINES:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
    assert.ok(cards, "the onboarding engine cards must be present");
    const offered = new Set([...cards.matchAll(/kind:\s*"([^"]+)"/g)].map((match) => match[1]));
    assert.deepEqual(CLI_PROVIDERS.filter((entry) => !offered.has(entry.kind)).map((entry) => entry.kind), [], "a supported CLI is missing from onboarding");
    assert.deepEqual(CLI_PROVIDERS.filter((entry) => !ENGINE_SETUP[entry.kind]?.install).map((entry) => entry.kind), [], "an onboarding CLI has no installer");
  });

  test("no installer needs sudo, and npm ones install into the person's own folder", () => {
    for (const [kind, setup] of Object.entries(ENGINE_SETUP)) {
      assert.equal(/\bsudo\b/.test(setup.install), false, `${kind} asks for an admin password`);
      if (/npm install/.test(setup.install)) {
        assert.match(setup.install, /--prefix "\$HOME\/\.local"/, `${kind} writes to npm's global folder`);
        assert.match(setup.install, /BLOKS_NEEDS_NODE/, `${kind} does not say when Node is missing`);
      }
    }
  });

  test("a failed install says what to do next", () => {
    assert.match(explainInstallFailure("BLOKS_NEEDS_NODE\n", 3), /Node\.js/);
    assert.match(explainInstallFailure("npm ERR! code EACCES", 243), /not allowed to write/);
    assert.match(explainInstallFailure("curl: (6) Could not resolve host: claude.ai", 6), /internet/);
    assert.match(explainInstallFailure("", null), /too long/);
    assert.match(explainInstallFailure("something else", 9), /exit 9/);
  });

  test("an install runs in a shell and reports how it went", { skip: process.platform === "win32" }, async () => {
    ENGINE_SETUP.testOk = { install: "echo installed fine" };
    ENGINE_SETUP.testNoNode = { install: 'echo "BLOKS_NEEDS_NODE"; exit 3' };
    try {
      const ok = await installEngine("testOk");
      assert.equal(ok.ok, true);
      assert.match(ok.log, /installed fine/);
      const missing = await installEngine("testNoNode");
      assert.equal(missing.ok, false);
      assert.match(missing.problem ?? "", /Node\.js/);
      assert.equal(missing.log.includes("BLOKS_NEEDS_NODE"), false, "the marker leaked into the log shown");
    } finally {
      delete ENGINE_SETUP.testOk;
      delete ENGINE_SETUP.testNoNode;
    }
  });

  // A server started by systemd or in a container often has no SHELL at
  // all, and an account's shell can be nologin. Either used to send every
  // install to /bin/zsh or to nologin, which on Linux failed with exit 1
  // and a log that said nothing.
  test("an install still finds a shell when SHELL is missing or cannot run", { skip: process.platform === "win32" }, async () => {
    const saved = process.env.SHELL;
    try {
      delete process.env.SHELL;
      const unset = await runSetupScript("echo ran without SHELL");
      assert.equal(unset.ok, true, unset.log);
      assert.match(unset.log, /ran without SHELL/);

      process.env.SHELL = "/usr/sbin/nologin";
      const nologin = await runSetupScript("echo ran past nologin");
      assert.equal(nologin.ok, true, nologin.log);
      assert.match(nologin.log, /ran past nologin/);
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });

  describe("the routes", () => {
    let h: Harness;
    before(async () => {
      h = await startHarness();
    });
    after(async () => {
      await h?.stop();
    });

    test("this computer can see what it may set up", async () => {
      const res = await h.json("/api/engines/setup");
      assert.ok(res.setup.claudeAgent.install);
      assert.ok(res.setup.codex.signIn);
    });

    test("nothing from the network may install software or open Terminal", async () => {
      for (const path of ["/api/engines/claudeAgent/install", "/api/engines/claudeAgent/signin"]) {
        const remote = await h.fetchRemote(path, { method: "POST", body: "{}" });
        assert.ok(remote.status === 401 || remote.status === 403, `${path} answered ${remote.status}`);
      }
      const read = await h.fetchRemote("/api/engines/setup", {});
      assert.ok(read.status === 401 || read.status === 403);
    });

    test("an engine it does not know is refused", async () => {
      const res = await h.fetch("/api/engines/nonsense/install", { method: "POST", body: "{}" });
      assert.equal(res.status, 404);
    });

    test("this computer is told whether the buttons run, and each engine's line is in the catalog", async () => {
      const res = await h.json("/api/engines/setup");
      assert.equal(res.runs, process.platform !== "win32");
      assert.equal(typeof res.updates, "object");
      const { providers } = await h.json("/api/providers");
      for (const { kind } of CLI_PROVIDERS) {
        assert.equal(providers.find((p: { kind: string }) => p.kind === kind)?.install, installCommand(kind), `${kind} has no line to copy`);
      }
    });
  });
});

// Windows was shown the Mac line, curl ... | bash, which a stock
// PowerShell cannot run (GitHub 438). Each engine has the line its maker
// documents for Windows, the same everywhere one is said.
describe("the line a person runs, on each kind of computer", () => {
  const posixOnly = /\|\s*(ba)?sh\b|curl |--prefix|\$HOME|~\/|command -v/;

  test("every engine has a Windows line, and none of them is a POSIX one", () => {
    for (const { kind } of CLI_PROVIDERS) {
      const windows = installCommand(kind, "win32");
      assert.ok(windows, `${kind} has no Windows line`);
      assert.doesNotMatch(windows, posixOnly, `${kind} tells Windows to run ${windows}`);
      assert.ok(installCommand(kind, "darwin"), `${kind} has no Mac line`);
      assert.equal(installCommand(kind, "linux"), installCommand(kind, "darwin"));
    }
    // each maker's own installer, where it has one
    assert.equal(installCommand("claudeAgent", "win32"), "irm https://claude.ai/install.ps1 | iex");
    assert.equal(installCommand("antigravity", "win32"), "irm https://antigravity.google/cli/install.ps1 | iex");
    assert.equal(installCommand("grokCli", "win32"), "irm https://x.ai/cli/install.ps1 | iex");
    assert.equal(installCommand("cursor", "win32"), "irm 'https://cursor.com/install?win32=true' | iex");
    assert.equal(installCommand("codex", "win32"), "npm install -g @openai/codex");
    assert.equal(installCommand("nonsense", "win32"), undefined);
  });

  test("the Mac lines say what the app runs", () => {
    for (const kind of ["claudeAgent", "antigravity", "grokCli", "cursor"]) {
      assert.equal(installCommand(kind, "darwin"), ENGINE_SETUP[kind].install, `${kind}'s line and installer disagree`);
    }
    for (const kind of ["codex", "geminiCli", "cline", "pi"]) {
      const packages = ENGINE_SETUP[kind].install.split("\n").at(-1)!.replace(/^npm install -g --prefix "\$HOME\/\.local" /, "");
      assert.ok(installCommand(kind, "darwin")!.endsWith(packages), `${kind} installs ${packages} in the app and something else by hand`);
      assert.ok(installCommand(kind, "win32")!.endsWith(packages), `${kind} installs something else on Windows`);
    }
  });

  test("a window on Windows is told it copies rather than presses, with lines to install and update", () => {
    const here = engineSetupView("darwin");
    assert.equal(here.runs, true);
    assert.equal(here.setup, ENGINE_SETUP);
    const win = engineSetupView("win32");
    assert.equal(win.runs, false);
    assert.deepEqual(Object.keys(win.setup).sort(), Object.keys(ENGINE_SETUP).sort());
    for (const [kind, entry] of Object.entries(win.setup)) {
      assert.doesNotMatch(entry.install, posixOnly, kind);
      assert.equal(entry.signIn, ENGINE_SETUP[kind].signIn, `${kind} lost its sign-in`);
    }
    assert.equal(win.updates.claudeAgent, "claude update");
    assert.equal(win.updates.opencode, "npm install -g opencode-ai@latest");
    for (const kind of Object.keys(ENGINE_PACKAGES)) {
      assert.ok(win.updates[kind], `${kind} can be updated on a Mac but is not told how on Windows`);
      assert.doesNotMatch(win.updates[kind], posixOnly);
    }
    assert.equal(win.updates.cursor, undefined, "Cursor updates itself");
  });

  test("on Windows the settings hint, the refusal and the drivers say PowerShell's line, and a workplace keeps sh's", async () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const refused = await runSetupScript("echo never runs");
      assert.equal(refused.ok, false);
      assert.match(refused.problem ?? "", /run the command below in PowerShell/);
      assert.equal(installCommand("claudeAgent"), "irm https://claude.ai/install.ps1 | iex", "the drivers' default is not this computer's");
      const { CLI_PROVIDERS: onWindows } = (await import(`../server/providers.ts?windows=${Date.now()}`)) as { CLI_PROVIDERS: typeof CLI_PROVIDERS };
      for (const p of onWindows) {
        assert.doesNotMatch(p.keyHint, posixOnly, `${p.kind} hints ${p.keyHint}`);
        assert.match(p.keyHint, /in PowerShell/);
      }
      assert.match(onWindows.find((p) => p.kind === "cline")!.keyHint, /3\.0\.68 or newer/);
      // the other side of a workplace is reached with sh whatever this is
      assert.equal(installFor("claudeAgent"), "curl -fsSL https://claude.ai/install.sh | bash");
      assert.equal(installFor("grokCli"), "curl -fsSL https://x.ai/cli/install.sh | bash");
    } finally {
      Object.defineProperty(process, "platform", saved);
    }
  });
});
