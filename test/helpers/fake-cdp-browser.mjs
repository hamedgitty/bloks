#!/usr/bin/env node
// A whole Chrome, as far as server/server-browser.ts can tell, with no
// Chrome in it: one browser socket carrying page sessions (flatten), pages
// that navigate through the Fetch guard, history, pictures (screencast),
// popups, downloads, and a record of every call and input event.
//
// Two ways to use it. In a test's own process, fakeBrowser() hands back a
// line the server's browser talks to directly (its `connect`). Run as a
// program, it is a Chrome a real server starts (BLOKS_BROWSER): it takes
// --user-data-dir and --remote-debugging-port the way Chrome does, writes
// DevToolsActivePort into the profile, and speaks the same protocol over
// a WebSocket of its own (Node has no WebSocket server, so a small one is
// here). Pages it knows say what is on them; any other address is a page
// titled with its host.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const b64 = (text) => Buffer.from(String(text)).toString("base64");

const DEFAULT_PAGES = {
  "https://docs.example/": { title: "Docs", text: "Welcome to the docs", elements: [{ backendNodeId: 11, role: "link", name: "Pricing" }] },
  "https://shop.example/": { title: "Shop", text: "A shop", elements: [{ backendNodeId: 21, role: "textbox", name: "Password", nodeName: "input", attributes: { type: "password" } }] },
};

/** A fake browser. `pages` by address; `hold` makes every page wait for
 * the Fetch guard to say, as Chrome does once Fetch is on. */
