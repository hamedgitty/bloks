// A shell in the agent's folder: how it is opened, and what survives.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  Scrollback,
  TerminalStore,
  chooseProvider,
  clampCols,
  clampRows,
  onPath,
  ptyProviders,
  resizeLine,
  shellFor,
  spawnPlan,
  worthResizing,
} from "../server/terminal.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `each` until it returns something, or gives up. */
async function until<T>(each: () => T | null, ms = 8_000): Promise<T | null> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const got = each();
    if (got) return got;
    await wait(50);
  }
  return null;
}

describe("choosing a shell", () => {
  test("the person's own login shell, where the system names one", () => {
    assert.equal(shellFor("darwin", { SHELL: "/opt/homebrew/bin/fish" }), "/opt/homebrew/bin/fish");
    assert.equal(shellFor("linux", { SHELL: "/usr/bin/zsh" }), "/usr/bin/zsh");
  });

  test("a shell that cannot run is not used", () => {
    // an account whose shell is nologin still deserves a terminal
    for (const bad of ["/usr/sbin/nologin", "/bin/false", "zsh", "", undefined]) {
      assert.equal(shellFor("darwin", { SHELL: bad }), "/bin/zsh", `${bad} should not be chosen`);
      assert.equal(shellFor("linux", { SHELL: bad }), "/bin/bash");
    }
  });

  test("Windows takes what the system says a shell is", () => {
    assert.equal(shellFor("win32", { COMSPEC: "C:\\Windows\\cmd.exe" }), "C:\\Windows\\cmd.exe");
    assert.equal(shellFor("win32", {}), "powershell.exe");
  });
});

describe("getting a terminal out of the system", () => {
  const all = (file: string) => Boolean(file);
  const none = () => false;

  test("macOS does not reach for script, because it cannot work there", () => {
    // BSD script reads the terminal settings off its own stdin and gives
    // up when that is a pipe, which is what it always is here
    assert.equal(ptyProviders("darwin")[0].name, "expect");
    assert.notEqual(ptyProviders("darwin")[1].name, "script");
    assert.equal(ptyProviders("linux")[0].name, "script");
    assert.deepEqual(ptyProviders("win32"), []);
  });

  test("the first program that is actually installed wins", () => {
    assert.equal(chooseProvider("linux", all)?.name, "script");
    assert.equal(chooseProvider("linux", (f) => f !== "script")?.name, "expect");
    assert.equal(chooseProvider("linux", (f) => f === "python3")?.name, "python");
    assert.equal(chooseProvider("linux", none), null);
    assert.equal(chooseProvider("win32", all), null);
  });

  test("with nothing to open a pty, the shell runs on its own and says so", () => {
    const plan = spawnPlan("linux", "/bin/bash", 80, 24, none);
    assert.equal(plan.file, "/bin/bash");
    assert.deepEqual(plan.args, []);
    assert.equal(plan.pty, false, "the app has to be able to tell the person");
    assert.equal(spawnPlan("win32", "powershell.exe", 80, 24, all).pty, false);
  });

  test("the size is set inside the pty before the shell starts", () => {
    // the pty comes up at whatever the default is, because the process
    // that opened it has no terminal of its own to inherit from
    for (const platform of ["darwin", "linux"] as const) {
      const plan = spawnPlan(platform, "/bin/zsh", 132, 43, all);
      const inner = plan.args.find((a) => a.includes("stty")) ?? "";
      assert.match(inner, /stty rows 43 cols 132/);
      assert.match(inner, /exec "\$BLOKS_SHELL" -i/, "the shell replaces the setup rather than following it");
    }
  });

  test("the shell's path is never pasted into anyone's scripting language", () => {
    // $SHELL is whatever the account says it is. In Tcl a bracket runs a
    // command and in Python a quote ends a string, so the path travels in
    // the environment and is expanded by /bin/sh at the far end.
    const hostile = "/bin/[exec danger];echo '";
    for (const platform of ["darwin", "linux"] as const) {
      for (const only of ["expect", "python3", "script"]) {
        const plan = spawnPlan(platform, hostile, 80, 24, (f) => f === only);
        for (const arg of plan.args) {
          assert.equal(arg.includes("danger"), false, `${only} carried the shell path into its argv`);
        }
      }
    }
  });

  test("expect's command is in the one form Tcl does not substitute in", () => {
    const plan = spawnPlan("darwin", "/bin/zsh", 80, 24, (f) => f === "expect");
    const script = plan.args[1];
    assert.match(script, /spawn -noecho \/bin\/sh -c \{stty rows 24 cols 80[^}]*\}; interact$/);
  });

  test("whatever is on PATH here, the lookup agrees with the system", () => {
    assert.equal(onPath("sh"), true);
    assert.equal(onPath("/bin/sh"), true);
    assert.equal(onPath("definitely-not-a-real-program-xyz"), false);
    assert.equal(onPath("/bin/definitely-not-real"), false);
  });
});

