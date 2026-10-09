// Watchers: a folder, a page or a feed, and a turn when it changes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  cleanWatcher,
  describeFolderChanges,
  folderChanges,
  folderSnapshot,
  mayFire,
  newLines,
  pageText,
  parseFeed,
  watcherTurn,
} from "../server/watchers.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

describe("what changed", () => {
  test("a folder: new, changed and removed files, skipping the noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-watch-"));
    try {
      writeFileSync(join(dir, "a.txt"), "one");
      writeFileSync(join(dir, ".hidden"), "x");
      const before = folderSnapshot(dir);
      assert.deepEqual(Object.keys(before), ["a.txt"]);
      writeFileSync(join(dir, "a.txt"), "one and more");
      writeFileSync(join(dir, "invoice-march.pdf"), "pdf");
      const after = folderSnapshot(dir);
      const changes = folderChanges(before, after);
      assert.deepEqual(changes, { added: ["invoice-march.pdf"], removed: [], changed: ["a.txt"] });
      assert.equal(describeFolderChanges(changes), "New: invoice-march.pdf\nChanged: a.txt");
      assert.equal(describeFolderChanges(folderChanges(after, after)), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page: the words on it, and which lines are new", () => {
    const html = "<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Pricing</h1><p>Pro &amp; Team: $450</p></body></html>";
    assert.equal(pageText(html), "Pricing\nPro & Team: $450");
    assert.deepEqual(newLines("Pricing\nPro & Team: $450", "Pricing\nPro & Team: $390\nNew plan!"), ["Pro & Team: $390", "New plan!"]);
  });

  test("a feed: RSS items and Atom entries", () => {
    const rss = `<rss><channel><item><title><![CDATA[Launch day]]></title><link>https://b.dev/1</link><guid>g1</guid></item><item><title>Second</title><guid>g2</guid></item></channel></rss>`;
    assert.deepEqual(parseFeed(rss), [
      { id: "g1", title: "Launch day", link: "https://b.dev/1" },
      { id: "g2", title: "Second" },
    ]);
    const atom = `<feed><entry><title>v2.3</title><link href="https://gh.com/r/v2.3"/><id>tag:1</id></entry></feed>`;
    assert.deepEqual(parseFeed(atom), [{ id: "tag:1", title: "v2.3", link: "https://gh.com/r/v2.3" }]);
  });
});

describe("the rules", () => {
  test("a watcher is a kind, an address, an agent and an instruction", () => {
    const ok = (id: string) => id === "b1";
    assert.equal(cleanWatcher({ kind: "page", target: "ftp://x", botId: "b1", instruction: "x" }, ok).ok, false);
    assert.equal(cleanWatcher({ kind: "folder", target: "relative/path", botId: "b1", instruction: "x" }, ok).ok, false);
    assert.equal(cleanWatcher({ kind: "page", target: "https://x.y", botId: "nobody", instruction: "x" }, ok).ok, false);
    assert.equal(cleanWatcher({ kind: "page", target: "https://x.y", botId: "b1", instruction: "" }, ok).ok, false);
    const made = cleanWatcher({ kind: "page", target: "https://x.y/pricing", botId: "b1", instruction: "Tell me", every: 1, mode: "rehearse" }, ok);
    assert.ok(made.ok);
    if (made.ok) {
      assert.equal(made.value.every, 5, "never more often than every five minutes");
      assert.equal(made.value.name, "pricing");
      assert.equal(made.value.mode, "rehearse");
    }
  });

  test("six turns an hour at most", () => {
    const now = 10_000_000;
    const fires = Array.from({ length: 6 }, (_, i) => ({ at: now - i * 60_000, summary: "" }));
    assert.equal(mayFire({ fires }, now), false);
    assert.equal(mayFire({ fires: fires.slice(0, 5) }, now), true);
    assert.equal(mayFire({ fires: fires.map((f) => ({ ...f, at: f.at - 3_600_000 })) }, now), true);
  });

  test("the agent is told what changed and what it was asked, and may decline", () => {
    const said = watcherTurn({ kind: "folder", target: "/tmp/in", instruction: "File invoices.", name: "Invoices" }, "New: a.pdf");
    assert.match(said, /watcher "Invoices" noticed a change in the folder \/tmp\/in/);
    assert.match(said, /New: a\.pdf/);
    assert.match(said, /File invoices\./);
    assert.match(said, /say so in one line and stop/);
  });
});

