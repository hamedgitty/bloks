// The agent's hands on the web.
//
// Spawned by an agent CLI as an MCP server, this publishes a small set
// of tools that act on a page through its own debugging protocol rather
// than through pixels. Compared with the computer proxy next door: that
// one is right for a native app, where the only interface is what is
// drawn. This one is right for the web, where the page will tell you
// what is on it if you ask.
//
// Everything acts on a ref from the last snapshot. That is the whole
// discipline: snapshot, then act on what it named. A click that cannot
// reach its target says what is covering it instead of clicking that.
//
// stdout carries the protocol. Nothing may ever be printed to it.
import { readJsonLines } from "./ndjson.ts";
import { DEFAULT_PORT, launch, listTargets, Session } from "./cdp.ts";
import { clickScript, focusScript, formatSnapshot, READ, SCAN } from "./page-script.ts";

const PROFILE = process.env.BLOKS_BROWSER_PROFILE ?? "";
const PORT = Number(process.env.BLOKS_BROWSER_PORT || DEFAULT_PORT);

const emit = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

const say = (id: unknown, text: string, isError = false) =>
  emit({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });

// ── the page we are on ─────────────────────────────────────────────────

let session: Session | null = null;
let attachedTo = "";

/** The page an agent means: the one it last used, or the newest open. */
async function page(): Promise<Session> {
  if (session && attachedTo) return session;
  if (PROFILE) await launch(PROFILE, PORT);
  const targets = await listTargets(PORT);
  if (!targets.length) throw new Error("no page open. Use open with a URL first");
  const target = targets[targets.length - 1];
  const next = new Session(target.webSocketDebuggerUrl);
  await next.open();
  session = next;
  attachedTo = target.id;
  return next;
}

function drop() {
  session?.close();
  session = null;
  attachedTo = "";
}

/** Wait for the page to stop changing, roughly. A load event is not
 * enough on anything modern, and a fixed sleep is either too slow or
 * too short, so this settles on the document being ready and the DOM
 * holding still for a moment. */
async function settle(active: Session) {
  await active
    .evaluate(
      `new Promise((done) => {
        const ready = () => document.readyState === "complete" || document.readyState === "interactive";
        let quiet;
        const observer = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(finish, 250);
        });
        const finish = () => { observer.disconnect(); done(true); };
        if (!ready()) window.addEventListener("DOMContentLoaded", () => {}, { once: true });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        quiet = setTimeout(finish, 250);
        setTimeout(finish, 4000);
      })`,
    )
    .catch(() => {});
}

// ── the tools ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "browser_open",
    description:
      "Open a URL in the agent's browser and return a snapshot of the page. Use this first. " +
      "For reading a public page with no sign-in and no interaction, fetch it instead; this is for pages that need a session, a click, or JavaScript.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "the page to open" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "List every control on the current page with a @ref for each. Take a fresh one after anything changes the page; refs from an older snapshot are not valid.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description:
      "Click a control by its @ref. If something is covering it, this says what rather than clicking that.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "a ref from the last snapshot, e.g. e12" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description: "Type into a field by its @ref. Replaces what is there unless append is true.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        append: { type: "boolean", description: "keep what is already in the field" },
        enter: { type: "boolean", description: "press Enter afterwards" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_read",
    description:
      "The current page as plain text, for reading rather than acting. Prefer this over a screenshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_press",
    description: "Press a key on the page, e.g. Enter, Escape, Tab, PageDown.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "A picture of the page. Only when the layout itself is the question: reading and clicking do not need one.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Keys we can name to the protocol without a full keymap. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
};

async function pressKey(active: Session, name: string) {
  const key = KEYS[name] ?? KEYS[name[0].toUpperCase() + name.slice(1)];
  if (!key) throw new Error(`unknown key ${name}. Known: ${Object.keys(KEYS).join(", ")}`);
  await active.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await active.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, keyCode: key.keyCode });
}