describe("sizes", () => {
  test("a size is clamped to something that is actually a terminal", () => {
    assert.equal(clampCols(5), MIN_COLS);
    assert.equal(clampCols(9_000), MAX_COLS);
    assert.equal(clampRows(1), MIN_ROWS);
    assert.equal(clampRows(9_000), MAX_ROWS);
    assert.equal(clampCols("nonsense"), 80);
    assert.equal(clampRows(undefined), 24);
    assert.equal(clampCols(120.4), 120);
  });

  test("a resize nobody would notice is not typed into the shell", () => {
    // the line is echoed, so it is only worth sending for a real change
    assert.equal(worthResizing({ cols: 100, rows: 30 }, { cols: 101, rows: 30 }), false);
    assert.equal(worthResizing({ cols: 100, rows: 30 }, { cols: 102, rows: 30 }), true);
    assert.equal(worthResizing({ cols: 100, rows: 30 }, { cols: 100, rows: 33 }), true);
    assert.match(resizeLine(120, 40), /^ stty rows 40 cols 120/);
    assert.equal(resizeLine(1, 1).startsWith(" "), true, "leading space keeps it out of history");
  });
});

describe("what a returning client is shown", () => {
  test("the tail is kept, the head is dropped", () => {
    const back = new Scrollback(100);
    for (let i = 0; i < 50; i++) back.push(Buffer.from("0123456789"));
    assert.ok(back.bytes <= 100 + 10, "roughly the budget, on chunk boundaries");
    assert.match(back.read().toString(), /^0123456789/);
  });

  test("one chunk bigger than the whole budget keeps its end", () => {
    const back = new Scrollback(50);
    back.push(Buffer.from("x".repeat(500) + "END"));
    assert.equal(back.bytes, 50);
    assert.match(back.read().toString(), /END$/);
  });

  test("bytes, not text: an escape sequence is never cut in half", () => {
    const back = new Scrollback(1_000_000);
    back.push(Buffer.from([0x1b, 0x5b]));
    back.push(Buffer.from([0x33, 0x31, 0x6d]));
    assert.equal(back.read().toString("binary"), "\u001b[31m");
  });
});

// A real shell, on the platforms that have one. Windows is a piped shell
// and gets no prompt, so the round trip is skipped rather than asserted
// into a false pass.
const hasPty = process.platform !== "win32";

