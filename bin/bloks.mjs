#!/usr/bin/env node
// The command line an agent drives as itself.
//
// JSON in, JSON out, one request per invocation. It is deliberately thin:
// every command is a request the workspace already answers, so the rules
// about what an agent may do live in one place on the server rather than
// being half-enforced here.
//
// It reads its credential from the environment, which is where the turn
// put it. Nothing is stored, nothing is cached, and there is no login: a
// credential that outlives its turn would be a credential worth stealing.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// the running server writes its port down, and it is not always 8799
const writtenPort = (() => {
  try {
    return readFileSync(join(homedir(), ".bloks", "port"), "utf8").trim();
  } catch {
    return "";
  }
})();
const BASE = process.env.BLOKS_URL || `http://127.0.0.1:${/^\d+$/.test(writtenPort) ? writtenPort : "8799"}`;
const TOKEN = process.env.BLOKS_TOKEN || "";

/** Everything this understands, and what each one is for. */
const COMMANDS = {
  whoami: {
    use: "whoami",
    about: "who this credential says you are",
    run: () => request("GET", "/api/agent/whoami"),
  },
  agents: {
    use: "agents",
    about: "everyone in the workspace, with their roles and skills",
    run: async () => {
      const { bots } = await request("GET", "/api/bots?messages=0");
      // an archived agent cannot answer, so listing it by name only
      // invites a message nobody reads; the MCP server leaves it out too
      return bots.filter((bot) => !bot.hidden && !bot.archivedAt).map((bot) => ({
        id: bot.id,
        name: bot.name,
        title: bot.title,
        skills: bot.skills ?? [],
        busy: Boolean(bot.busy),
        // where it sits in the sidebar; `sidebar` has the places
        section: bot.section ?? null,
        pinned: Boolean(bot.pinned),
      }));
    },
  },
  rooms: {
    use: "rooms",
    about: "the rooms that exist, and who is in them",
    run: async () => {
      const { bloks } = await request("GET", "/api/bloks");
      // an archived room is out of the sidebar, so it stays out of this list too
      return (bloks ?? []).filter((room) => !room.archived).map((room) => ({ id: room.id, name: room.name, members: room.memberIds }));
    },
  },
  say: {
    use: "say <agent-id|room-id> <text…>",
    about: "say something to another agent, or in a room",
    run: async (args) => {
      const [target, ...rest] = args;
      const text = rest.join(" ");
      if (!target || !text) throw new Error("say needs someone to say it to, and something to say");
      // an id is either an agent or a room; try the agent first because
      // that is what most of them are
      try {
        return await request("POST", `/api/bots/${target}/messages`, { text });
      } catch (error) {
        if (!/no such agent/i.test(String(error.message))) throw error;
        return await request("POST", `/api/bloks/${target}/messages`, { text });
      }
    },
  },
  recall: {
    use: "recall <words…> | recall --id <message-id>",
    about: "look something up in your own past conversations: a decision, a name, a preference",
    run: async (args) => {
      const flags = parseFlags(args);
      const me = await request("GET", "/api/agent/whoami");
      // one message in full, for a hit that was cut short
      if (flags.id && flags.id !== "true") {
        return (await request("GET", `/api/bots/${me.botId ?? me.id}/recall/${encodeURIComponent(flags.id)}`)).message;
      }
      const words = args.join(" ").trim();
      if (!words) throw new Error("recall needs something to look for");
      const { hits } = await request("GET", `/api/bots/${me.botId ?? me.id}/recall?q=${encodeURIComponent(words)}`);
      return hits.map((hit) => (hit.clipped ? { ...hit, full: `bloks recall --id ${hit.messageId}` } : hit));
    },
  },
  watch: {
    use: 'watch --folder <path> | --page <url> | --feed <url> | --check "<command>" --do "<what to do when it changes>" [--name <name>] [--every <minutes>] [--mentions <text>] [--thread <conversation>] [--rehearse]',
    about:
      "act when a folder, a web page or a feed changes, or when a cheap check you wrote finds something: " +
      "--check runs a command every --every minutes without waking you; exit 0 means act (what it prints is passed on), exit 1 means nothing to do. " +
      "Unless you may run commands without asking, the person approves the command before it runs. " +
      "--thread sends its turns to that conversation (made if missing), so work you started in the background is picked up where its context is",
    run: (args) => {
      const flags = parseFlags(args);
      const kind = flags.folder ? "folder" : flags.page ? "page" : flags.feed ? "feed" : flags.check ? "check" : null;
      if (!kind) throw new Error("watch needs --folder, --page, --feed or --check");
      if (!flags.do) throw new Error('watch needs --do "what to do when it changes"');
      return request("POST", "/api/watchers", {
        kind,
        target: flags[kind],
        instruction: flags.do,
        name: flags.name,
        every: flags.every ? Number(flags.every) : undefined,
        mentions: flags.mentions,
        ...(flags.thread ? { thread: flags.thread } : {}),
        mode: flags.rehearse ? "rehearse" : "act",
      });
    },
  },
  watchers: {
    use: "watchers",
    about: "your watchers, and when each last fired",
    run: async () => (await request("GET", "/api/watchers")).watchers,
  },
  unwatch: {
    use: "unwatch <watcher-id>",
    about: "stop one of your watchers",
    run: (args) => {
      if (!args[0]) throw new Error("unwatch needs a watcher id");
      return request("DELETE", `/api/watchers/${args[0]}`);
    },
  },
  history: {
    use: "history <room-id> [--limit <n>]",
    about: "read what was said in a room you are in, newest last, so you can join a discussion with its context",
    run: async (args) => {
      const [room] = args;
      if (!room || room.startsWith("--")) throw new Error("history needs a room id, from `rooms`");
      const flags = parseFlags(args.slice(1));
      const limit = Math.max(1, Math.min(200, Number(flags.limit) || 40));
      const [{ messages }, { bots }] = await Promise.all([
        request("GET", `/api/bloks/${encodeURIComponent(room)}/messages?limit=${limit}`),
        request("GET", "/api/bots?messages=0"),
      ]);
      const names = new Map((bots ?? []).map((b) => [b.id, b.name]));
      return (messages ?? [])
        .filter((m) => m.kind === "text" && m.text && !m.deleted)
        .map((m) => ({
          id: m.id,
          at: localStamp(new Date(m.at)),
          // only the person's own words read as the person's
          who: m.from ? (names.get(m.from) ?? "an agent") : m.author ? "a member" : "the person",
          by: m.from ? "agent" : m.author ? "member" : "person",
          ...(m.from ? { agentId: m.from } : {}),
          text: m.text,
        }));
    },
  },
  stop: {
    use: 'stop <agent-id> ["<why>"]',
    about: "stop the current turn of an agent you hired, or one you outrank in a room you share; your reason is the next thing it hears",
    run: (args) => {
      const [target, ...rest] = args;
      if (!target) throw new Error("stop needs the agent to stop");
      const why = rest.join(" ").trim();
      return request("POST", `/api/bots/${encodeURIComponent(target)}/interrupt`, why ? { text: why } : {});
    },
  },
  archive: {
    use: 'archive <agent-id> ["<what was finished>"]',
    about: "archive an agent you hired once its work is done and nothing is left running, waiting or scheduled for it; the person can restore it",
    run: (args) => {
      const [target, ...rest] = args;
      if (!target) throw new Error("archive needs the agent to archive");
      const note = rest.join(" ").trim();
      return request("POST", `/api/bots/${encodeURIComponent(target)}/archive`, note ? { note } : {});
    },
  },
  note: {
    use: 'note "<one short fact about the person>"',
    about: "suggest a lasting note about the person you work for; they decide whether to keep it",
    run: async (args) => {
      const text = args.join(" ").trim();
      if (!text) throw new Error("note needs the fact to suggest");
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", `/api/bots/${me.botId ?? me.id}/notes`, { text });
    },
  },
  hire: {
    use: 'hire --name <name> --title <role> [--about <description>] [--skills "a,b,c"] [--section <name>] [--pin] [--at <position>]',
    about:
      "add a teammate to the workspace, optionally filed into a sidebar section, and pinned there " +
      "(--pin puts it after the pins already there; --at puts it at that place among them, 1 at the top)",
    run: (args) => {
      const flags = parseFlags(args);
      if (!flags.name) throw new Error("hire needs a --name");
      const at = flags.at === undefined ? undefined : placeNumber(flags.at);
      return request("POST", "/api/bots", {
        name: flags.name,
        title: flags.title ?? "",
        description: flags.about ?? "",
        skills: flags.skills ? flags.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        ...(flags.section !== undefined ? { section: flags.section } : {}),
        ...(flags.pin !== undefined || at !== undefined ? { pinned: true } : {}),
        ...(at !== undefined ? { position: at } : {}),
      });
    },
  },
  sidebar: {
    use: "sidebar",
    about:
      "how the person's sidebar is arranged: its sections in order (section null is the unfiled list at the top), " +
      "and in each what is pinned at which position and what else is there. Read it before you file, pin or move anything",
    run: async () => {
      const { sections } = await request("GET", "/api/sidebar");
      return (sections ?? []).map((s) => ({ section: s.name, pinned: s.pinned, others: s.others }));
    },
  },
  file: {
    use: "file <agent-id|room-id> <section…>",
    about: "file an agent (yourself or a teammate) or a room you are in into a sidebar section; an empty section unfiles it. A pinned one stays pinned, after the pins already there",
    run: (args) => {
      const [target, ...rest] = args;
      if (!target) throw new Error("file needs an agent or room id, then the section");
      return place(target, { section: rest.join(" ").trim() });
    },
  },
  pin: {
    use: "pin <agent-id|room-id> [--at <position>] [--section <name>]",
    about:
      "hold an agent, or a room you are in, in place in the sidebar instead of letting it sort by recent activity with the person: " +
      "at --at among the pins of its section (1 is the top; without it, after the pins already there), and filed into --section first when given",
    run: (args) => {
      const [target, ...rest] = args;
      if (!target || target.startsWith("--")) throw new Error("pin needs an agent or room id, from `sidebar`");
      const flags = parseFlags(rest);
      if (flags.section === "true") throw new Error('--section needs a name, quoted when it has spaces: --section "Travel desk"');
      return place(target, {
        pinned: true,
        ...(flags.at !== undefined ? { position: placeNumber(flags.at) } : {}),
        ...(flags.section !== undefined ? { section: flags.section } : {}),
      });
    },
  },
  unpin: {
    use: "unpin <agent-id|room-id>",
    about: "let an agent, or a room you are in, sort by recent activity with the person again",
    run: ([target]) => {
      if (!target) throw new Error("unpin needs an agent or room id, from `sidebar`");
      return place(target, { pinned: false });
    },
  },
  room: {
    use: 'room --name <name> --members "id,id"',
    about: "open a room and put people in it",
    run: (args) => {
      const flags = parseFlags(args);
      if (!flags.name) throw new Error("room needs a --name");
      return request("POST", "/api/bloks", {
        name: flags.name,
        memberIds: (flags.members ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
    },
  },
  routines: {
    use: "routines",
    about: "what is scheduled, for everyone: when each runs next, and which run once",
    run: async () => {
      const { routines } = await request("GET", "/api/routines");
      // what an agent needs to decide whether to file another, not every
      // past run of every routine
      return (routines ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? r.prompt.slice(0, 60),
        for: r.targetId,
        when: r.summary,
        ...(r.repeat === "once" ? { once: r.date } : {}),
        next: r.nextRunAt ? localStamp(new Date(r.nextRunAt)) : null,
        enabled: r.enabled,
      }));
    },
  },
  routine: {
    use: 'routine --prompt <text> --time HH:MM [--date YYYY-MM-DD | --days "1,2,3"] [--name <name>] [--thread <conversation>]',
    about: "file a routine for yourself: weekly, or once on --date to come back to something later",
    run: async (args) => {
      const flags = parseFlags(args);
      if (!flags.prompt) throw new Error("a routine needs a --prompt");
      if (!/^\d{1,2}:\d{2}$/.test(flags.time ?? "")) throw new Error("a routine needs a --time like 09:00");
      let once = null;
      if (flags.date !== undefined) {
        if (flags.days !== undefined) throw new Error("a routine runs once on a --date or weekly on --days, not both");
        once = onceAt(flags.date, flags.time);
      }
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", "/api/routines", {
        targetId: me.botId,
        targetKind: "agent",
        name: flags.name,
        prompt: flags.prompt,
        time: flags.time,
        // its own conversation, so it does not share context with the rest
        ...(flags.thread ? { thread: flags.thread } : {}),
        ...(once
          ? { repeat: "once", date: once, days: [] }
          : { days: (flags.days ?? "").split(",").map((d) => Number(d.trim())).filter((d) => Number.isInteger(d)) }),
      });
    },
  },
  unroutine: {
    use: "unroutine <routine-id>",
    about: "drop a routine, one you no longer need or a one-time one you filed by mistake",
    run: (args) => {
      if (!args[0]) throw new Error("unroutine needs a routine id, from `routines`");
      return request("DELETE", `/api/routines/${encodeURIComponent(args[0])}`);
    },
  },
  jobs: {
    use: "jobs",
    about: "the job board",
    run: () => request("GET", "/api/jobs"),
  },
  post: {
    use: "post --title <title> [--brief <text>]",
    about: "put work on the board without naming who does it",
    run: (args) => {
      const flags = parseFlags(args);
      if (!flags.title && !flags.brief) throw new Error("a job needs a --title or a --brief");
      return request("POST", "/api/jobs", { title: flags.title ?? "", brief: flags.brief ?? "" });
    },
  },
  memory: {
    use: "memory [--write <text>]",
    about: "read what you remember between conversations, or replace it",
    run: async (args) => {
      const flags = parseFlags(args);
      const me = await request("GET", "/api/agent/whoami");
      if (flags.write === undefined) return request("GET", `/api/bots/${me.botId}/memory`);
      return request("PUT", `/api/bots/${me.botId}/memory`, { text: flags.write });
    },
  },
  rename: {
    use: "rename <title…>",
    about: "rename the conversation you are in, when its name no longer says what it is about",
    run: async (args) => {
      const title = args.join(" ").trim();
      if (!title) throw new Error("rename needs the new name");
      const me = await request("GET", "/api/agent/whoami");
      const { bot } = await request("PATCH", `/api/bots/${me.botId}/tasks/${me.taskId}`, { title });
      // the task, not the whole agent record and its transcript
      return (bot?.tasks ?? []).find((t) => t.id === me.taskId) ?? { ok: true };
    },
  },
  close: {
    use: "close",
    about: "close the conversation you are in once this turn ends, when its work is done (General is never closed)",
    run: async () => {
      const me = await request("GET", "/api/agent/whoami");
      return request("DELETE", `/api/bots/${me.botId}/tasks/${me.taskId}`);
    },
  },
  fresh: {
    use: "fresh",
    about:
      "start a fresh engine session in the conversation you are in, once this turn ends: the transcript stays, but your next turn begins without the old context. Put anything you need to keep in memory first",
    run: async () => {
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", `/api/bots/${me.botId}/tasks/${me.taskId}/fresh`);
    },
  },
  skills: {
    use: "skills",
    about: "the skill library, names and what each is for",
    run: async () => {
      const { skills } = await request("GET", "/api/skills");
      // names and descriptions, because the whole library is the thing
      // this command exists to avoid pulling into a conversation
      return (skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description }));
    },
  },
  show: {
    use: "show <kind> <json>",
    about: "answer with a component instead of prose: chart, table, decision, steps, quote, refused",
    run: async ([kind, ...rest]) => {
      if (!kind) throw new Error("show needs a kind: chart, table, decision, steps, quote or refused");
      const body = rest.join(" ").trim();
      if (!body) throw new Error("show needs the component as JSON");
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("that is not JSON. Pass the component as one JSON object");
      }
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", `/api/bots/${me.botId}/show`, { kind, data });
    },
  },
  skill: {
    use: "skill <id>",
    about: "read one skill in full",
    run: ([id]) => {
      if (!id) throw new Error("skill needs an id, from `skills`");
      return request("GET", `/api/skills/${encodeURIComponent(id)}`);
    },
  },
};

