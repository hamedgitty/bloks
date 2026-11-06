// The Bloks browser's rules and an agent's commands, as plain Node.
//
// There are two Bloks browsers, and both live under what is here. The
// desktop app's is a WebContentsView per tab in the window
// (electron/app-browser.mjs, main.mjs). A server with no app behind it
// (bloks-server, the Docker image, a paired machine) keeps one of its
// own: a headless Chrome on that server, shown in the panel by pictures
// (server/server-browser.ts). Each makes its tabs; everything that
// decides something lives here instead, so it can be read in one place,
// tested without either (test/app-browser-electron.test.ts), and never
// drift between the two:
//
//   Where a tab may go. Never a file on this computer, never the
//   browser's own pages, and never a Bloks server, which would hand a
//   page the app's own surface (refusedNavigation). While an agent
//   drives, the workspace's site lists apply too (allowedForAgent).
//
//   What an agent's command does to a page. Each one is a short run of
//   Chrome DevTools Protocol calls on the tab's own debugger
//   (webContents.debugger in the app, a page session of the server's
//   Chrome, a fake one in the tests), and nothing else: no preload, no
//   script of ours living in the page.
//
//   Who has the browser. An agent drives until it is done or the person
//   takes over; while the person has it, an agent's next action is held
//   and says why (AppBrowser.command).
//
//   What a page's own dialogs get. An alert, a confirm, a prompt or a
//   "leave this page?" stops the page until somebody answers it. Each
//   browser hears one open its own way and says so here (dialogOpened);
//   the agent's step that caused it comes back describing it, and the
//   agent answers with the dialog command. The person answers it in the
//   panel while they have the wheel. Nobody answering for thirty seconds
//   is a dismissal, never a yes.
//
// What a page says comes back as data. The server frames it as such
// before any of it reaches a model (server/app-browser.ts).
//
// Plain JavaScript rather than TypeScript on purpose: the app loads this
// file as it is from its own bundle, where nothing strips types, and the
// server's build copies it beside the compiled server
// (browser-core.d.mts has its shapes for both compilers).

/** Tabs one workspace's browser keeps open at once. */
export const MAX_TABS = 12;

/** How much of a page's text one read hands back. */
export const READ_LIMIT = 24_000;

/** How many elements one snapshot lists. Past this the page is a feed,
 * and scrolling then looking again is the way through it. */
export const SNAPSHOT_LIMIT = 300;

/** The longest an agent may wait for something on a page in one go. */
export const WAIT_LIMIT_MS = 30_000;

/** How long a page's dialog waits for an answer before it is dismissed. */
export const DIALOG_WAIT_MS = 30_000;

/** How much of a dialog's words are kept: a page can put a book in an
 * alert, and nobody answering one needs more than the gist. */
export const DIALOG_TEXT_LIMIT = 1000;

/** The longest answer typed into a page's prompt. */
export const PROMPT_LIMIT = 2000;

/** How long reading a page for the person's mention of it may take: a
 * page too busy to answer by then is said to be unreadable, and the
 * message goes without it. */
export const PEEK_WAIT_MS = 4_000;

/** How long a yes to leaving lets the next try through, where the
 * browser had to answer "stay" before anybody was asked (the app's). */
export const LEAVE_ARM_MS = 20_000;

const DIALOG_TYPES = new Set(["alert", "confirm", "prompt", "beforeunload"]);

/**
 * A dialog as a browser reported it, made safe to keep and to show: one
 * of the four kinds, its words without control characters and cut to a
 * length. A "leave this page?" has no words of the page's own (browsers
 * stopped showing them years ago), so none are kept for it.
 */
export function readDialog(raw) {
  const said = raw && typeof raw === "object" ? raw : {};
  const type = DIALOG_TYPES.has(said.type) ? said.type : "alert";
  const clean = (value) =>
    String(value ?? "")
      .replace(/\r\n?/g, "\n")
      // and nothing that turns text around to read as something else
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
      .slice(0, DIALOG_TEXT_LIMIT);
  return {
    type,
    message: type === "beforeunload" ? "" : clean(said.message),
    defaultPrompt: type === "prompt" ? clean(said.defaultPrompt) : "",
  };
}

/**
 * Why a tab may not go to `url`, or null when it may.
 *
 * Only the web: http and https, and the blank page a new tab starts on.
 * file: would read this computer's disk, chrome: and devtools: are the
 * browser's own controls, javascript: and data: are code dressed as an
 * address. And never a Bloks server on this computer, on any of the
 * ports `ownPorts` names: a page loaded from one would be the app,
 * signed in as the person, inside a tab an agent drives.
 */
