// Finding the CLIs when the app was opened from Finder. The desktop app
// asks the login shell for its PATH (electron/shell-path.mjs) and used to
// throw the answer away when the shell was slow, or exited non-zero after
// printing it. Now it is read between markers and kept when it is there,
// asked once more in the background after a timeout, and handed to the
// servers already running. The fixed list in server/path.ts, all that
// bloks-server under systemd has, knows the other toolchains' folders.
// No shell is started here and no Electron: the pure parts, and a fake
// home for the folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { PATH_END, PATH_SCRIPT, PATH_START, askLoginShell, cutOff, mergePath, readShellPath } from "../electron/shell-path.mjs";
import { adoptPath, candidateDirs, widenPath } from "../server/path.ts";

const said = (path: string) => `${PATH_START}${path}${PATH_END}`;

test("the PATH is read from between the markers, whatever came around it", () => {
  assert.equal(readShellPath(`\n${said("/opt/homebrew/bin:/usr/bin")}\n`), "/opt/homebrew/bin:/usr/bin");
  // a profile's banner, a motd, an nvm notice, all ahead of it
  assert.equal(
    readShellPath(`Welcome back!\nnvm: using node v22\n\u001b[32mready\u001b[0m\n${said("/Users/sam/.nvm/versions/node/v22/bin:/usr/bin")}\nbye\n`),
    "/Users/sam/.nvm/versions/node/v22/bin:/usr/bin",
  );
  // a Buffer, as execFile hands back with an encoding of its own
  assert.equal(readShellPath(Buffer.from(said("/usr/local/bin"))), "/usr/local/bin");
  // the last pair is the answer: a profile that echoes the same thing loses
  assert.equal(readShellPath(`${said("/early")}\n${said("/late/bin:/usr/bin")}`), "/late/bin:/usr/bin");
  // folders only, each once; a relative entry is not a place to look
  assert.equal(readShellPath(said("/usr/bin::.:bin:/usr/bin:/opt/x/bin")), "/usr/bin:/opt/x/bin");
});

test("garbage is nothing to keep", () => {
  for (const output of [
    "",
    "/usr/bin:/bin\n",
    PATH_START,
    `${PATH_END}${PATH_START}/usr/bin`,
    said(""),
    said("relative:also/relative"),
    `${PATH_START}/usr/bin\n/bin${PATH_END}`,
    null,
    undefined,
    42,
  ]) {
    assert.equal(readShellPath(output), null, JSON.stringify(output));
  }
});

test("the shell is asked to print its PATH between the markers, on a line of its own", () => {
  assert.ok(PATH_SCRIPT.includes(PATH_START) && PATH_SCRIPT.includes(PATH_END) && PATH_SCRIPT.includes('"$PATH"'));
  assert.match(PATH_SCRIPT, /^printf '\\n%s%s%s\\n'/);
});

/** execFile, as the test says it went. */
function ran(error: any, stdout: string) {
  const calls: Array<{ file: string; args: string[]; options: { timeout: number } }> = [];
  const run = (file: string, args: string[], options: { timeout: number; maxBuffer: number }, callback: (error: any, stdout: string, stderr: string) => void) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(error, stdout, ""));
  };
  return { run, calls };
}

test("a shell that exits non-zero after printing its PATH is believed", async () => {
  const exit = Object.assign(new Error("Command failed"), { code: 1, killed: false, signal: null });
  const { run, calls } = ran(exit, `oh-my-zsh: update check failed\n${said("/opt/homebrew/bin:/usr/bin")}\n`);
  assert.deepEqual(await askLoginShell({ shell: "/bin/zsh", run }), { path: "/opt/homebrew/bin:/usr/bin", timedOut: false });
  assert.deepEqual(calls[0].args, ["-ilc", PATH_SCRIPT]);
  assert.equal(calls[0].file, "/bin/zsh");
  assert.equal(calls[0].options.timeout, 4000);
});