export function fakeBrowser({ pages = DEFAULT_PAGES, userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36" } = {}) {
  const listeners = new Set();
  const closers = new Set();
  const targets = new Map();
  const sessions = new Map();
  const paused = new Map();
  const calls = [];
  let seq = 0;
  let autoAttach = false;
  let downloadPath = "";
  let closed = false;

  const emit = (method, params, sessionId) => {
    if (closed) return;
    for (const listener of listeners) listener(method, params, sessionId);
  };
  const info = (t) => ({ targetId: t.targetId, type: "page", url: t.url, title: t.title, attached: t.sessions.size > 0, ...(t.openerId ? { openerId: t.openerId } : {}) });
  const pageAt = (url) => {
    const known = pages[url] ?? pages[url.replace(/\/?$/, "/")];
    if (known) return known;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* about:blank */
    }
    return { title: host, text: host ? `This is ${host}` : "", elements: [] };
  };

  function makeTarget(url, openerId) {
    const targetId = `T${++seq}`;
    const target = { targetId, url, title: "", openerId, sessions: new Set(), history: [{ id: 1, url, title: "" }], at: 0, fetch: null, viewport: null, userAgent: null, cast: null, frames: 0, input: [], waiting: false, armed: null, leave: false, dialog: null, answers: [] };
    targets.set(targetId, target);
    return target;
  }

  function attach(target, waiting) {
    const sessionId = `S${++seq}`;
    sessions.set(sessionId, target.targetId);
    target.sessions.add(sessionId);
    target.waiting = waiting;
    emit("Target.attachedToTarget", { sessionId, targetInfo: info(target), waitingForDebugger: waiting });
    return sessionId;
  }

  function picture(target) {
    if (!target.cast) return;
    const sessionId = [...target.sessions][0];
    target.frames++;
    emit(
      "Page.screencastFrame",
      { data: b64(`frame ${target.frames} of ${target.url}`), sessionId: target.frames, metadata: { deviceWidth: target.viewport?.width ?? 1280, deviceHeight: target.viewport?.height ?? 800 } },
      sessionId,
    );
  }

  function commit(target, url, { push = true } = {}) {
    const page = pageAt(url);
    const sessionId = [...target.sessions][0];
    emit("Page.frameStartedLoading", { frameId: target.targetId }, sessionId);
    target.url = url;
    target.title = page.title;
    if (push) {
      target.history = target.history.slice(0, target.at + 1);
      target.history.push({ id: target.history.length + 1, url, title: page.title });
      target.at = target.history.length - 1;
    }
    emit("Page.frameNavigated", { frame: { id: target.targetId, url } }, sessionId);
    emit("Target.targetInfoChanged", { targetInfo: info(target) });
    emit("Page.frameStoppedLoading", { frameId: target.targetId }, sessionId);
    picture(target);
  }

  /** Through the guard when Fetch is on, the way a document goes. */
  function go(target, url, options) {
    const sessionId = [...target.sessions][0];
    if (!target.fetch || url === "about:blank") {
      commit(target, url, options);
      return Promise.resolve({ frameId: target.targetId });
    }
    const requestId = `R${++seq}`;
    return new Promise((resolve) => {
      paused.set(requestId, (verdict) => {
        if (verdict.go) {
          commit(target, url, options);
          resolve({ frameId: target.targetId });
        } else resolve({ frameId: target.targetId, errorText: `net::ERR_${verdict.reason === "Aborted" ? "ABORTED" : "BLOCKED_BY_CLIENT"}` });
      });
      emit("Fetch.requestPaused", { requestId, request: { url, method: "GET" }, resourceType: "Document", frameId: target.targetId }, sessionId);
    });
  }

  /** A dialog the page opens, which stops it until it is answered, as a
   * real one does: the call that opened it waits for the answer, and so
   * does every call into the page meanwhile. */
  function openDialog(target, said) {
    const sessionId = [...target.sessions][0];
    let answered;
    const closed = new Promise((resolve) => (answered = resolve));
    target.dialog = { ...said, closed, answered };
    emit("Page.javascriptDialogOpening", { url: target.url, frameId: target.targetId, message: said.message ?? "", type: said.type, hasBrowserHandler: true, defaultPrompt: said.defaultPrompt ?? "" }, sessionId);
    return closed;
  }

  function closeTarget(target) {
    targets.delete(target.targetId);
    for (const sessionId of target.sessions) {
      sessions.delete(sessionId);
      emit("Target.detachedFromTarget", { sessionId, targetId: target.targetId });
    }
    emit("Target.targetDestroyed", { targetId: target.targetId });
  }

  async function page(target, method, params) {
    // a page stopped on a dialog answers nothing but the browser's own
    // calls until it is answered
    if (target.dialog && !["Page.handleJavaScriptDialog", "Page.getNavigationHistory", "Page.stopScreencast", "Page.screencastFrameAck"].includes(method)) {
      await target.dialog.closed;
    }
    const known = pageAt(target.url);
    const element = (id) => known.elements.find((e) => e.backendNodeId === id);
    switch (method) {
      case "Runtime.runIfWaitingForDebugger":
        target.waiting = false;
        return {};
      case "Fetch.enable":
        target.fetch = params.patterns ?? [];
        return {};
      case "Emulation.setDeviceMetricsOverride":
        target.viewport = { width: params.width, height: params.height, scale: params.deviceScaleFactor };
        return {};
      case "Emulation.setUserAgentOverride":
        target.userAgent = params.userAgent;
        return {};
      case "Page.navigate":
        if (target.leave) {
          // a page that asks before it is left
          const { accept } = await openDialog(target, { type: "beforeunload" });
          if (!accept) return { frameId: target.targetId };
          target.leave = false;
        }
        return go(target, String(params.url));
      case "Page.handleJavaScriptDialog": {
        const dialog = target.dialog;
        if (!dialog) throw new Error("No dialog is showing");
        target.dialog = null;
        target.answers.push({ type: dialog.type, accept: params.accept, promptText: params.promptText });
        emit("Page.javascriptDialogClosed", { frameId: target.targetId, result: Boolean(params.accept), userInput: String(params.promptText ?? "") }, [...target.sessions][0]);
        dialog.answered({ accept: Boolean(params.accept) });
        return {};
      }
      case "Page.getNavigationHistory":
        return { currentIndex: target.at, entries: target.history };
      case "Page.navigateToHistoryEntry": {
        const at = target.history.findIndex((e) => e.id === params.entryId);
        if (at < 0) throw new Error("no such entry");
        target.at = at;
        return go(target, target.history[at].url, { push: false });
      }
      case "Page.startScreencast":
        target.cast = params;
        picture(target);
        return {};
      case "Page.stopScreencast":
        target.cast = null;
        return {};
      case "Page.captureScreenshot":
        return { data: b64(`shot of ${target.url}`) };
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
        target.input.push({ method, ...params });
        // a click on a page armed with a dialog opens it, and waits on it
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && target.armed) {
          const said = target.armed;
          target.armed = null;
          await openDialog(target, said);
        }
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            { nodeId: "root", role: { value: "RootWebArea" }, name: { value: known.title }, childIds: known.elements.map((e) => `n${e.backendNodeId}`), backendDOMNodeId: 1 },
            ...known.elements.map((e) => ({ nodeId: `n${e.backendNodeId}`, parentId: "root", role: { value: e.role }, name: { value: e.name }, backendDOMNodeId: e.backendNodeId })),
          ],
        };
      case "Runtime.evaluate": {
        const expression = String(params.expression);
        if (expression.includes("MutationObserver")) return { result: { value: true } };
        if (expression.includes("cloneNode")) return { result: { value: known.text ?? "" } };
        return { result: { value: true } };
      }
      case "DOM.describeNode": {
        const found = element(params.backendNodeId);
        return { node: { nodeName: (found?.nodeName ?? "a").toUpperCase(), attributes: Object.entries(found?.attributes ?? {}).flat() } };
      }
      case "DOM.resolveNode":
        return element(params.backendNodeId) ? { object: { objectId: `o${params.backendNodeId}` } } : {};
      case "DOM.getBoxModel":
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
      case "Runtime.callFunctionOn":
        return { result: { value: null } };
      default:
        return {};
    }
  }

  async function send(method, params = {}, _timeoutMs, sessionId) {
    if (closed) throw new Error("the page closed");
    calls.push({ method, params, sessionId });
    // the guard's answer, on the page's session as Chrome takes it
    if (method === "Fetch.continueRequest" || method === "Fetch.failRequest") {
      const waiting = paused.get(params.requestId);
      paused.delete(params.requestId);
      waiting?.(method === "Fetch.continueRequest" ? { go: true } : { go: false, reason: params.errorReason });
      return {};
    }
    if (sessionId) {
      const target = targets.get(sessions.get(sessionId));
      if (!target) throw new Error("No session with given id");
      return page(target, method, params);
    }
    switch (method) {
      case "Browser.getVersion":
        return { product: "HeadlessChrome/141.0.0.0", userAgent };
      case "Browser.setDownloadBehavior":
        downloadPath = String(params.downloadPath ?? "");
        return {};
      case "Target.setDiscoverTargets":
        return {};
      case "Target.setAutoAttach":
        autoAttach = Boolean(params.autoAttach);
        for (const target of targets.values()) if (target.sessions.size === 0) attach(target, false);
        return {};
      case "Target.getTargets":
        return { targetInfos: [...targets.values()].map(info) };
      case "Target.attachToTarget": {
        const target = targets.get(params.targetId);
        if (!target) throw new Error("No target with given id");
        return { sessionId: attach(target, false) };
      }
      case "Target.createTarget": {
        const target = makeTarget(String(params.url ?? "about:blank"));
        // said before the answer, as Chrome may: the server must cope
        if (autoAttach) attach(target, true);
        return { targetId: target.targetId };
      }
      case "Target.closeTarget": {
        const target = targets.get(params.targetId);
        if (target) closeTarget(target);
        return { success: Boolean(target) };
      }
      case "Target.detachFromTarget": {
        const targetId = sessions.get(params.sessionId);
        sessions.delete(params.sessionId);
        targets.get(targetId)?.sessions.delete(params.sessionId);
        return {};
      }
      case "Browser.close":
        setTimeout(() => fake.close(), 5);
        return {};
      default:
        return {};
    }
  }

  const fake = {
    calls,
    targets,
    get downloadPath() {
      return downloadPath;
    },
    line: {
      send,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(closer) {
        closers.add(closer);
        return () => closers.delete(closer);
      },
      close() {
        fake.close();
      },
    },
    /** A page left open from before, as a restarted server finds it. */
    open(url) {
      const target = makeTarget(url);
      target.title = pageAt(url).title;
      return target;
    },
    /** The page in `targetId` opens a window on `url`. */
    popup(openerId, url) {
      const target = makeTarget(url, openerId);
      if (autoAttach) attach(target, true);
      return target;
    },
    /** A link clicked inside the page itself, through the guard. */
    follow(targetId, url) {
      const target = targets.get(targetId);
      return target ? go(target, url) : Promise.resolve(null);
    },
    /** The page opens `dialog` on the next click: an alert, a confirm or
     * a prompt, with its words. */
    arm(targetId, dialog) {
      const target = targets.get(targetId);
      if (target) target.armed = dialog;
    },
    /** The page asks before it is left, from now until it is. */
    askBeforeLeaving(targetId) {
      const target = targets.get(targetId);
      if (target) target.leave = true;
    },
    /** The page changes on its own: a new picture, when one is wanted. */
    repaint(targetId) {
      const target = targets.get(targetId);
      if (target) picture(target);
    },
    /** A file the page downloads, start to finish. */
    download(guid, name, body = "hello") {
      emit("Browser.downloadWillBegin", { frameId: "x", guid, url: `https://docs.example/${name}`, suggestedFilename: name });
      if (downloadPath) writeFileSync(join(downloadPath, guid), body);
      emit("Browser.downloadProgress", { guid, totalBytes: body.length, receivedBytes: body.length, state: "completed" });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const closer of closers) closer();
    },
    get closed() {
      return closed;
    },
  };
  return fake;
}

