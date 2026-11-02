// Several shells per agent, the way a terminal app has tabs: how they are
// named, counted, kept in order, restarted, closed and asked about.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PER_AGENT,
  MAX_TITLE,
  TerminalLimitError,
  TerminalStore,
  cleanTitle,
  foregroundJob,
  parsePs,
  sttyArgs,
  terminalTitle,
  ttyDevice,
  type TerminalEvent,
} from "../server/terminal.ts";
import { startHarness } from "./helpers/server.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(each: () => T | null | Promise<T | null>, ms = 8_000): Promise<T | null> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const got = await each();
    if (got) return got;
    await wait(50);
  }
  return null;
}

const folder = () => mkdtempSync(join(tmpdir(), "bloks-tabs-"));
const input = (botId: string, cwd = folder()) => ({ botId, cwd, cols: 80, rows: 24, now: Date.now() });

describe("naming a tab", () => {
  test("the lowest number nobody is using", () => {
    assert.equal(terminalTitle([]), "Terminal 1");
    assert.equal(terminalTitle(["Terminal 1"]), "Terminal 2");
    // closing the middle one of three frees its number
    assert.equal(terminalTitle(["Terminal 1", "Terminal 3"]), "Terminal 2");
    // a renamed tab no longer holds its number
    assert.equal(terminalTitle(["server", "Terminal 2"]), "Terminal 1");
  });

  test("a typed name becomes one short line, and nothing is no name", () => {
    assert.equal(cleanTitle("  dev   server \n"), "dev server");
    assert.equal(cleanTitle("tab\u0007\u001b[31mred"), "tab [31mred");
    assert.equal(cleanTitle("x".repeat(200))?.length, MAX_TITLE);
    for (const empty of ["", "   ", "\n\t", 42, null, undefined, {}]) assert.equal(cleanTitle(empty), null);
  });
});

