#!/usr/bin/env node
// Bloks as an MCP server, for Claude Desktop, Claude Code, Cursor and any
// other tool that speaks the Model Context Protocol over stdio.
//
// Your agents become something the AI you already use can ask: "have
// Scout draft the release notes", "what did Ivy find", "what is waiting
// on me". It is a deliberately small surface. It can read and talk; it
// cannot answer approvals, delete anything, change settings or see keys,
// because a tool driven by another model is exactly where a stray
// instruction would do the most damage.
//
// It talks to the Bloks running on this machine, over the same local API
// the app uses, and finds it on the ports the app listens on. Nothing
// else: no network, no dependencies, no state of its own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PORTS = [8799, 18799, 28799];
const PROTOCOL = "2025-06-18";
let base = process.env.BLOKS_URL || null;

/** The port the running server wrote down, first: when the usual ports
 * are taken the app listens somewhere else. */
function writtenPort() {
  try {
    const port = Number(readFileSync(join(homedir(), ".bloks", "port"), "utf8").trim());
    return Number.isInteger(port) && port > 0 ? [port] : [];
  } catch {
    return [];
  }
}

async function findBloks() {
  if (base) return base;
  for (const port of [...new Set([...writtenPort(), ...PORTS])]) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      const body = await res.json();
      if (body?.app === "bloks") return (base = url);
    } catch {
      /* not here */
    }
  }
  throw new Error("Bloks is not running on this computer. Open the Bloks app, then try again.");
}