/** A place among the pins, checked here so a typo is an error now. */
function placeNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--at is a place among the pins: 1, 2, 3, with 1 at the top");
  return n;
}

/**
 * Where an agent or a room sits in the sidebar, changed, and read back as
 * the sidebar now has it. An id is either; the agent is tried first
 * because that is what most of them are, as `say` does.
 */
async function place(target, body) {
  const id = encodeURIComponent(target);
  try {
    await request("PATCH", `/api/bots/${id}`, body);
  } catch (error) {
    if (!/no such agent/i.test(String(error.message))) throw error;
    await request("PATCH", `/api/bloks/${id}`, body);
  }
  const { sections } = await request("GET", "/api/sidebar");
  for (const section of sections ?? []) {
    const pin = section.pinned.find((row) => row.id === target);
    if (pin) return { ...pin, section: section.name, pinned: true };
    const other = section.others.find((row) => row.id === target);
    if (other) return { ...other, section: section.name, pinned: false };
  }
  return { ok: true };
}

/** The date a one-time routine runs, checked here so a typo is an error
 * now and not a routine that silently never fires: a real day, at a time
 * that has not passed yet on this Mac. */
function onceAt(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) throw new Error("--date is a day like 2026-10-08");
  const [hours, minutes] = time.split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new Error("--time is a time of day like 09:00");
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hours, minutes);
  if (at.getFullYear() !== Number(match[1]) || at.getMonth() !== Number(match[2]) - 1 || at.getDate() !== Number(match[3])) {
    throw new Error(`there is no ${date}`);
  }
  if (at.getTime() <= Date.now()) throw new Error(`${date} ${time} has already passed`);
  return date;
}