describe("what is running in a shell", () => {
  // pid ppid pgid tpgid comm, as ps prints them
  const at = (rows: string) => parsePs(rows);

  test("ps output is read a row at a time, a command with spaces intact", () => {
    const rows = at("  101     1   101   101 /usr/bin/expect\n 202 101 202 303 /Applications/Some App.app/x\nnot a row\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].command, "/Applications/Some App.app/x");
    assert.equal(rows[1].tpgid, 303);
  });

  test("a shell at its prompt holds its own terminal", () => {
    const rows = at("100 1 100 -1 expect\n200 100 200 200 /bin/zsh\n");
    assert.deepEqual(foregroundJob(rows, 100, true), { running: false });
  });

  test("a job in the foreground has the terminal, and is named", () => {
    const rows = at("100 1 100 -1 expect\n200 100 200 300 /bin/zsh\n300 200 300 300 /usr/local/bin/npm\n");
    assert.deepEqual(foregroundJob(rows, 100, true), { running: true, command: "npm" });
  });

  test("a background job or a prompt helper does not count", () => {
    const rows = at("100 1 100 -1 expect\n200 100 200 200 /bin/zsh\n400 200 400 200 sleep\n500 200 500 200 gitstatusd\n");
    assert.deepEqual(foregroundJob(rows, 100, true), { running: false });
  });

  test("without a pty any child of the shell counts", () => {
    assert.deepEqual(foregroundJob(at("200 1 200 -1 /bin/zsh\n"), 200, false), { running: false });
    assert.deepEqual(foregroundJob(at("200 1 200 -1 /bin/zsh\n300 200 200 -1 make\n"), 200, false), {
      running: true,
      command: "make",
    });
  });

  test("a shell that cannot be found is running nothing", () => {
    assert.deepEqual(foregroundJob([], 100, true), { running: false });
  });
});

describe("one agent, several shells", () => {
  test("tabs open in order, each named, and the first is what an agent's terminal means", () => {
    const store = new TerminalStore();
    try {
      const a = store.create(input("bot-a"));
      const b = store.create(input("bot-a"));
      const c = store.create(input("bot-a"));
      assert.deepEqual(store.list("bot-a").map((t) => t.title), ["Terminal 1", "Terminal 2", "Terminal 3"]);
      assert.deepEqual(store.list("bot-a").map((t) => t.id), [a.id, b.id, c.id]);
      assert.equal(new Set([a.id, b.id, c.id]).size, 3);
      assert.equal(store.get("bot-a"), a);
      assert.equal(store.get("bot-a", b.id), b);
      assert.equal(store.get("bot-a", "nope"), null);
      // another agent's tabs are its own, numbered from one
      const other = store.create(input("bot-b"));
      assert.equal(other.title, "Terminal 1");
      assert.equal(store.list("bot-a").length, 3);
      assert.equal(store.size, 4);
    } finally {
      store.closeAll();
    }
  });

  test("the older single-shell open reuses the first tab, however many there are", () => {
    const store = new TerminalStore();
    try {
      const cwd = folder();
      const first = store.create(input("bot-c", cwd));
      store.create(input("bot-c", cwd));
      assert.equal(store.open(input("bot-c", cwd)), first);
      assert.equal(store.list("bot-c").length, 2);
    } finally {
      store.closeAll();
    }
  });

  test(`no more than ${MAX_PER_AGENT} for one agent, and the refusal says so`, () => {
    const store = new TerminalStore();
    try {
      for (let i = 0; i < MAX_PER_AGENT; i++) store.create(input("bot-d"));
      assert.throws(() => store.create(input("bot-d")), (e: unknown) => e instanceof TerminalLimitError && /most/.test(e.message));
      // somebody else is not affected
      assert.ok(store.create(input("bot-e")));
      // and closing one makes room again, under the freed name
      const [, second] = store.sessions("bot-d");
      store.close("bot-d", second.id);
      assert.equal(store.create(input("bot-d")).title, "Terminal 2");
    } finally {
      store.closeAll();
    }
  });

  test("a restart keeps the tab's id, name and place, with a new shell in it", () => {
    const store = new TerminalStore();
    try {
      const [a, b, c] = [store.create(input("bot-f")), store.create(input("bot-f")), store.create(input("bot-f"))];
      store.rename("bot-f", b.id, "server");
      const fresh = store.restart("bot-f", b.id, { cwd: folder(), cols: 90, rows: 30, now: Date.now() })!;
      assert.notEqual(fresh, b);
      assert.equal(fresh.id, b.id);
      assert.equal(fresh.title, "server");
      assert.equal(b.alive, false, "the old shell was ended");
      assert.deepEqual(store.sessions("bot-f").map((s) => s.id), [a.id, b.id, c.id]);
      assert.equal(store.restart("bot-f", "missing", { cwd: folder(), cols: 80, rows: 24, now: 0 }), null);
    } finally {
      store.closeAll();
    }
  });

  test("renaming takes a clean name and refuses an empty one", () => {
    const store = new TerminalStore();
    try {
      const a = store.create(input("bot-g"));
      assert.equal(store.rename("bot-g", a.id, "  tests  ")?.title, "tests");
      assert.equal(store.rename("bot-g", a.id, "   "), null);
      assert.equal(a.title, "tests");
      assert.equal(store.rename("bot-g", "missing", "x"), null);
    } finally {
      store.closeAll();
    }
  });

  test("closing one tab ends that shell only; closing the agent ends them all", () => {
    const store = new TerminalStore();
    const [a, b] = [store.create(input("bot-h")), store.create(input("bot-h"))];
    const elsewhere = store.create(input("bot-i"));
    store.close("bot-h", a.id);
    assert.equal(a.alive, false);
    assert.equal(b.alive, true);
    assert.equal(store.get("bot-h"), b, "the next tab is now the first");
    // archiving an agent closes everything it had open
    store.create(input("bot-h"));
    store.close("bot-h");
    assert.deepEqual(store.list("bot-h"), []);
    assert.equal(b.alive, false);
    assert.equal(elsewhere.alive, true, "another agent's shell was closed with them");
    store.closeAll();
    assert.equal(store.size, 0);
  });

  test("whoever is watching an agent hears its tabs open, change and close", () => {
    const store = new TerminalStore();
    const heard: string[] = [];
    const stop = store.watch("bot-j", (event: TerminalEvent) =>
      heard.push(event.kind === "closed" ? `closed` : `${event.kind}:${event.session.title}`),
    );
    try {
      store.create(input("bot-k"));
      const a = store.create(input("bot-j"));
      store.rename("bot-j", a.id, "build");
      store.restart("bot-j", a.id, { cwd: folder(), cols: 80, rows: 24, now: Date.now() });
      store.close("bot-j", a.id);
      assert.deepEqual(heard, ["opened:Terminal 1", "renamed:build", "replaced:build", "closed"]);
      stop();
      store.create(input("bot-j"));
      assert.equal(heard.length, 4, "a listener that stopped was still told");
    } finally {
      store.closeAll();
    }
  });
});

describe("resizing from outside the shell", () => {
  test("ps's answer becomes a device, and nothing else does", () => {
    assert.equal(ttyDevice("ttys005\n"), "/dev/ttys005");
    assert.equal(ttyDevice("pts/3"), "/dev/pts/3");
    for (const none of ["", "??", "?", "../etc/passwd", "tty s1"]) assert.equal(ttyDevice(none), null, none);
  });

  test("stty names the device the way each system's stty wants", () => {
    assert.deepEqual(sttyArgs("darwin", "/dev/ttys005", 120, 40), ["-f", "/dev/ttys005", "rows", "40", "cols", "120"]);
    assert.deepEqual(sttyArgs("linux", "/dev/pts/3", 120, 40), ["-F", "/dev/pts/3", "rows", "40", "cols", "120"]);
  });
});

const hasPty = process.platform !== "win32";

describe("a real shell's foreground", { skip: hasPty ? false : "no pty on this platform" }, () => {
  test("a running command is seen, and the prompt is not", async () => {
    const store = new TerminalStore();
    const session = store.create(input("bot-l"));
    let seen = "";
    const { detach } = session.attach((chunk) => (seen += chunk.toString()));
    try {
      await until(() => (seen.length ? true : null));
      await wait(300);
      assert.equal((await session.foreground()).running, false);
      session.write("sleep 20\n");
      // the shell can hand the terminal to the new job a moment before ps
      // lists its leader: running, with no name yet, is that moment
      const busy = await until(async () => {
        const now = await session.foreground();
        return now.running && now.command ? now : null;
      });
      assert.ok(busy, "a foreground sleep was not seen");
      assert.equal(busy!.command, "sleep");
      session.write("\u0003");
      assert.ok(await until(async () => ((await session.foreground()).running ? null : true)), "still busy after ^C");
    } finally {
      detach();
      store.closeAll();
    }
    assert.deepEqual(await session.foreground(), { running: false }, "an ended shell runs nothing");
  });

  test("a resize changes the size without typing anything into the shell", async () => {
    const store = new TerminalStore();
    const session = store.create(input("bot-n"));
    // a piped shell has no size to change
    if (!session.pty) return store.closeAll();
    let seen = "";
    const { detach } = session.attach((chunk) => (seen += chunk.toString()));
    try {
      await until(() => (seen.length ? true : null));
      await wait(300);
      session.resize(132, 41);
      await wait(600);
      session.write("stty size\n");
      assert.ok(await until(() => (/41 132/.test(seen) ? true : null)), `the size did not change: ${JSON.stringify(seen.slice(-300))}`);
      assert.doesNotMatch(seen, /stty rows/, "the resize was typed where a program would read it");
    } finally {
      detach();
      store.closeAll();
    }
  });

  test("a shell that exits is news to whoever is watching the agent", async () => {
    const store = new TerminalStore();
    const heard: string[] = [];
    store.watch("bot-m", (event) => heard.push(event.kind));
    const session = store.create(input("bot-m"));
    let seen = "";
    const { detach } = session.attach((chunk) => (seen += chunk.toString()));
    try {
      await until(() => (seen.length ? true : null));
      session.write("exit\n");
      assert.ok(await until(() => (heard.includes("exited") ? true : null)), `heard ${heard.join(", ")}`);
      // still listed, so its tab can say what happened
      assert.ok(store.list("bot-m")[0].exitedAt);
    } finally {
      detach();
      store.closeAll();
    }
  });
});

// Through the server: the routes the panel uses, and the ones from before
// there were tabs, side by side.
describe("the terminal routes", () => {
  test("tabs open, list, rename, restart and close, and the old routes mean the first", async (t) => {
    const h = await startHarness();
    t.after(() => h.stop());
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Shell" }) });
    const post = (path: string, body: unknown = {}) => h.fetch(path, { method: "POST", body: JSON.stringify(body) });

    const one = (await (await post(`/api/bots/${bot.id}/terminals`, { cols: 100, rows: 30 })).json()).terminal;
    const two = (await (await post(`/api/bots/${bot.id}/terminals`, { title: "server" })).json()).terminal;
    assert.equal(one.title, "Terminal 1");
    assert.equal(one.cols, 100);
    assert.equal(two.title, "server");
    const listed = await h.json(`/api/bots/${bot.id}/terminals`);
    assert.deepEqual(listed.terminals.map((x: any) => x.id), [one.id, two.id]);
    assert.equal(listed.max, MAX_PER_AGENT);

    // the single-shell routes find the first tab rather than opening another
    assert.equal((await h.json(`/api/bots/${bot.id}/terminal`)).terminal.id, one.id);
    assert.equal((await (await post(`/api/bots/${bot.id}/terminal`)).json()).terminal.id, one.id);
    assert.equal((await post(`/api/bots/${bot.id}/terminal/input`, { data: "true\n" })).status, 200);
    assert.equal((await h.json(`/api/bots/${bot.id}/terminals`)).terminals.length, 2);

    // rename, and an empty name is refused
    const patch = (body: unknown) =>
      h.fetch(`/api/bots/${bot.id}/terminals/${two.id}`, { method: "PATCH", body: JSON.stringify(body) });
    assert.equal((await (await patch({ title: " dev " })).json()).terminal.title, "dev");
    assert.equal((await patch({ title: "" })).status, 400);

    // input, a size, busy, clear
    assert.equal((await post(`/api/bots/${bot.id}/terminals/${two.id}/input`, { data: "echo hi\n", cols: 120 })).status, 200);
    assert.equal((await post(`/api/bots/${bot.id}/terminals/${two.id}/input`, { data: "x".repeat(9_000) })).status, 413);
    const busy = await h.json(`/api/bots/${bot.id}/terminals/${two.id}/busy`);
    assert.equal(typeof busy.running, "boolean");
    assert.equal((await post(`/api/bots/${bot.id}/terminals/${two.id}/clear`)).status, 200);

    // restart keeps the tab
    const again = (await (await post(`/api/bots/${bot.id}/terminals/${two.id}/restart`)).json()).terminal;
    assert.equal(again.id, two.id);
    assert.equal(again.title, "dev");

    // close one
    assert.equal((await h.fetch(`/api/bots/${bot.id}/terminals/${one.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await h.fetch(`/api/bots/${bot.id}/terminals/${one.id}`)).status, 404);
    assert.equal((await h.json(`/api/bots/${bot.id}/terminal`)).terminal.id, two.id, "the next tab is the first now");
    assert.equal((await post(`/api/bots/${bot.id}/terminals/${one.id}/input`, { data: "x" })).status, 404);

    // nobody else's agent, and nobody off this machine
    assert.equal((await h.fetch(`/api/bots/nobody/terminals`)).status, 404);
    const remote = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", body: "{}" });
    assert.ok(remote.status === 401 || remote.status === 403, `a remote shell was offered: ${remote.status}`);
  });

  test("the cap is a refusal, and archiving the agent ends every shell", async (t) => {
    const h = await startHarness();
    t.after(() => h.stop());
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Many" }) });
    const open = () => h.fetch(`/api/bots/${bot.id}/terminals`, { method: "POST", body: "{}" });
    for (let i = 0; i < MAX_PER_AGENT; i++) assert.equal((await open()).status, 200);
    const refused = await open();
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /most/);

    assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await h.json(`/api/bots/${bot.id}/terminals`)).terminals, []);
    assert.equal((await open()).status, 409, "an archived agent was given a shell");
  });

  test("one stream carries every tab, and says when the tabs change", async (t) => {
    const h = await startHarness();
    t.after(() => h.stop());
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Stream" }) });
    const first = (await h.json(`/api/bots/${bot.id}/terminals`, { method: "POST", body: "{}" })).terminal;

    const controller = new AbortController();
    t.after(() => controller.abort());
    const res = await h.fetch(`/api/bots/${bot.id}/terminals/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    const frames: any[] = [];
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (data) frames.push(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();

    assert.ok(await until(() => frames.find((f) => f.list) ?? null), "no list on connecting");
    assert.ok(await until(() => frames.find((f) => f.id === first.id && f.hello) ?? null), "no hello for the open tab");

    const second = (await h.json(`/api/bots/${bot.id}/terminals`, { method: "POST", body: "{}" })).terminal;
    assert.ok(await until(() => frames.find((f) => f.id === second.id && f.hello) ?? null), "a new tab was not attached");
    assert.ok(await until(() => frames.find((f) => f.list?.length === 2) ?? null), "the list did not grow");

    await h.fetch(`/api/bots/${bot.id}/terminals/${second.id}/input`, {
      method: "POST",
      body: JSON.stringify({ data: "echo TAB-$((40+2))\n" }),
    });
    const said = await until(() => {
      const text = frames
        .filter((f) => f.id === second.id && f.b64)
        .map((f) => Buffer.from(f.b64, "base64").toString())
        .join("");
      return /TAB-42/.test(text) ? text : null;
    });
    assert.ok(said, "output for the second tab never arrived under its id");

    await h.fetch(`/api/bots/${bot.id}/terminals/${second.id}`, { method: "DELETE" });
    assert.ok(await until(() => frames.find((f) => f.id === second.id && f.closed) ?? null), "the close was not said");
  });
});