async function snapshotText(active: Session): Promise<string> {
  const scan = await active.evaluate<{ url: string; title: string; nodes: any[] }>(SCAN);
  return formatSnapshot(scan);
}

async function invoke(id: unknown, name: string, args: Record<string, any>) {
  switch (name) {
    case "browser_open": {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return say(id, "open needs an http or https URL", true);
      if (PROFILE) await launch(PROFILE, PORT);
      // A fresh navigation invalidates every ref, so the old attachment
      // goes with it rather than being reused against a different page.
      drop();
      const active = await page();
      await active.send("Page.enable").catch(() => {});
      await active.send("Page.navigate", { url });
      await settle(active);
      return say(id, await snapshotText(active));
    }

    case "browser_snapshot": {
      const active = await page();
      return say(id, await snapshotText(active));
    }

    case "browser_click": {
      const ref = String(args.ref ?? "").replace(/^@/, "");
      // Refs are ours, so anything that is not one is a mistake worth
      // naming rather than something to interpolate into the page.
      if (!/^[a-z0-9]{1,12}$/i.test(ref)) {
        return say(id, "click needs a ref from the last snapshot, like e12", true);
      }
      const active = await page();
      const result = await active.evaluate<any>(clickScript(ref));
      if (result?.error) return say(id, result.error, true);
      if (result?.covered) {
        return say(id, `${result.covered} is in front of @${ref}. ${result.hint}`, true);
      }
      // A real mouse event rather than element.click(), so a page that
      // listens for pointer events behaves as it would for a person.
      const { x, y } = result;
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await active.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
      await settle(active);
      return say(id, `clicked @${ref}\n\n${await snapshotText(active)}`);
    }

    case "browser_type": {
      const ref = String(args.ref ?? "").replace(/^@/, "");
      if (!/^[a-z0-9]{1,12}$/i.test(ref)) {
        return say(id, "type needs a ref from the last snapshot, like e12", true);
      }
      const text = String(args.text ?? "");
      const active = await page();
      const focused = await active.evaluate<any>(focusScript(ref, !args.append));
      if (focused?.error) return say(id, focused.error, true);
      await active.send("Input.insertText", { text });
      if (args.enter) {
        await pressKey(active, "Enter");
        await settle(active);
        return say(id, `typed into @${ref} and pressed Enter\n\n${await snapshotText(active)}`);
      }
      return say(id, `typed into @${ref}`);
    }

    case "browser_read": {
      const active = await page();
      const read = await active.evaluate<{ url: string; title: string; text: string }>(READ);
      return say(id, `${read.title} — ${read.url}\n\n${read.text}`);
    }

    case "browser_press": {
      const active = await page();
      await pressKey(active, String(args.key ?? ""));
      await settle(active);
      return say(id, `pressed ${args.key}\n\n${await snapshotText(active)}`);
    }

    case "browser_screenshot": {
      const active = await page();
      const shot = await active.send("Page.captureScreenshot", { format: "png" });
      if (!shot?.data) return say(id, "the page would not produce a screenshot", true);
      return emit({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "image", data: shot.data, mimeType: "image/png" }] },
      });
    }

    default:
      return say(id, `unknown tool ${name}`, true);
  }
}

async function dispatch(message: any) {
  switch (message.method) {
    case "initialize":
      return emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bloks-browser", version: "1" },
        },
      });

    case "tools/list":
      return emit({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });

    case "tools/call":
      try {
        return await invoke(message.id, message.params?.name, message.params?.arguments ?? {});
      } catch (error) {
        // A page that moved under us is the common case, and the agent
        // can recover from it if we say so plainly.
        drop();
        return say(message.id, `browser tool failed: ${(error as Error).message}`, true);
      }
  }

  if (String(message.method ?? "").startsWith("notifications/")) return;
  if (message.id != null) {
    emit({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
  }
}

readJsonLines(process.stdin, (message) => void dispatch(message));
process.stdin.on("end", () => {
  drop();
  process.exit(0);
});