describe("through the server", () => {
  let h: Harness;
  let page = "<p>Price: $450</p>";
  const heard: string[] = [];
  let pageUrl = "";
  let closeAll = () => {};
  before(async () => {
    h = await startHarness();
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        const messages = JSON.parse(body).messages ?? [];
        heard.push(String(messages[messages.length - 1]?.content ?? ""));
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "On it." } }] }));
      });
    });
    const site = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(site.address() as any).port}/pricing`;
    closeAll = () => {
      engine.close();
      site.close();
    };
    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
  });
  after(async () => {
    closeAll();
    await h.stop();
  });

  const waitFor = async <T,>(check: () => Promise<T | null | undefined>, ms = 15_000): Promise<T | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = await check();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  test("a folder that changes gives its agent a turn, marked as from the watcher", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-watched-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "old.txt"), "x");
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Filer" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
    const made = await h.fetch("/api/watchers", {
      method: "POST",
      body: JSON.stringify({ botId: bot.id, kind: "folder", target: dir, instruction: "File new invoices by date." }),
    });
    assert.equal(made.status, 201);
    const { watcher } = await made.json();
    // the baseline look
    await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck ? true : null));
    const quiet = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
    assert.equal(quiet.fired, false);

    writeFileSync(join(dir, "invoice-march.pdf"), "pdf");
    const fired = await h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
    assert.equal(fired.fired, true, fired.note);
    const lane = await waitFor(async () => {
      const w = (await h.json("/api/watchers")).watchers.find((x: any) => x.id === watcher.id);
      return w?.fires.length ? w : null;
    });
    assert.ok(lane);
    assert.equal(lane.fires.length, 1);
    await waitFor(async () => (heard.some((q) => q.includes("invoice-march.pdf")) ? true : null));
    assert.ok(heard.some((q) => /New: invoice-march\.pdf/.test(q) && /File new invoices by date/.test(q)));
    // in the agent's one conversation, General, and no lane of its own (GitHub 237)
    const general = bot.tasks[0].id;
    const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${general}&limit=50`);
    assert.ok(messages.some((m: any) => m.via === "watcher" && /invoice-march\.pdf/.test(m.text)));
    const { bots } = await h.json("/api/bots");
    const me = bots.find((b: any) => b.id === bot.id);
    assert.deepEqual(me.tasks.map((t: any) => t.title), ["General"]);
  });

  test("a page fires only when it mentions what it was told to look for", async () => {
    const { bots } = await h.json("/api/bots");
    const made = await h.json("/api/watchers", {
      method: "POST",
      body: JSON.stringify({ botId: bots[0].id, kind: "page", target: pageUrl, instruction: "Tell me the new price.", mentions: "$399" }),
    });
    const id = made.watcher.id;
    await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === id)?.lastCheck ? true : null));
    page = "<p>Price: $420</p>";
    assert.equal((await h.json(`/api/watchers/${id}/check`, { method: "POST" })).fired, false, "changed, but not to what matters");
    page = "<p>Price: $399</p>";
    const fired = await h.json(`/api/watchers/${id}/check`, { method: "POST" });
    assert.equal(fired.fired, true, fired.note);
    await h.fetch(`/api/watchers/${id}`, { method: "DELETE" });
    assert.ok(!(await h.json("/api/watchers")).watchers.some((w: any) => w.id === id));
  });

  test("a change found while a person holds the agent is still there after the release (GitHub 135)", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Held" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
    page = "<p>Departs 14:00</p>";
    const made = await h.json("/api/watchers", {
      method: "POST",
      body: JSON.stringify({ botId: bot.id, kind: "page", target: pageUrl, instruction: "Tell me the new time." }),
    });
    const id = made.watcher.id;
    await waitFor(async () => ((await h.json("/api/watchers")).watchers.find((w: any) => w.id === id)?.lastCheck ? true : null));
    page = "<p>Departs 15:00</p>";
    await h.json(`/api/bots/${bot.id}/wheel`, { method: "POST", body: JSON.stringify({ why: "checking something" }) });
    const whileHeld = await h.json(`/api/watchers/${id}/check`, { method: "POST" });
    assert.equal(whileHeld.fired, false);
    assert.match(whileHeld.note, /held/);
    await h.json(`/api/bots/${bot.id}/wheel`, { method: "DELETE" });
    const after = await h.json(`/api/watchers/${id}/check`, { method: "POST" });
    assert.equal(after.fired, true, `the change was used up while the agent was held: ${after.note}`);
    await waitFor(async () => (heard.some((q) => q.includes("Departs 15:00")) ? true : null));
    assert.ok(heard.some((q) => q.includes("+ Departs 15:00")));
    await h.fetch(`/api/watchers/${id}`, { method: "DELETE" });
  });
});