export function refusedNavigation(url, { ownPorts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return "that is not an address";
  }
  if (parsed.href === "about:blank") return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${parsed.protocol.replace(/:$/, "")}: addresses are not opened in the Bloks browser`;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host) || host === "0.0.0.0";
  if (loopback) {
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (ownPorts.map(Number).includes(port)) return "Bloks itself is not opened in the Bloks browser";
  }
  return null;
}

/** A host as the site lists write it: lower case, no port, no www. */
export function hostOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Whether `host` is `pattern` or under it: "example.com" covers
 * "shop.example.com", and so does "*.example.com". The same rule as
 * server/app-browser.ts siteMatches, which the tests hold side by side. */
export function hostMatches(host, pattern) {
  const want = String(pattern ?? "").toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
  if (!host || !want) return false;
  return host === want || host.endsWith(`.${want}`);
}

/**
 * Whether an agent's tab may go to `url` under the rules the server
 * sent with its command: never a denied site, and, when the server says
 * only some sites are open (Ask first), only those. A tab the person
 * drives is not held to these: the lists are about agents.
 */
export function allowedForAgent(url, policy) {
  if (!policy) return true;
  const host = hostOf(url);
  if (!host) return String(url) === "about:blank";
  if ((policy.deny ?? []).some((pattern) => hostMatches(host, pattern))) return false;
  if (Array.isArray(policy.only)) return policy.only.some((pattern) => hostMatches(host, pattern));
  return true;
}

/**
 * What the person typed into the address bar, as an address: as written
 * when it already is one, https:// in front of something shaped like a
 * host, and a search for anything else.
 */
export function addressFor(typed) {
  const text = String(typed ?? "").trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[\w.-]+:\d+(\/|$)/.test(text)) return text;
  const hostish = /^(localhost|[\w-]+(\.[\w-]+)+|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(text) && !/\s/.test(text);
  if (hostish) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

// ── what a field is ────────────────────────────────────────────────────

/** Attribute pairs from DOM.describeNode, as an object. */
function attributesOf(node) {
  const list = node?.attributes ?? [];
  const out = {};
  for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i]).toLowerCase()] = String(list[i + 1]);
  return out;
}

const PAYMENT_NAMES = /(card.?(number|num|no)|cc.?(num|number)|cardnumber|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|card.?code|card.?expir|exp(iry|iration).?(date|month|year))/i;

/**
 * Whether typing into this element is something the person decides
 * first: a password, a card's number or code, or a file to upload. Read
 * from what the page says the field is (its type and autocomplete), and,
 * since a payment form does not always say, from its name too.
 */
export function fieldKind(node) {
  const tag = String(node?.nodeName ?? node?.localName ?? "").toLowerCase();
  const attrs = attributesOf(node);
  const type = (attrs.type ?? "").toLowerCase();
  if (tag === "input" && type === "file") return "file";
  if (tag === "input" && type === "password") return "password";
  const autocomplete = (attrs.autocomplete ?? "").toLowerCase();
  if (/\b(current-password|new-password|one-time-code)\b/.test(autocomplete)) return "password";
  if (/\bcc-(number|csc|exp|exp-month|exp-year)\b/.test(autocomplete)) return "payment";
  const names = [attrs.name, attrs.id, attrs["aria-label"], attrs.placeholder, attrs["data-elements-stable-field-name"]].filter(Boolean).join(" ");
  if ((tag === "input" || tag === "textarea") && PAYMENT_NAMES.test(names)) return "payment";
  return null;
}

// ── the snapshot ───────────────────────────────────────────────────────

/** Roles worth a line, with a ref, because an agent can act on them. */
const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "treeitem",
]);
/** Roles worth a line because they say where things are. */
const LANDMARKS = new Set(["heading", "dialog", "alertdialog", "alert", "img", "image", "table", "navigation", "main", "form", "search"]);
/** States worth saying, in the order they are said. */
const STATES = ["checked", "selected", "expanded", "pressed", "disabled", "required", "invalid", "focused", "readonly"];

const axValue = (field) => (field && typeof field === "object" ? field.value : undefined);

/**
 * The page's accessibility tree (Accessibility.getFullAXTree) as the
 * lines an agent reads, each control with a ref it can act on.
 *
 * The same idea as the agent's own Chrome (server/page-script.ts): act
 * on a handle, never on a guess at pixels. Here the handle names the
 * node the browser itself keeps (backendDOMNodeId), so the page is never
 * marked up to make one, and a page cannot forge a ref by writing an
 * attribute. Ignored and unnamed structural nodes are walked through
 * rather than listed; nesting is kept, shallowly, so a dialog's buttons
 * read as the dialog's.
 */
export function formatAxSnapshot(nodes, { url = "", title = "", limit = SNAPSHOT_LIMIT } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((node) => [String(node.nodeId), node]));
  const childIds = new Set(list.flatMap((node) => (node.childIds ?? []).map(String)));
  const roots = list.filter((node) => !node.parentId && !childIds.has(String(node.nodeId)));
  const refs = new Map();
  const lines = [];
  let more = 0;
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = String(axValue(node.role) ?? "").toLowerCase();
    const name = String(axValue(node.name) ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const listed = !node.ignored && node.backendDOMNodeId != null &&
      (ACTIONABLE.has(role) || (LANDMARKS.has(role) && (name || role === "dialog" || role === "alertdialog")));
    let next = depth;
    if (listed) {
      if (refs.size >= limit) more++;
      else {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        const bits = [`@${ref}`, role === "image" ? "img" : role];
        if (name) bits.push(JSON.stringify(name));
        const value = axValue(node.value);
        if (value !== undefined && value !== "" && role !== "link") bits.push(`value=${JSON.stringify(String(value).slice(0, 80))}`);
        const props = new Map((node.properties ?? []).map((p) => [p.name, axValue(p.value)]));
        if (role === "heading" && props.get("level")) bits.push(`level=${props.get("level")}`);
        for (const state of STATES) {
          const said = props.get(state);
          if (said === true || said === "true" || said === "mixed") bits.push(said === "mixed" ? `${state}=mixed` : state);
          else if ((state === "checked" || state === "expanded" || state === "pressed") && (said === false || said === "false") && role !== "link") {
            bits.push(state === "checked" ? "unchecked" : state === "expanded" ? "collapsed" : "not pressed");
          }
        }
        lines.push(`${"  ".repeat(1 + Math.min(depth, 6))}${bits.join(" ")}`);
      }
      next = depth + 1;
    }
    for (const child of node.childIds ?? []) walk(byId.get(String(child)), next);
  };
  for (const root of roots) walk(root, 0);

  const head = `${title || "(untitled)"} | ${url || "about:blank"}`;
  const count = refs.size;
  const body = count
    ? [`${count} elements:`, ...lines, ...(more ? [`  (${more} more not listed: scroll, then snapshot again)`] : [])]
    : ["nothing on this page to act on"];
  return { text: [head, ...body].join("\n"), refs, count };
}

// ── the agent's commands ───────────────────────────────────────────────

/** Keys an agent can press, named the way it would name them. */
export const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

/** A key by the name an agent used, case forgiven. */
export function keyNamed(name) {
  const said = String(name ?? "").trim();
  const found = Object.keys(KEYS).find((key) => key.toLowerCase() === said.toLowerCase());
  return found ? KEYS[found] : null;
}

/** Whether the page has stopped changing, roughly: the same settle the
 * agent's own Chrome uses (server/browser-proxy.ts). */
const SETTLE = `new Promise((done) => {
  let quiet;
  const finish = () => { observer.disconnect(); done(true); };
  const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 250); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  quiet = setTimeout(finish, 250);
  setTimeout(finish, 4000);
})`;

/** The page as text, for reading: the main part when the page marks one. */
const READ = `(() => {
  const main = document.querySelector("main,article,[role=main]") || document.body;
  if (!main) return "";
  const copy = main.cloneNode(true);
  for (const junk of copy.querySelectorAll("script,style,noscript,template,svg")) junk.remove();
  const text = (copy.innerText || copy.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return text.slice(0, ${READ_LIMIT + 1});
})()`;

async function evaluate(tab, expression) {
  const result = await tab.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "the page threw";
    throw new Error(String(text).split("\n")[0]);
  }
  return result?.result?.value;
}

async function settle(tab) {
  await evaluate(tab, SETTLE).catch(() => {});
}

/** The node a ref names, or an error an agent can act on. */
function nodeFor(tab, ref) {
  const clean = String(ref ?? "").replace(/^@/, "");
  const backendNodeId = tab.refs?.get(clean);
  if (backendNodeId == null) throw Object.assign(new Error(`no element @${clean} on this page. Take a fresh snapshot: refs last until the page changes.`), { agentError: true });
  return { ref: clean, backendNodeId };
}

/** A function run with the element as `this` (Runtime.callFunctionOn). */
async function onElement(tab, backendNodeId, fn, args = []) {
  const resolved = await tab.cdp("DOM.resolveNode", { backendNodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw Object.assign(new Error("that element is no longer on the page. Take a fresh snapshot."), { agentError: true });
  const result = await tab.cdp("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

/** What is actually at the middle of an element, when it is not the
 * element: the consent banner, the modal, the sticky header. */
const COVERED = `function (x, y) {
  const at = document.elementFromPoint(x, y);
  if (!at || at === this || this.contains(at) || at.contains(this)) return null;
  const label = (at.getAttribute && at.getAttribute("aria-label")) || at.innerText || "";
  const said = String(label).replace(/\\s+/g, " ").trim().slice(0, 60);
  return at.tagName.toLowerCase() + (said ? ' "' + said + '"' : "");
}`;

/** The middle of an element on screen, scrolled to first. */
async function centreOf(tab, backendNodeId) {
  await tab.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const box = await tab.cdp("DOM.getBoxModel", { backendNodeId }).catch(() => null);
  const quad = box?.model?.content ?? box?.model?.border;
  if (!quad || quad.length < 8) throw Object.assign(new Error("that element is not visible on the page"), { agentError: true });
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
}

async function press(tab, def) {
  const key = { key: def.key, code: def.code, keyCode: def.keyCode, windowsVirtualKeyCode: def.keyCode };
  await tab.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key, ...(def.text ? { text: def.text } : {}) });
  await tab.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/** The tab's elements, read afresh, with their refs kept on the tab for
 * the commands that follow. A step a dialog cut short finishes on its
 * own once the dialog is answered; its late look at the page is not the
 * one the agent is working from, so it leaves the refs be (tab.run). */
async function snapshot(tab, run = tab.run) {
  await tab.cdp("Accessibility.enable").catch(() => {});
  const tree = await tab.cdp("Accessibility.getFullAXTree", {});
  const shaped = formatAxSnapshot(tree?.nodes ?? [], { url: tab.url(), title: tab.title() });
  if (tab.run === run) tab.refs = shaped.refs;
  return shaped.text;
}

/** Plain words for what a field is, for the card that asks. */
export const FIELD_WORDS = { password: "a password field", payment: "a payment field", file: "a file upload" };

/**
 * One command, run on one tab, as protocol calls. Answers what the
 * agent is told: `text` (page content, which the server frames), or an
 * `image`, or `needs` when the person has to say yes first. A mistake
 * the agent can fix (a stale ref, a covered button) is an `error` with
 * the way out in it; anything else throws.
 */
export async function runOnTab(tab, command) {
  const action = command.action;
  const run = tab.run;
  switch (action) {
    case "open": {
      tab.refs = new Map();
      await tab.cdp("Page.enable").catch(() => {});
      const went = await tab.cdp("Page.navigate", { url: command.url });
      if (went?.errorText) return { error: `the page did not load: ${went.errorText}` };
      await settle(tab);
      return { text: await snapshot(tab, run) };
    }
    case "snapshot":
      return { text: await snapshot(tab, run) };
    case "read": {
      const text = String((await evaluate(tab, READ)) ?? "");
      const cut = text.length > READ_LIMIT;
      return { text: `${tab.title() || "(untitled)"} | ${tab.url()}\n\n${cut ? `${text.slice(0, READ_LIMIT)}\n\n(cut here: the page goes on)` : text || "(no text on this page)"}` };
    }
    case "click": {
      const { ref, backendNodeId } = nodeFor(tab, command.ref);
      const node = await tab.cdp("DOM.describeNode", { backendNodeId });
      if (fieldKind(node?.node) === "file") return { error: `@${ref} picks a file. Use upload with a path instead of clicking it.` };
      const { x, y } = await centreOf(tab, backendNodeId);
      const covered = await onElement(tab, backendNodeId, COVERED, [x, y]);
      if (covered) return { error: `${covered} is in front of @${ref}. Dismiss it or act on it, then snapshot again.` };
      await tab.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await tab.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await settle(tab);
      return { text: `clicked @${ref}\n\n${await snapshot(tab, run)}` };
    }
    case "type": {
      const { ref, backendNodeId } = nodeFor(tab, command.ref);
      const node = await tab.cdp("DOM.describeNode", { backendNodeId });
      const kind = fieldKind(node?.node);
      if (kind === "file") return { error: `@${ref} picks a file. Use upload with a path instead of typing into it.` };
      if (kind && !command.approved) return { needs: { kind, ref } };
      await tab.cdp("DOM.focus", { backendNodeId });
      if (!command.append) {
        await onElement(tab, backendNodeId, `function () {
          if ("value" in this) { this.value = ""; this.dispatchEvent(new Event("input", { bubbles: true })); }
          else if (this.isContentEditable) { this.textContent = ""; }
        }`);
      }
      await tab.cdp("Input.insertText", { text: command.text });
      // what was typed is never said back: it may be the very thing the
      // person was asked about
      const typed = `typed ${command.text.length} character${command.text.length === 1 ? "" : "s"} into @${ref}`;
      if (!command.submit) return { text: typed };
      await press(tab, KEYS.Enter);
      await settle(tab);
      return { text: `${typed} and pressed Enter\n\n${await snapshot(tab, run)}` };
    }
    case "select": {
      const { ref, backendNodeId } = nodeFor(tab, command.ref);
      const said = await onElement(tab, backendNodeId, `function (want) {
        if (this.tagName !== "SELECT") return { error: "not a list to choose from" };
        const options = [...this.options];
        const lower = String(want).toLowerCase();
        const found = options.find((o) => o.value === want) || options.find((o) => o.text.trim().toLowerCase() === lower)
          || options.find((o) => o.text.trim().toLowerCase().startsWith(lower));
        if (!found) return { error: "no such option", options: options.slice(0, 20).map((o) => o.text.trim()) };
        this.value = found.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return { chose: found.text.trim() };
      }`, [command.value]);
      if (said?.error === "no such option") return { error: `@${ref} has no option "${command.value}". It has: ${(said.options ?? []).join(", ")}` };
      if (said?.error) return { error: `@${ref} is ${said.error}. Click it and pick from what opens instead.` };
      await settle(tab);
      return { text: `chose "${said?.chose ?? command.value}" in @${ref}` };
    }
    case "scroll": {
      if (command.ref) {
        const { ref, backendNodeId } = nodeFor(tab, command.ref);
        await tab.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId });
        return { text: `scrolled @${ref} into view` };
      }
      if (command.direction === "top" || command.direction === "bottom") {
        await evaluate(tab, `window.scrollTo(0, ${command.direction === "top" ? 0 : "document.documentElement.scrollHeight"})`);
      } else {
        const metrics = await tab.cdp("Page.getLayoutMetrics", {});
        const viewport = metrics?.cssVisualViewport ?? metrics?.layoutViewport ?? { clientWidth: 800, clientHeight: 600 };
        const deltaY = Math.round(viewport.clientHeight * 0.8) * (command.direction === "up" ? -1 : 1);
        await tab.cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Math.round(viewport.clientWidth / 2),
          y: Math.round(viewport.clientHeight / 2),
          deltaX: 0,
          deltaY,
        });
      }
      await settle(tab);
      const where = await evaluate(tab, `(() => { const h = document.documentElement.scrollHeight - innerHeight; return h > 0 ? Math.round(100 * scrollY / h) : 100; })()`).catch(() => null);
      return { text: `scrolled ${command.direction}${typeof where === "number" ? `, ${where}% of the way down` : ""}` };
    }
    case "press": {
      const def = keyNamed(command.key);
      if (!def) return { error: `no key called ${command.key}. Keys: ${Object.keys(KEYS).join(", ")}` };
      await press(tab, def);
      await settle(tab);
      return { text: `pressed ${command.key}\n\n${await snapshot(tab, run)}` };
    }
    case "wait": {
      const until = Date.now() + Math.min(WAIT_LIMIT_MS, Math.max(250, command.ms ?? 5000));
      const test = command.text !== undefined
        ? `(document.body ? document.body.innerText : "").includes(${JSON.stringify(command.text)})`
        : command.gone !== undefined
          ? `!(document.body ? document.body.innerText : "").includes(${JSON.stringify(command.gone)})`
          : `document.readyState === "complete"`;
      for (;;) {
        if (await evaluate(tab, test).catch(() => false)) {
          await settle(tab);
          const what = command.text !== undefined ? `"${command.text}" is on the page` : command.gone !== undefined ? `"${command.gone}" is gone` : "the page has loaded";
          return { text: `${what}\n\n${await snapshot(tab, run)}` };
        }
        if (Date.now() >= until) {
          const what = command.text !== undefined ? `"${command.text}" did not appear` : command.gone !== undefined ? `"${command.gone}" is still there` : "the page is still loading";
          return { error: `waited ${Math.round((command.ms ?? 5000) / 1000)}s and ${what}. Snapshot to see where it stands.` };
        }
        await new Promise((resolve) => setTimeout(resolve, tab.pollMs ?? 250));
      }
    }
    case "screenshot": {
      const shot = await tab.cdp("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: false });
      if (!shot?.data) return { error: "the page would not make a picture. Open the Bloks window on this workspace and try again." };
      return { image: String(shot.data), mime: "image/jpeg" };
    }
    case "upload": {
      const { ref, backendNodeId } = nodeFor(tab, command.ref);
      const node = await tab.cdp("DOM.describeNode", { backendNodeId });
      if (fieldKind(node?.node) !== "file") return { error: `@${ref} is not a file upload. Snapshot and pick the one that is.` };
      if (!command.approved) return { needs: { kind: "file", ref } };
      await tab.cdp("DOM.setFileInputFiles", { files: [command.path], backendNodeId });
      await settle(tab);
      return { text: `chose the file for @${ref}` };
    }
    case "back":
    case "forward": {
      const history = await tab.cdp("Page.getNavigationHistory", {});
      const entry = history?.entries?.[history.currentIndex + (action === "back" ? -1 : 1)];
      if (!entry) return { error: `there is no page to go ${action} to` };
      tab.refs = new Map();
      await tab.cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
      await settle(tab);
      return { text: await snapshot(tab, run) };
    }
    case "reload": {
      tab.refs = new Map();
      await tab.cdp("Page.reload", {});
      await settle(tab);
      return { text: await snapshot(tab, run) };
    }
    default:
      return { error: `the Bloks browser does not know ${action}` };
  }
}

/** What answering a dialog did, in the agent's words. Never the text
 * typed into a prompt: it may be what the person would not have said. */
export function dialogOutcome(dialog, accept, text) {
  if (dialog.type === "beforeunload") return accept ? "left the page" : "stayed on the page";
  if (dialog.type === "alert") return "closed the alert";
  if (dialog.type === "confirm") return accept ? "answered OK to the confirm" : "answered Cancel to the confirm";
  if (!accept) return "answered Cancel to the prompt";
  if (text === undefined) return "answered OK to the prompt with the text it suggested";
  return `entered ${text.length} character${text.length === 1 ? "" : "s"} and answered OK to the prompt`;
}

/** The page once it carries on after a dialog: loaded, if answering sent
 * it somewhere, and settled, then looked at. */
async function afterDialog(tab, words) {
  const run = tab.run;
  await new Promise((resolve) => setTimeout(resolve, tab.pollMs ?? 150));
  const until = Date.now() + 5_000;
  while (Date.now() < until && !(await evaluate(tab, `document.readyState === "complete"`).catch(() => false))) {
    await new Promise((resolve) => setTimeout(resolve, tab.pollMs ?? 150));
  }
  await settle(tab);
  return { text: `${words}\n\n${await snapshot(tab, run)}` };
}

// ── who has the browser ────────────────────────────────────────────────

/** How long an agent holds the browser after its last action, when it
 * never said it was done: long enough to think between steps. */
export const AGENT_IDLE_MS = 45_000;

/**
 * One workspace's browser: its tabs, who drives which, and who has the
 * wheel right now. The tabs themselves are made by `makeTab` (a
 * WebContentsView in the app, a page of the server's Chrome, a fake in
 * the tests); everything here is bookkeeping and the rules.
 */
export class AppBrowser {
  #tabs = [];
  #active = null;
  #control = { by: "idle" };
  #downloads = [];
  #seq = 0;
  #idleTimer = null;
  #dialogSeq = 0;
  #runSeq = 0;
  #notes = [];
  /** The last tab to close, by whom, and whether it was the last one
   * open: the person's panel closes with their own last tab and stays
   * open on the empty page when an agent closed it (BrowserPanel.tsx). */
  #closed = null;
  #closeSeq = 0;
  #makeTab;
  #onChange;
  #now;
  #idleMs;
  #dialogMs;
  #ownPorts;

  constructor({ makeTab, onChange = () => {}, now = Date.now, idleMs = AGENT_IDLE_MS, dialogMs = DIALOG_WAIT_MS, ownPorts = () => [] }) {
    this.#makeTab = makeTab;
    this.#onChange = onChange;
    this.#now = now;
    this.#idleMs = idleMs;
    this.#dialogMs = dialogMs;
    this.#ownPorts = ownPorts;
  }

  /** What the panel, the server and the phone are shown. Never page
   * content beyond each tab's address and title, and the words of a
   * dialog it has open, which the person is the one to answer. */
  state() {
    return {
      tabs: this.#tabs.map((tab) => ({
        id: tab.id,
        url: tab.url(),
        title: tab.title(),
        loading: Boolean(tab.loading?.()),
        canGoBack: Boolean(tab.canGoBack?.()),
        canGoForward: Boolean(tab.canGoForward?.()),
        by: tab.by,
        ...(tab.dialog
          ? {
              dialog: {
                id: tab.dialog.id,
                type: tab.dialog.type,
                message: tab.dialog.message,
                ...(tab.dialog.type === "prompt" ? { defaultPrompt: tab.dialog.defaultPrompt } : {}),
                // a yes only lets the next try through: there is nothing
                // to go again for the person
                ...(!tab.dialog.held && !tab.dialog.redo ? { again: true } : {}),
              },
            }
          : {}),
      })),
      activeTabId: this.#active,
      control: { ...this.#control },
      downloads: this.#downloads.map((d) => ({ ...d })),
      closed: this.#closed ? { ...this.#closed } : null,
    };
  }

  changed() {
    this.#onChange(this.state());
  }

  tab(id) {
    return this.#tabs.find((tab) => tab.id === id) ?? null;
  }

  get active() {
    return this.tab(this.#active);
  }

  get control() {
    return { ...this.#control };
  }

  /** A new tab, opened by the person or an agent, and made the one shown. */
  newTab(by = { kind: "person" }) {
    if (this.#tabs.length >= MAX_TABS) throw Object.assign(new Error(`the Bloks browser keeps ${MAX_TABS} tabs at most. Close one first.`), { agentError: true });
    const id = `t${++this.#seq}`;
    const tab = this.#makeTab(id);
    tab.id = id;
    tab.by = by;
    tab.refs = new Map();
    this.#tabs.push(tab);
    this.#active = id;
    this.changed();
    return tab;
  }

  select(id) {
    if (!this.tab(id)) return false;
    this.#active = id;
    this.changed();
    return true;
  }

  /** `by` is who closed it: the person from the panel, an agent with its
   * command, or the page going by itself (window.close, a crash, the
   * browser shutting). */
  close(id, by = "page") {
    const at = this.#tabs.findIndex((tab) => tab.id === id);
    if (at < 0) return false;
    const [gone] = this.#tabs.splice(at, 1);
    if (gone.dialog) {
      // let go of the page before it goes, so nothing waits on it
      const { answer, held } = gone.dialog;
      this.#forgetDialog(gone);
      if (held) {
        try {
          Promise.resolve(answer(false, "")).catch(() => {});
        } catch {
          /* it went first */
        }
      }
    }
    try {
      gone.close?.();
    } catch {
      /* already gone with its window */
    }
    if (this.#active === id) this.#active = this.#tabs[Math.min(at, this.#tabs.length - 1)]?.id ?? null;
    this.#closed = { seq: ++this.#closeSeq, at: this.#now(), by: by === "person" || by === "agent" ? by : "page", emptied: this.#tabs.length === 0 };
    this.changed();
    return true;
  }

  closeAll() {
    for (const tab of [...this.#tabs]) this.close(tab.id);
  }

  /** The person takes the wheel. An agent's next action waits for it to
   * be given back; one already running finishes its step. */
  takeOver() {
    const from = this.#control.by === "agent" ? { botId: this.#control.botId, name: this.#control.name } : this.#control.from;
    clearTimeout(this.#idleTimer);
    this.#control = { by: "person", since: this.#now(), ...(from ? { from } : {}) };
    // a dialog in front of the person waits for them, however long they take
    for (const tab of this.#tabs) if (tab.dialog) clearTimeout(tab.dialog.timer);
    this.changed();
  }

  /** And gives it back: idle, for whichever agent acts next. */
  giveBack() {
    if (this.#control.by !== "person") return;
    this.#control = { by: "idle" };
    // one they left open has its thirty seconds again from now
    for (const tab of this.#tabs) if (tab.dialog) this.#dialogClock(tab);
    this.changed();
  }

  /** An agent is done with the browser, said or timed out. */
  release(botId) {
    if (this.#control.by !== "agent" || (botId && this.#control.botId !== botId)) return;
    clearTimeout(this.#idleTimer);
    this.#control = { by: "idle" };
    this.changed();
  }

  /** The person's own navigation from the address bar. */
  navigate(typed) {
    const url = addressFor(typed);
    if (!url) return { error: "type an address or something to search for" };
    const refused = refusedNavigation(url, { ownPorts: this.#ownPorts() });
    if (refused) return { error: refused };
    const tab = this.active ?? this.newTab({ kind: "person" });
    tab.refs = new Map();
    // a tab the person sends somewhere is theirs from then on
    if (tab.by?.kind !== "person") {
      tab.by = { kind: "person" };
      this.changed();
    }
    tab.load(url);
    return { ok: true, url };
  }

  noteDownload(download) {
    const at = this.#downloads.findIndex((d) => d.id === download.id);
    if (at >= 0) this.#downloads[at] = { ...this.#downloads[at], ...download };
    else this.#downloads.unshift(download);
    this.#downloads = this.#downloads.slice(0, 30);
    this.changed();
  }

  clearDownloads() {
    this.#downloads = this.#downloads.filter((d) => d.state === "progressing");
    this.changed();
  }

  // ── a page's dialogs ──

  /**
   * A page opened a dialog, as its browser heard it: `type`, `message`
   * and `defaultPrompt` as the page gave them, and `answer(accept, text)`,
   * which answers it in the page. `held` is false where the browser had
   * to say "stay" to a "leave this page?" before anybody could be asked
   * (the app's); a yes then lets the next try through, and `redo` makes
   * that try when the browser knows what it was. Answers the dialog's id.
   */
  dialogOpened(tabId, { answer = () => {}, held = true, redo = null, ...said } = {}) {
    const tab = this.tab(tabId);
    if (!tab) return null;
    if (tab.dialog) this.#forgetDialog(tab);
    tab.dialog = {
      id: `d${++this.#dialogSeq}`,
      ...readDialog(said),
      held: held !== false,
      answer,
      redo: typeof redo === "function" ? redo : null,
      // the agent's step that ran into it, to go again after a yes
      step: tab.step ?? null,
      told: false,
      timer: null,
    };
    if (this.#control.by !== "person") this.#dialogClock(tab);
    for (const wake of [...(tab.dialogWaiters ?? [])]) wake();
    this.changed();
    return tab.dialog.id;
  }

  /** The page or its browser closed a dialog by itself: the tab went
   * somewhere else, or was closed. */
  dialogClosed(tabId) {
    const tab = this.tab(tabId);
    const dialog = tab?.dialog;
    if (!dialog) return;
    this.#forgetDialog(tab);
    if (dialog.held && dialog.told) this.#note(tab, dialog, "closed");
    this.changed();
  }

  /**
   * An answer to the dialog `id`, from the person in the panel, an agent's
   * dialog command, or the clock. A prompt's yes carries `text`, or the
   * text the page suggested when there is none. Never throws: a dialog
   * gone by the time it is answered is said to be gone.
   */
  async answerDialog(id, { accept = false, text } = {}, by = "person") {
    const tab = this.#tabs.find((t) => t.dialog?.id === id);
    const dialog = tab?.dialog;
    if (!dialog) return { error: "That dialog is no longer open." };
    const yes = accept === true;
    const typed = yes && dialog.type === "prompt" && typeof text === "string" ? text.slice(0, PROMPT_LIMIT) : undefined;
    this.#forgetDialog(tab);
    if (by === "person" && dialog.told) this.#note(tab, dialog, yes ? "accepted" : "dismissed");
    if (dialog.held) {
      try {
        await dialog.answer(yes, yes && dialog.type === "prompt" ? (typed ?? dialog.defaultPrompt) : "");
      } catch {
        /* the page let it go first */
      }
    } else if (yes) {
      tab.leaving = this.#now() + LEAVE_ARM_MS;
      if (by === "person" && dialog.redo) {
        try {
          dialog.redo();
        } catch {
          /* the tab went meanwhile */
        }
      }
    }
    this.changed();
    return { ok: true, tab, dialog, accept: yes, text: typed };
  }

  /** Until a dialog opens on `tab`, for a step that might be stopped by
   * one; `stop` when the step is over. */
  watchDialog(tab) {
    let stop = () => {};
    const opened = new Promise((resolve) => {
      if (tab.dialog) return resolve();
      const wake = () => {
        stop();
        resolve();
      };
      tab.dialogWaiters = [...(tab.dialogWaiters ?? []), wake];
      stop = () => (tab.dialogWaiters = (tab.dialogWaiters ?? []).filter((w) => w !== wake));
    });
    return { opened, stop: () => stop() };
  }

  /** Thirty seconds for somebody to answer, then a no. */
  #dialogClock(tab) {
    const dialog = tab.dialog;
    clearTimeout(dialog.timer);
    dialog.timer = setTimeout(() => {
      if (tab.dialog !== dialog) return;
      // an agent hears of it when it was told of the dialog, or drives
      if (dialog.told || this.#control.by === "agent") this.#note(tab, dialog, "timeout");
      void this.answerDialog(dialog.id, { accept: false }, "clock");
    }, this.#dialogMs);
    dialog.timer.unref?.();
  }

  #forgetDialog(tab) {
    clearTimeout(tab.dialog?.timer);
    tab.dialog = null;
  }

  /** What became of a dialog the agent has not heard the end of, said
   * with the next thing it hears. */
  #note(tab, dialog, how) {
    this.#notes = [...this.#notes, { tab: tab.id, type: dialog.type, message: dialog.message, how, at: this.#now() }].slice(-5);
  }

  /** A dialog as an agent is told of it; told once, it hears how it ends. */
  #describe(dialog) {
    dialog.told = true;
    return { id: dialog.id, type: dialog.type, message: dialog.message, ...(dialog.defaultPrompt ? { defaultPrompt: dialog.defaultPrompt } : {}), held: dialog.held };
  }

  /** Work on a tab, or the dialog that stopped it, whichever comes first.
   * Work a dialog cut short is let finish by itself once it is answered;
   * what it finds then is nobody's to act on (tab.run). */
  async #race(tab, work) {
    const watch = this.watchDialog(tab);
    try {
      const first = await Promise.race([work.then((answer) => ({ answer })), watch.opened.then(() => ({ answer: null }))]);
      if (first.answer) return first.answer;
      // answered already, in the blink between: the work goes on
      if (!tab.dialog) return await work;
      tab.run = ++this.#runSeq;
      work.catch(() => {});
      // the rest of the step still lands on the page once the dialog is
      // answered (by the agent, the person or the clock), and its input
      // is the step's, not the person taking the wheel
      tab.cutShort = work;
      return { dialog: this.#describe(tab.dialog) };
    } finally {
      watch.stop();
    }
  }

  /** The agent's dialog command: its answer, then the page as it carries
   * on, or the next dialog it opens. */
  async #answerForAgent(tab, command) {
    const open = tab.dialog;
    if (!open) return { error: "no dialog is open on this page. Snapshot to see where it stands.", tab: tab.id };
    const accept = command.answer === "accept";
    const done = await this.answerDialog(open.id, { accept, text: command.text }, "agent");
    if (done.error) return { error: done.error, tab: tab.id };
    tab.run = ++this.#runSeq;
    // A "leave this page?" the app had to answer "stay" to already: with
    // a yes, the step that tried to leave goes again, and through.
    if (!open.held && accept && open.step) {
      const again = await this.#race(tab, runOnTab(tab, open.step));
      return typeof again.text === "string" ? { ...again, text: `left the page\n\n${again.text}` } : again;
    }
    const words = !open.held && accept ? "said yes to leaving: the next try to leave this page goes through" : dialogOutcome(open, accept, done.text);
    return this.#race(tab, afterDialog(tab, words));
  }

  /**
   * A tab's address, title and readable words, for the person who named
   * it in a message to an agent (server/mentions.ts). Not a command:
   * nobody takes the wheel, the tab on screen stays on screen, and an
   * agent driving it goes on undisturbed, since reading the words is all
   * this does. A tab waiting on a dialog is left alone, and a page that
   * does not answer in PEEK_WAIT_MS is said to be unreadable.
   */
  async peek(id, { waitMs = PEEK_WAIT_MS } = {}) {
    const tab = this.tab(id);
    if (!tab) return { error: "closed" };
    if (tab.dialog) return { tab: tab.id, url: tab.url(), title: tab.title(), error: "dialog" };
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      timer.unref?.();
    });
    try {
      const text = await Promise.race([evaluate(tab, READ).catch(() => null), late]);
      // read after the words, so the address is the page they came from
      const head = { tab: tab.id, url: tab.url(), title: tab.title() };
      if (typeof text !== "string") return { ...head, error: "unreadable" };
      return { ...head, text: text.slice(0, READ_LIMIT) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One command from an agent (or another app), as the server asked it.
   * `driver` is who: { botId, name } for an agent. Held while the person
   * has the browser; otherwise the agent has it for this step and for a
   * while after.
   */
  async command(command, driver) {
    const who = { botId: String(driver?.botId ?? ""), name: String(driver?.name ?? "An agent") };
    if (this.#control.by === "person") {
      if (!this.#control.waiting || this.#control.waiting.botId !== who.botId) {
        this.#control = { ...this.#control, waiting: who };
        this.changed();
      }
      // said with the answer, so the server waits on what is true now
      // rather than on whatever it last heard
      return { held: true, control: this.control };
    }
    const answer = await this.#command(command, who);
    // what became of a dialog meanwhile, said once
    const notes = this.#notes.filter((note) => this.#now() - note.at < 10 * 60_000).map(({ at: _at, ...note }) => note);
    this.#notes = [];
    return notes.length ? { ...answer, dialogNotes: notes } : answer;
  }

  async #command(command, who) {
    if (command.action === "done") {
      this.release(who.botId);
      return { text: "the browser is yours no longer; the person sees it as free" };
    }
    if (command.action === "tabs") return { tabs: this.state().tabs, activeTabId: this.#active };
    this.#hold(who);
    if (command.action === "switch") {
      if (!this.select(command.tab)) return { error: `no tab ${command.tab}. Tabs: ${this.#tabs.map((t) => t.id).join(", ") || "none"}` };
      return { text: `switched to ${command.tab}`, tabs: this.state().tabs };
    }
    if (command.action === "close") {
      const tab = this.tab(command.tab);
      if (!tab) return { error: `no tab ${command.tab}` };
      if (tab.by?.kind !== "agent" || tab.by.botId !== who.botId) return { error: "only a tab you opened can be closed by you; the person closes the rest" };
      this.close(command.tab, "agent");
      return { text: `closed ${command.tab}` };
    }
    let tab = command.newTab || !this.active ? null : this.active;
    if (command.action === "open") {
      // An address goes in the agent's own tab, never over the page the
      // person has open: theirs keeps its place, and the agent gets a
      // tab of its own beside it.
      const mine = tab?.by?.kind === "agent" && tab.by.botId === who.botId;
      if (!mine) tab = null;
      const refused = refusedNavigation(command.url, { ownPorts: this.#ownPorts() });
      if (refused) return { error: refused };
      try {
        tab ??= this.newTab({ kind: "agent", ...who });
      } catch (error) {
        if (error?.agentError) return { error: error.message };
        throw error;
      }
    }
    if (!tab) return { error: "no page is open. Use open with an address first." };
    if (tab.dialog && command.action !== "dialog") {
      // A page waiting on its dialog does nothing else until it has an
      // answer, and every call to it would only wait: the agent hears
      // the question again instead.
      if (tab.dialog.held) return { dialog: this.#describe(tab.dialog), tab: tab.id, url: tab.url(), title: tab.title() };
      // the app already stayed on the page; moving on is the agent's no
      this.#forgetDialog(tab);
      this.changed();
    }
    tab.policy = command.policy ?? null;
    tab.blocked = null;
    tab.acting = true;
    tab.run = ++this.#runSeq;
    tab.step = command.action === "dialog" ? null : command;
    try {
      const answer = command.action === "dialog" ? await this.#answerForAgent(tab, command) : await this.#race(tab, runOnTab(tab, command));
      // a page that tried to take the agent somewhere it may not go
      if (tab.blocked) answer.blocked = tab.blocked;
      return { ...answer, tab: tab.id, url: tab.url(), title: tab.title() };
    } catch (error) {
      if (error?.agentError) return { error: error.message, tab: tab.id };
      throw error;
    } finally {
      tab.step = null;
      // the step's own input events are not the person taking over, nor
      // are those of a step a dialog cut short, for as long as it runs on
      const run = tab.run;
      const settled = tab.cutShort ?? Promise.resolve();
      settled.catch(() => {}).finally(() =>
        setTimeout(() => {
          if (tab.run !== run) return;
          tab.cutShort = null;
          tab.acting = false;
        }, 300),
      );
      this.#hold(who);
      this.changed();
    }
  }

  /** The agent has the browser, for now and for a while. */
  #hold(who) {
    const was = this.#control;
    if (was.by !== "agent" || was.botId !== who.botId) {
      this.#control = { by: "agent", botId: who.botId, name: who.name, since: this.#now() };
      this.changed();
    }
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.release(who.botId), this.#idleMs);
    this.#idleTimer.unref?.();
  }
}

/** A name for a download that does not overwrite one already in the
 * folder: "report.pdf", then "report (2).pdf". Never a path: whatever
 * the site suggested, only its last part, with nothing that climbs out. */
export function downloadName(suggested, taken) {
  const base = String(suggested ?? "").split(/[\\/]/).pop()?.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 160) || "download";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let name = base;
  for (let n = 2; taken(name); n++) name = `${stem} (${n})${ext}`;
  return name;
}