// ── as a program: a Chrome a real server starts ────────────────────────

/** Frames read off a client's socket, masked as every client's are; a
 * chunk may hold several, or part of one. */
function reader(onText) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0] & 0x0f;
      let length = pending[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (pending[1] & 0x80) !== 0;
      const need = at + (masked ? 4 : 0) + length;
      if (pending.length < need) return;
      const mask = masked ? pending.subarray(at, at + 4) : null;
      const body = Buffer.from(pending.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      pending = pending.subarray(need);
      if (opcode === 1) onText(body.toString("utf8"));
      if (opcode === 8) onText(null);
    }
  };
}

function frame(text) {
  const body = Buffer.from(text, "utf8");
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (body.length >= 126 && body.length < 65536) {
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else if (body.length >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}

function serve() {
  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const profile = flag("user-data-dir");
  const browserPath = `/devtools/browser/${randomUUID()}`;
  const fake = fakeBrowser();
  // the blank page Chrome opens with
  fake.open("about:blank");
  mkdirSync(profile, { recursive: true });
  // how it was started, for a test to read
  writeFileSync(join(profile, "launch-args.json"), JSON.stringify(process.argv.slice(2)));
  const server = createServer((req, res) => {
    const ws = `ws://127.0.0.1:${server.address().port}`;
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") return res.end(JSON.stringify({ Browser: "HeadlessChrome/141.0.0.0", webSocketDebuggerUrl: `${ws}${browserPath}` }));
    res.statusCode = 404;
    res.end("{}");
  });
  server.on("upgrade", (req, socket, head) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const say = (message) => {
      try {
        socket.write(frame(JSON.stringify(message)));
      } catch {
        /* gone */
      }
    };
    const off = fake.line.onEvent((method, params, sessionId) => say({ method, params, ...(sessionId ? { sessionId } : {}) }));
    const take = reader((text) => {
      if (text === null) return socket.end();
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      fake.line.send(message.method, message.params ?? {}, 0, message.sessionId).then(
        (result) => say({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
        (error) => say({ id: message.id, error: { message: error.message }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
      );
    });
    if (head.length) take(head);
    socket.on("data", take);
    socket.on("close", off);
    socket.on("error", () => socket.destroy());
  });
  fake.line.onClose(() => setTimeout(() => process.exit(0), 20));
  server.listen(Number(flag("remote-debugging-port") ?? 0), "127.0.0.1", () => {
    writeFileSync(join(profile, "DevToolsActivePort"), `${server.address().port}\n${browserPath}`);
  });
  // never outlives a test run that forgot it
  setTimeout(() => process.exit(0), 180_000).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve();
