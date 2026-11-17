# Writing a Bloks extension

An extension adds panels, commands and event handlers to one Bloks
workspace, installed by its owner from a folder. It is a few HTML, CSS and
JavaScript files and a manifest. There is nothing to build against and no
package to import: Bloks hands every document a small `window.bloks`.

How it works inside Bloks, and why each rule is there, is in
`docs/ARCHITECTURE.md`, Workspace extensions.

## What your code can and cannot do

Every document of yours runs in a sandbox, never as the owner:

- It has an origin of its own. It cannot read Bloks's pages, cookies or
  storage, and `localStorage` and cookies are not available to it. Use
  `storage.*` instead.
- It has no network. `fetch`, `XMLHttpRequest`, WebSockets, images, fonts
  and frames from any address, forms and workers are all refused. Put
  everything you need in the folder; Bloks folds your own scripts,
  stylesheets and images into the page.
- No `eval` or `new Function`. Ship plain scripts, or a bundle.
- No WebRTC.
- It cannot navigate away. A document that tries is stopped.
- It reaches nothing secret: no saved secrets, connections, keys, files,
  or agents' credentials. If your idea needs a credential or a network
  service, it is an MCP server, not an extension.

What it can do is ask Bloks, through `window.bloks`, for what the owner
granted in your manifest.

## The folder

```
team-status/
  bloks-extension.json
  panel.html
  panel.css
  panel.js
  background.html
  background.js
```

At most 200 files, 2 MB each, 5 MB in all. Hidden files (a `.git`, a
`.env`) are left out and cannot be referenced. Links are refused.

## The manifest

`bloks-extension.json`:

```json
{
  "manifestVersion": 1,
  "id": "team-status",
  "name": "Team status",
  "version": "1.0.0",
  "description": "Who is working, and a command to ask for an update.",
  "author": "Your name",
  "bloks": ">=3.3.0",
  "permissions": ["agents:read", "turns:read", "composer:write", "storage"],
  "panels": [{ "id": "status", "title": "Team status", "entry": "panel.html" }],
  "background": "background.html",
  "commands": [{ "id": "draft-status", "title": "Draft a status request" }],
  "events": ["turn.started", "turn.finished", "agents.changed"],
  "settings": [{ "key": "showIdle", "label": "Show idle agents", "type": "boolean", "default": true }]
}
```

| Field | |
| --- | --- |
| `manifestVersion` | Always `1`. |
| `id` | 2 to 40 lower case letters, digits and dashes. An install with the same id is an update. |
| `version` | `1.0.0`, with an optional `-beta.1`. |
| `bloks` | The Bloks versions it works with: `*`, `>=3.3.0`, `<4`, `^3.3.0`, `~3.3.0`, or several joined by spaces, all of which must hold. |
| `permissions` | What it asks for; see below. The owner sees each one in words before installing. |
| `panels` | Up to four. Each is a tab of the Extensions panel in the side dock beside a chat or room, its puzzle piece on the dock's ribbon. |
| `background` | An optional hidden document that runs while a Bloks window is open, for commands and events with no panel showing. |
| `commands` | Up to twenty. They appear in search (Cmd K) as "Team status: Draft a status request", and on the extension's page. |
| `events` | The workspace events it handles; see below. |
| `settings` | Up to twelve `text`, `boolean` or `number` values the owner edits on the extension's page. Never ask for a password or key here. |

The install screen lists every problem with a manifest at once.

## Permissions

| Permission | Lets it |
| --- | --- |
| `agents:read` | List the owner's agents (id, name, working) and know which one is on screen. |
| `turns:read` | Hear when an agent starts and finishes a turn (by agent and conversation, never what was said). |
| `composer:write` | Put words in an agent's message box. The owner reads and sends them, or not. |
| `agents:message` | Send a message to an agent, only within thirty seconds of the owner running one of your commands, once per run, at most twelve an hour. The agent sees it as your words, not the owner's, and acts with its usual approvals. |
| `storage` | Keep up to 256 KB of JSON in this workspace. |
| `notifications` | Show a short notice in the app. |

Ask for the least you need. An update that asks for more is shown to the
owner with the new permissions marked, and they have to allow it again.

## The SDK

Every document has `window.bloks`:

```js
// a call returns a promise; a refusal rejects with the reason
const agents = await bloks.call("agents.list");

// an event; returns a function that stops listening
const stop = bloks.on("turn.finished", ({ agentId, conversationId }) => { /* ... */ });

// a command from the manifest, with the agent on screen when you have agents:read
bloks.onCommand("draft-status", async ({ agentId, agentName }) => { /* ... */ });

// which extension and document this is
bloks.context; // { extension: "team-status", document: "status" }
```

Calls:

| Call | Needs | Params | Answers |
| --- | --- | --- | --- |
| `agents.list` | `agents:read` | | `[{ id, name, working }]` |
| `agents.selected` | `agents:read` | | `{ id, name, working }` or `null` |
| `agents.message` | `agents:message` | `{ agentId, text }` | `{ sent, queued }` |
| `composer.insert` | `composer:write` | `{ text, agentId? }` | `true` |
| `storage.get` | `storage` | `{ key? }` | the value, or everything |
| `storage.set` | `storage` | `{ key, value }` | `true` |
| `storage.remove` | `storage` | `{ key }` | `true` |
| `settings.get` | | | the owner's values over your defaults |
| `notify` | `notifications` | `{ text }` | `true` |
| `panel.open` | | `{ panel? }` | `true` |

Events, each only if named in `events` and covered by a permission:

| Event | Needs | Data |
| --- | --- | --- |
| `turn.started` | `turns:read` | `{ agentId, conversationId }` |
| `turn.finished` | `turns:read` | `{ agentId, conversationId }` |
| `agents.changed` | `agents:read` | `{ agents: [{ id, name, working }] }` |
| `selection.changed` | `agents:read` | `{ agent }` |
| `theme.changed` | | `{ scheme, background, foreground, muted, border, accent }` |

Events start once your document is loaded; read the current state with a
call when it starts rather than waiting for the first event.

## Looking at home

Bloks sets these CSS variables, and keeps them current when the theme
changes: `--bloks-bg`, `--bloks-fg`, `--bloks-muted`, `--bloks-border`,
`--bloks-accent`, and the same colours as `--background`, `--foreground`,
`--muted-foreground`, `--border` and `--brand` for panels written for
other hosts. The page's background and text already use them.

## A whole example

`panel.html`:

```html
<link rel="stylesheet" href="panel.css">
<h1>Team status</h1>
<ul id="agents"></ul>
<script src="panel.js"></script>
```

`panel.js`:

```js
const list = document.getElementById("agents");
function draw(agents) {
  list.replaceChildren(...agents.map((a) => {
    const li = document.createElement("li");
    li.textContent = `${a.name}: ${a.working ? "working" : "idle"}`;
    return li;
  }));
}
bloks.call("agents.list").then(draw);
bloks.on("agents.changed", (e) => draw(e.agents));
```

`background.js`:

```js
bloks.onCommand("draft-status", ({ agentId }) =>
  bloks.call("composer.insert", { agentId, text: "Give me a two-line status update." }));
```

## Trying it

In Bloks, Settings, Plugins, Add, Install an extension: pick the folder,
read what it asks for, and Install and allow. After changing a file, use
Look for an update on its page: the owner's copy is the one installed,
and an installed copy changed on disk is stopped until it is installed
again. Errors your code throws are shown on the extension's page.

## Not yet

Installing from a GitHub release, secret settings, a background document
with no window open, more events, and panels in the phone apps.