async function call(method, path, body) {
  const url = await findBloks();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Bloks answered ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function agents() {
  const { bots } = await call("GET", "/api/bots?messages=0");
  return (bots ?? []).filter((b) => !b.hidden && !b.archivedAt);
}

/** An agent by id or by name, case and spacing forgiven. */
async function agentNamed(who) {
  const want = String(who ?? "").trim().toLowerCase();
  const all = await agents();
  const found = all.find((b) => b.id === who) ?? all.find((b) => b.name.toLowerCase() === want) ?? all.find((b) => b.name.toLowerCase().startsWith(want));
  if (!found) throw new Error(`No agent called "${who}". Agents: ${all.map((b) => b.name).join(", ") || "none"}.`);
  return found;
}

async function roomNamed(which) {
  const want = String(which ?? "").trim().toLowerCase();
  const { bloks } = await call("GET", "/api/bloks");
  const found = (bloks ?? []).find((r) => r.id === which) ?? (bloks ?? []).find((r) => r.name.toLowerCase() === want);
  if (!found) throw new Error(`No room called "${which}". Rooms: ${(bloks ?? []).map((r) => r.name).join(", ") || "none"}.`);
  return found;
}

const lines = (messages, nameOf) =>
  messages
    .filter((m) => m.kind === "text" && m.text && !m.deleted)
    .map((m) => `${m.role === "user" ? "You" : nameOf(m)}: ${m.text}`)
    .join("\n\n");

// ── lanes ─────────────────────────────────────────────────────────────
//
// An agent keeps several conversations ("lanes") and works in whichever a
// message went to. Reading only the open one is how a reply sat unseen in
// another lane while this said "still working". So every tool here names
// the lane it used, and read_conversation remembers the one ask_agent
// just wrote to.

/** The lane ask_agent last used, per agent, for read_conversation. */
const lastLane = new Map();

/** A lane by id or title (case forgiven, a prefix will do), or the open one. */
function laneOf(bot, which) {
  const lanes = bot.tasks ?? [];
  if (which) {
    const want = String(which).trim().toLowerCase();
    const found =
      lanes.find((t) => t.id === which) ??
      lanes.find((t) => t.title.toLowerCase() === want) ??
      lanes.find((t) => t.title.toLowerCase().startsWith(want));
    if (!found) throw new Error(`${bot.name} has no conversation called "${which}". Conversations: ${lanes.map((t) => t.title).join(", ")}.`);
    return found;
  }
  return lanes.find((t) => t.id === (bot.activeTaskId ?? bot.threadId)) ?? lanes[0] ?? { id: bot.threadId, title: "General" };
}

/** The latest messages of one lane, whichever lane is open in the app. */
async function laneMessages(bot, laneId, count = 30) {
  const { messages } = await call("GET", `/api/bots/${bot.id}/messages?thread=${encodeURIComponent(laneId)}&limit=${count}`);
  return messages ?? [];
}

const stateWord = (t) => (t.state === "needs-you" ? "waiting on you" : t.state === "working" ? "working" : "idle");

const TOOLS = [
  {
    name: "list_agents",
    description:
      "Everyone in the Bloks workspace: name, role, whether they are working, and their conversations (lanes) with each one's state.",
    inputSchema: { type: "object", properties: {} },
    run: async () =>
      (await agents())
        .map((b) => {
          const head = `- ${b.name}${b.title ? ` (${b.title})` : ""}${b.busy ? ", working" : ""}`;
          const lanes = (b.tasks ?? []).map((t) => `${t.title} (${stateWord(t)})`).join(", ");
          return lanes && (b.tasks ?? []).length > 1 ? `${head}\n  conversations: ${lanes}` : head;
        })
        .join("\n") || "No agents yet.",
  },
  {
    name: "list_rooms",
    description: "The rooms in the Bloks workspace and who is in each.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const [{ bloks }, all] = await Promise.all([call("GET", "/api/bloks"), agents()]);
      const name = (id) => all.find((b) => b.id === id)?.name ?? "someone";
      // an archived room is out of the sidebar, so it stays out of this list too
      return (bloks ?? []).filter((r) => !r.archived).map((r) => `- ${r.name}: ${(r.memberIds ?? []).map(name).join(", ")}`).join("\n") || "No rooms yet.";
    },
  },
  {
    name: "ask_agent",
    description:
      "Send a message to one of your Bloks agents, as if you typed it in the app, and wait for its reply (up to three minutes). It goes to the conversation open in the app unless you name one with `lane`. The answer says which conversation was used; read_conversation reads it later. The agent works with its own tools and asks you in Bloks before anything consequential.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's name, as in list_agents" },
        message: { type: "string", description: "What to ask or tell it" },
        lane: { type: "string", description: "Which conversation, by title as in list_agents (default: the one open in the app)" },
        wait: { type: "boolean", description: "Wait for the reply (default true)" },
      },
      required: ["agent", "message"],
    },
    run: async ({ agent, message, lane, wait = true }) => {
      const bot = await agentNamed(agent);
      const text = String(message ?? "").trim();
      if (!text) throw new Error("ask_agent needs a message");
      const chosen = lane ? laneOf(bot, lane) : null;
      const before = Date.now();
      const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text, ...(chosen ? { taskId: chosen.id } : {}) });
      const laneId = sent.taskId ?? chosen?.id ?? laneOf(bot).id;
      const laneTitle = sent.lane ?? chosen?.title ?? laneOf(bot).title;
      lastLane.set(bot.id, laneId);
      const where = `in "${laneTitle}"`;
      if (sent.queued) return `${bot.name} is busy ${where}; your message is queued there and goes in when this turn finishes.`;
      if (!wait) return `Sent to ${bot.name} ${where}. It will answer in Bloks.`;
      const until = Date.now() + 180_000;
      await sleep(1500);
      while (Date.now() < until) {
        const said = await laneMessages(bot, laneId, 30);
        const replies = said.filter((m) => m.role === "bot" && m.at >= before && m.kind === "text" && m.text);
        const card = said.find((m) => m.at >= before && m.kind === "options" && m.card && !m.card.answered && !m.card.dismissed);
        const now = (await agents()).find((b) => b.id === bot.id);
        const state = now?.tasks?.find((t) => t.id === laneId)?.state;
        if (card && state === "needs-you") {
          return `${bot.name} is waiting on you ${where}: ${card.card.title}${card.card.subtitle ? `, ${card.card.subtitle}` : ""}. Answer it in Bloks.`;
        }
        if (state !== "working" && replies.length) return `${bot.name} ${where}:\n\n${replies.map((m) => m.text).join("\n\n")}`;
        await sleep(1500);
      }
      return `${bot.name} is still working ${where}. read_conversation with this agent will show the answer when it lands.`;
    },
  },
  {
    name: "message_room",
    description: "Say something in a Bloks room. The most senior member answers last, after the others.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, message: { type: "string" } },
      required: ["room", "message"],
    },
    run: async ({ room, message }) => {
      const r = await roomNamed(room);
      await call("POST", `/api/bloks/${r.id}/messages`, { text: String(message ?? "") });
      return `Posted in ${r.name}. The members will answer in Bloks.`;
    },
  },
  {
    name: "read_conversation",
    description:
      "The latest messages in a conversation with an agent, or in a room. For an agent it reads the conversation ask_agent last used, or the one you name with `lane`, or else the one open in the app.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "An agent's name" },
        lane: { type: "string", description: "Which of the agent's conversations, by title" },
        room: { type: "string", description: "Or a room's name" },
        limit: { type: "number", description: "How many messages, up to 50 (default 20)" },
      },
    },
    run: async ({ agent, lane, room, limit = 20 }) => {
      const count = Math.max(1, Math.min(50, Number(limit) || 20));
      const all = await agents();
      const nameOf = (m) => all.find((b) => b.id === m.from)?.name ?? "Agent";
      if (room) {
        const r = await roomNamed(room);
        const { messages } = await call("GET", `/api/bloks/${r.id}/messages?limit=${count}`);
        return lines(messages ?? [], nameOf) || "Nothing said yet.";
      }
      const bot = await agentNamed(agent);
      const remembered = !lane && lastLane.has(bot.id) ? (bot.tasks ?? []).find((t) => t.id === lastLane.get(bot.id)) : null;
      const chosen = remembered ?? laneOf(bot, lane);
      const said = lines(await laneMessages(bot, chosen.id, count), () => bot.name);
      const others = (bot.tasks ?? []).filter((t) => t.id !== chosen.id).map((t) => t.title);
      const header = `Conversation "${chosen.title}" with ${bot.name}${others.length ? ` (others: ${others.join(", ")})` : ""}`;
      return `${header}\n\n${said || "Nothing said yet."}`;
    },
  },
  {
    name: "read_message",
    description:
      "One whole message, by the id a search result gives (search shows snippets only). Use it to read a long answer in full.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The id from a search result, like thread/message" } },
      required: ["id"],
    },
    run: async ({ id }) => {
      const [thread, messageId] = String(id ?? "").split("/");
      if (!thread || !messageId) throw new Error("read_message needs an id like thread/message, from a search result");
      const { message, conversation } = await call("GET", `/api/threads/${encodeURIComponent(thread)}/messages/${encodeURIComponent(messageId)}`);
      const all = await agents();
      const who = message.role === "user" ? "You" : (all.find((b) => b.id === message.from)?.name ?? all.find((b) => (b.tasks ?? []).some((t) => t.id === thread))?.name ?? "Agent");
      const when = new Date(message.at).toISOString().replace("T", " ").slice(0, 16);
      const body = message.text ?? message.card?.title ?? "(no text)";
      return `${who}${conversation ? ` in "${conversation}"` : ""}, ${when}:\n\n${body}`;
    },
  },
  {
    name: "search",
    description: "Search every conversation in Bloks for some words.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: async ({ query }) => {
      const { hits } = await call("GET", `/api/search?q=${encodeURIComponent(String(query ?? ""))}&limit=15`);
      return (
        (hits ?? [])
          .map((h) => `- ${new Date(h.at).toISOString().slice(0, 10)}, ${h.name}${h.task ? ` (${h.task})` : ""}: ${h.snippet} [id: ${h.threadId}/${h.messageId}]`)
          .join("\n") + (hits?.length ? "\n\nread_message with an id opens that message in full." : "")
      ) || "Nothing matches.";
    },
  },
  {
    name: "morning_brief",
    description: "The latest morning brief: what the agents did, and what is waiting on you.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const { briefs } = await call("GET", "/api/briefs");
      const brief = briefs?.[0];
      if (!brief) return "No brief yet.";
      const parts = brief.parts
        .filter((p) => p.botId)
        .map((p) => `${p.name}:\n${p.items.map((i) => `- ${i.text}`).join("\n")}`)
        .join("\n\n");
      const waiting = brief.waiting.map((w) => `- ${w.name}: ${w.title}`).join("\n");
      return [`${new Date(brief.at).toDateString()}. ${brief.headline}`, parts, waiting && `Waiting on you:\n${waiting}`].filter(Boolean).join("\n\n");
    },
  },
  {
    name: "waiting_on_me",
    description: "Questions and approvals your agents are waiting on right now. Answer them in Bloks.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const [{ waiting }, all] = await Promise.all([call("GET", "/api/waiting"), agents()]);
      const laneTitle = (w) => all.find((b) => b.id === w.botId)?.tasks?.find((t) => t.id === w.threadId)?.title;
      return (
        (waiting ?? [])
          .map((w) => {
            const lane = laneTitle(w);
            return `- ${w.name}${lane ? ` in "${lane}"` : ""} ${w.kind === "approval" ? "wants your OK" : "asks"}: ${w.title}`;
          })
          .join("\n") || "Nothing is waiting on you."
      );
    },
  },
];

// ── the protocol: JSON-RPC 2.0, one message per line ──────────────────

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // a notification; nothing to answer
  try {
    if (method === "initialize") {
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "bloks", version: "1.1.0" },
          instructions: "Bloks is the person's team of AI agents on their own computer. Use ask_agent to hand an agent work, and waiting_on_me to see what needs the person.",
        },
      });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      return send({ id, result: { tools: TOOLS.map(({ run: _run, ...tool }) => tool) } });
    }
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const text = await tool.run(params?.arguments ?? {});
        return send({ id, result: { content: [{ type: "text", text: String(text) }] } });
      } catch (error) {
        return send({ id, result: { content: [{ type: "text", text: error.message || String(error) }], isError: true } });
      }
    }
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    return send({ id, error: { code: -32603, message: error.message || String(error) } });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  void handle(message);
});