describe("a real session", { skip: hasPty ? false : "no pty on this platform" }, () => {
  test("it opens in the folder it was given and runs what you type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    writeFileSync(join(dir, "hello.txt"), "hi");
    const store = new TerminalStore();
    const session = store.open({ botId: "bot-1", cwd: dir, cols: 100, rows: 30, now: Date.now() });

    let seen = "";
    const { detach } = session.attach((chunk) => {
      seen += chunk.toString();
    });
    try {
      await until(() => (seen.length ? true : null));
      session.write("echo BLOKS-$((6*7)) && ls\n");
      const got = await until(() => (/BLOKS-42/.test(seen) ? true : null));
      assert.ok(got, `the command never ran. saw: ${JSON.stringify(seen.slice(0, 400))}`);
      assert.match(seen, /hello\.txt/, "it is not in the folder it was given");
    } finally {
      detach();
      store.closeAll();
    }
  });

  test("closing the panel does not kill the shell, and what happened is still there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const store = new TerminalStore();
    const session = store.open({ botId: "bot-2", cwd: dir, cols: 100, rows: 30, now: Date.now() });

    let first = "";
    const a = session.attach((chunk) => {
      first += chunk.toString();
    });
    await until(() => (first.length ? true : null));
    session.write("echo REMEMBER-ME\n");
    await until(() => (/REMEMBER-ME/.test(first) ? true : null));

    // the panel closes
    a.detach();
    assert.equal(session.watchers, 0);
    assert.ok(session.idleSince > 0);
    assert.equal(session.alive, true, "the shell must outlive the panel");

    // something runs while nobody is watching
    session.write("echo WHILE-YOU-WERE-OUT\n");
    await wait(400);

    // and the panel comes back
    const b = session.attach(() => {});
    try {
      const replay = b.replay.toString();
      assert.match(replay, /REMEMBER-ME/, "the earlier session was lost");
      assert.match(replay, /WHILE-YOU-WERE-OUT/, "what happened while away was lost");
      assert.equal(session.idleSince, 0);
    } finally {
      b.detach();
      store.closeAll();
    }
  });

  test("the same agent gets the same shell back, not a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const store = new TerminalStore();
    const now = Date.now();
    const first = store.open({ botId: "bot-3", cwd: dir, cols: 80, rows: 24, now });
    const again = store.open({ botId: "bot-3", cwd: dir, cols: 80, rows: 24, now: now + 5 });
    assert.equal(again, first);
    assert.equal(again.startedAt, first.startedAt);

    // a different folder is a different terminal, so that one is replaced
    const elsewhere = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const moved = store.open({ botId: "bot-3", cwd: elsewhere, cols: 80, rows: 24, now: now + 9 });
    assert.notEqual(moved, first);
    assert.equal(moved.cwd, elsewhere);
    store.closeAll();
  });

  test("a shell that exits is replaced on the next open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const store = new TerminalStore();
    const session = store.open({ botId: "bot-4", cwd: dir, cols: 80, rows: 24, now: Date.now() });
    let seen = "";
    const { detach } = session.attach((chunk) => {
      seen += chunk.toString();
    });
    await until(() => (seen.length ? true : null));
    session.write("exit\n");
    const ended = await until(() => (session.exitedAt ? true : null));
    assert.ok(ended, "the shell never exited");
    assert.equal(session.alive, false);
    assert.match(seen, /\[the shell exited/, "the panel should say what happened");
    detach();

    const fresh = store.open({ botId: "bot-4", cwd: dir, cols: 80, rows: 24, now: Date.now() });
    assert.notEqual(fresh, session);
    assert.equal(fresh.alive, true);
    store.closeAll();
  });

  test("closing it for real ends the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const store = new TerminalStore();
    const session = store.open({ botId: "bot-5", cwd: dir, cols: 80, rows: 24, now: Date.now() });
    await until(() => (session.alive ? true : null));
    store.close("bot-5");
    assert.equal(store.get("bot-5"), null);
    assert.equal(session.alive, false);
  });
});

describe("the store's housekeeping", () => {
  test("a session nobody has watched for long enough is swept", () => {
    const store = new TerminalStore();
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const session = store.open({ botId: "bot-6", cwd: dir, cols: 80, rows: 24, now: 0 });
    const { detach } = session.attach(() => {});
    detach();
    session.idleSince = 1;
    store.sweep(1 + 9 * 60 * 60 * 1000);
    assert.equal(store.get("bot-6"), null);
  });

  test("a session somebody is watching is left alone", () => {
    const store = new TerminalStore();
    const dir = mkdtempSync(join(tmpdir(), "bloks-term-"));
    const session = store.open({ botId: "bot-7", cwd: dir, cols: 80, rows: 24, now: 0 });
    const { detach } = session.attach(() => {});
    store.sweep(Date.now() + 30 * 24 * 60 * 60 * 1000);
    assert.ok(store.get("bot-7"), "a watched shell was swept out from under someone");
    detach();
    store.closeAll();
  });
});
