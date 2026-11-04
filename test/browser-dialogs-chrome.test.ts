// A page's dialogs in the browser a server keeps for itself, on the
// Chrome installed on this machine rather than a fake one: a real alert,
// confirm, prompt and "leave this page?" from a page served here, each
// stopping an agent's step and answered the way the agent and the person
// answer them (server/server-browser.ts, server/browser-core.mjs).
//
// It starts a real headless Chrome, so it runs only when asked:
// BLOKS_REAL_CHROME=1, with a Chrome, Chromium, Brave or Edge where
// server/cdp.ts chromePath looks. test/browser-dialogs.test.ts covers the
// same ground on a fake Chrome everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromePath } from "../server/cdp.ts";
import { ServerBrowser } from "../server/server-browser.ts";

const skip = !process.env.BLOKS_REAL_CHROME ? "set BLOKS_REAL_CHROME=1 to run on this machine's Chrome" : !chromePath() ? "no Chrome on this machine" : false;

const IVY = { botId: "b_ivy", name: "Ivy" };

const FORM = `<!doctype html><title>Form</title>
<button onclick="alert('Hello there')">Alert</button>
<button onclick="document.title = confirm('Delete it?') ? 'yes' : 'no'">Confirm</button>
<button onclick="document.title = 'got ' + prompt('Your name?', 'Ada')">Prompt</button>
<a href="/elsewhere">Elsewhere</a>
<script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "unsaved"; });</script>`;