test("a shell cut off by the timeout keeps what it printed, and says it ran out only when it printed nothing", async () => {
  const killed = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
  // printed, then sat in a slow exit hook until it was killed
  assert.deepEqual(await askLoginShell({ run: ran(killed, said("/usr/local/bin")).run }), { path: "/usr/local/bin", timedOut: false });
  // still reading its profile when the time ran out: ask again later
  assert.deepEqual(await askLoginShell({ run: ran(killed, "loading conda...").run, timeoutMs: 20_000 }), { path: null, timedOut: true });
  // a shell that is not there is not worth asking again
  const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  assert.deepEqual(await askLoginShell({ run: ran(missing, "").run }), { path: null, timedOut: false });
  // nor one that throws before it starts
  assert.deepEqual(await askLoginShell({ run: () => { throw new Error("EAGAIN"); } }), { path: null, timedOut: false });
  assert.equal(cutOff(null), false);
  assert.equal(cutOff({ code: "ETIMEDOUT" }), true);
});

test("the shell's folders go first, then what the process already had, each once", () => {
  assert.equal(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/sbin"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin");
  assert.equal(mergePath(null, "/usr/bin"), "/usr/bin");
});

test("the main process asks through the markers, and asks once more after a timeout", () => {
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /echo "\$PATH"/, "the old last-line read is back");
  assert.match(main, /askLoginShell\(\{ shell, timeoutMs: FIRST_ASK_MS \}\)/);
  assert.match(main, /askLoginShell\(\{ shell, timeoutMs: SECOND_ASK_MS \}\)/);
  assert.match(main, /postMessage\(\{ kind: "path", path: process\.env\.PATH \}\)/);
});

test("a late PATH is taken by a running server: its folders first, absolute ones only", () => {
  const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(delimiter) };
  assert.equal(adoptPath(["/opt/homebrew/bin", "relative", "/usr/bin"].join(delimiter), env), true);
  assert.equal(env.PATH, ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter));
  // the same again changes nothing, and says so
  assert.equal(adoptPath("/opt/homebrew/bin", env), false);
  for (const bad of [undefined, 3, "", "relative/only", "/usr/bin\n/evil", "/x".repeat(40_000)]) {
    assert.equal(adoptPath(bad, env), false, String(bad).slice(0, 40));
  }
  assert.equal(env.PATH, ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter));
});

test("the fixed list finds the other toolchains' folders where they exist", (t) => {
  if (process.platform === "win32") return t.skip("the folders below are the Mac's and Linux's");
  const home = mkdtempSync(join(tmpdir(), "bloks-path-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const made = [
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, "go", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".asdf", "shims"),
    join(home, ".pyenv", "shims"),
  ];
  for (const dir of made) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(delimiter) };
  const added = widenPath({ home, env, platform: "darwin" });
  for (const dir of made) assert.ok(env.PATH!.split(delimiter).includes(dir), `${dir} was not added`);
  // appended, never ahead of what the environment already said
  assert.deepEqual(env.PATH!.split(delimiter).slice(0, 2), ["/usr/bin", "/bin"]);
  assert.ok(added.length >= made.length);
  // a folder that is not there is not added
  assert.ok(!env.PATH!.includes(join(home, ".volta")));
  // and a second widening adds nothing twice
  assert.deepEqual(widenPath({ home, env, platform: "darwin" }), []);
});

test("a toolchain whose variable moves it is looked for where it was moved", () => {
  const home = "/home/sam";
  const dirs = candidateDirs(home, {
    CARGO_HOME: "/opt/rust/cargo",
    BUN_INSTALL: "/opt/bun",
    GOPATH: ["/srv/go", "/other"].join(delimiter),
    GOBIN: "/srv/gobin",
    MISE_DATA_DIR: "/data/mise",
    ASDF_DATA_DIR: "/data/asdf",
    PYENV_ROOT: "/data/pyenv",
  }, "linux");
  for (const dir of ["/opt/rust/cargo/bin", "/opt/bun/bin", "/srv/gobin", "/srv/go/bin", "/data/mise/shims", "/data/asdf/shims", "/data/pyenv/shims", "/opt/local/bin", "/home/linuxbrew/.linuxbrew/bin"]) {
    assert.ok(dirs.includes(dir), dir);
  }
  // a relative one is nobody's folder: the default stands
  assert.ok(candidateDirs(home, { CARGO_HOME: "cargo" }, "linux").includes("/home/sam/.cargo/bin"));
  // and Windows has the three that install there too
  const win = candidateDirs("C:\\Users\\sam", { APPDATA: "C:\\Users\\sam\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" }, "win32");
  assert.ok(win.some((dir) => dir.includes(".cargo")) && win.some((dir) => dir.includes(".bun")) && win.some((dir) => /go[\\/]bin$/.test(dir)));
});