/** A moment in this Mac's own time, the way routines are written. */
function localStamp(at) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `--flag value` and `--flag=value`, both of which somebody will type. */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals > 0) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = args[i + 1];
    flags[arg.slice(2)] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return flags;
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      // the workspace refuses anything that does not look like it came
      // from this machine, and this is what says so
      origin: BASE,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`the workspace answered something that is not JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(parsed.error ?? `${response.status} ${response.statusText}`);
  return parsed;
}

function help() {
  return {
    about:
      "Act on this Bloks workspace as yourself. Every command answers JSON. " +
      "Your credential is in the environment and lasts one turn.",
    commands: Object.entries(COMMANDS).map(([name, command]) => ({
      use: command.use,
      about: command.about,
      name,
    })),
  };
}

const [name, ...args] = process.argv.slice(2);

try {
  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(`${JSON.stringify(help(), null, 2)}\n`);
    process.exit(0);
  }
  const command = COMMANDS[name];
  if (!command) {
    process.stdout.write(
      `${JSON.stringify({ error: `no such command: ${name}`, ...help() }, null, 2)}\n`,
    );
    process.exit(2);
  }
  if (!TOKEN) throw new Error("no credential in this environment, so there is nobody to act as");
  const result = await command.run(args);
  process.stdout.write(`${JSON.stringify(result ?? { ok: true }, null, 2)}\n`);
} catch (error) {
  // an error is JSON too: the caller is a model, and a stack trace on
  // stderr is a turn spent working out what went wrong
  process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
}