const until = async <T,>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function world() {
  const site: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/elsewhere" ? "<!doctype html><title>Elsewhere</title><p>Somewhere else</p>" : FORM);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const home = mkdtempSync(join(tmpdir(), "bloks-real-dialogs-"));
  const browser = new ServerBrowser({
    profileDir: join(home, "browser-session"),
    downloadsDir: join(home, "browser-downloads"),
    ownPorts: () => [1],
    onChange: () => {},
    stateDelayMs: 1,
    dialogMs: 1_500,
  });
  // what the page set its title to, as it stands: the tab's own title
  // follows a beat behind
  const title = async () => (await browser.browser.active!.cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value as string;
  const done = async () => {
    await browser.shutDown();
    site.close();
    // Chrome goes on writing its profile for a while on its way out
    for (let tries = 0; ; tries++) {
      try {
        rmSync(home, { recursive: true, force: true });
        return;
      } catch (error) {
        if (tries >= 60) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };
  return { browser, origin, title, done };
}

test("an alert, a confirm, a prompt and a \"leave this page?\" on a real Chrome, answered by the agent", { skip, timeout: 120_000 }, async (t) => {
  const w = await world();
  t.after(w.done);
  const opened = await w.browser.command({ action: "open", url: `${w.origin}/` }, IVY);
  assert.match(opened.text ?? "", /@e1 button "Alert"[^]*@e2 button "Confirm"[^]*@e3 button "Prompt"[^]*@e4 link "Elsewhere"/);

  // an alert: the click comes straight back with it, and the page waits
  const started = Date.now();
  const alerted = await w.browser.command({ action: "click", ref: "e1" }, IVY);
  assert.ok(Date.now() - started < 5_000, `the click came back in ${Date.now() - started}ms`);
  assert.deepEqual(alerted.dialog, { id: "d1", type: "alert", message: "Hello there", held: true });
  assert.equal((await w.browser.command({ action: "read" }, IVY)).dialog?.id, "d1", "nothing else runs meanwhile");
  assert.match((await w.browser.command({ action: "dialog", answer: "accept" }, IVY)).text ?? "", /^closed the alert\n\nForm \|/);

  // a confirm, said no to
  const confirmed = await w.browser.command({ action: "click", ref: "e2" }, IVY);
  assert.deepEqual(confirmed.dialog, { id: "d2", type: "confirm", message: "Delete it?", held: true });
  assert.match((await w.browser.command({ action: "dialog", answer: "dismiss" }, IVY)).text ?? "", /^answered Cancel to the confirm\n\nForm \|/);
  assert.equal(await w.title(), "no");

  // a prompt, with the agent's own text
  const prompted = await w.browser.command({ action: "click", ref: "e3" }, IVY);
  assert.deepEqual(prompted.dialog, { id: "d3", type: "prompt", message: "Your name?", defaultPrompt: "Ada", held: true });
  assert.match((await w.browser.command({ action: "dialog", answer: "accept", text: "Grace" }, IVY)).text ?? "", /^entered 5 characters and answered OK to the prompt\n\n/);
  assert.equal(await w.title(), "got Grace");

  // leaving: stay first, then go
  const asked = await w.browser.command({ action: "click", ref: "e4" }, IVY);
  assert.deepEqual(asked.dialog, { id: "d4", type: "beforeunload", message: "", held: true });
  assert.match((await w.browser.command({ action: "dialog", answer: "dismiss" }, IVY)).text ?? "", /^stayed on the page\n\n/);
  assert.equal(w.browser.state().tabs[0]?.url, `${w.origin}/`);
  await w.browser.command({ action: "snapshot" }, IVY);
  const again = await w.browser.command({ action: "click", ref: "e4" }, IVY);
  assert.equal(again.dialog?.type, "beforeunload");
  const left = await w.browser.command({ action: "dialog", answer: "accept" }, IVY);
  assert.match(left.text ?? "", /^left the page\n\nElsewhere \|/);
  await until(() => w.browser.state().tabs[0]?.url === `${w.origin}/elsewhere`);
});

test("on a real Chrome: an agent's open the page asks about, a dialog nobody answers, and the person's answer in the panel", { skip, timeout: 120_000 }, async (t) => {
  const w = await world();
  t.after(w.done);
  await w.browser.command({ action: "open", url: `${w.origin}/` }, IVY);
  // a click is what lets a page ask before it is left
  await w.browser.command({ action: "click", ref: "e2" }, IVY);
  await w.browser.command({ action: "dialog", answer: "accept" }, IVY);

  const opening = await w.browser.command({ action: "open", url: `${w.origin}/elsewhere` }, IVY);
  assert.equal(opening.dialog?.type, "beforeunload", "an address the agent opens waits on the page's question too");
  assert.match((await w.browser.command({ action: "dialog", answer: "accept" }, IVY)).text ?? "", /^left the page\n\nElsewhere \|/);

  // nobody answers: a no, in a while, and the agent hears of it
  await w.browser.command({ action: "open", url: `${w.origin}/` }, IVY);
  const confirmed = await w.browser.command({ action: "click", ref: "e2" }, IVY);
  assert.equal(confirmed.dialog?.type, "confirm");
  await until(() => !w.browser.state().tabs[0]?.dialog);
  const next = await w.browser.command({ action: "snapshot" }, IVY);
  assert.deepEqual(next.dialogNotes, [{ tab: "t1", type: "confirm", message: "Delete it?", how: "timeout" }]);
  assert.equal(await w.title(), "no", "dismissed, never accepted");

  // the person: their own click on the picture, and their answer in the bar
  w.browser.browser.takeOver();
  const tab = w.browser.browser.active!;
  const box = await tab.cdp("Runtime.evaluate", {
    expression: `(() => { const b = [...document.querySelectorAll("button")][1].getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
    returnByValue: true,
  });
  const [x, y] = box.result.value as [number, number];
  const started = Date.now();
  const sent = await w.browser.input([
    { t: "mouse", type: "down", x, y, button: "left", buttons: 1, clicks: 1, mods: 0 },
    { t: "mouse", type: "up", x, y, button: "left", buttons: 0, clicks: 1, mods: 0 },
  ]);
  assert.ok(sent.ok && Date.now() - started < 5_000, "the person's click did not sit on the dialog");
  const shown = await until(() => w.browser.state().tabs[0]?.dialog);
  assert.deepEqual(shown, { id: "d4", type: "confirm", message: "Delete it?" });
  await new Promise((r) => setTimeout(r, 2_000));
  assert.ok(w.browser.state().tabs[0]?.dialog, "a dialog in front of the person waits for them");
  assert.deepEqual(await w.browser.person("answerDialog", { id: "d4", accept: true }), { ok: true });
  await until(() => !w.browser.state().tabs[0]?.dialog);
  await until(async () => (await w.title()) === "yes");
});
