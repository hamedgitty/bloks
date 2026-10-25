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
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

// the running server writes its port down, and it is not always 8799;
// it writes it in its data folder, which BLOKS_DATA_DIR can move
const dataDir = (() => {
  const said = process.env.BLOKS_DATA_DIR?.trim();
  if (!said) return join(homedir(), ".bloks");
  if (said === "~") return homedir();
  return said.startsWith("~/") ? join(homedir(), said.slice(2)) : resolve(said);
})();
const writtenPort = (() => {
  try {
    return readFileSync(join(dataDir, "port"), "utf8").trim();
  } catch {
    return "";
  }
})();
const BASE = process.env.BLOKS_URL || `http://127.0.0.1:${/^\d+$/.test(writtenPort) ? writtenPort : "8799"}`;
const TOKEN = process.env.BLOKS_TOKEN || "";

/** Everything this understands, and what each one is for. */
const COMMANDS = {
  reply: {
    use: "reply <text...>",
    about: "reply to the group message that started this turn, with no target; every member sees it",
    run: (args) => {
      const token = process.env.BLOKS_REPLY_TOKEN || (TOKEN.startsWith("blr_") ? TOKEN : "");
      const path = process.env.BLOKS_REPLY_PATH;
      if (!token || !path) throw new Error("this turn has no bound reply to a sender");
      return request("POST", path, { text: args.join(" ") }, token);
    },
  },
  whoami: {
    use: "whoami",
    about: "who this credential says you are",
    run: () => request("GET", "/api/agent/whoami"),
  },
  settings: {
    use: "settings [--category <category>] [--id <reference>] [--cursor <continuation>]",
    about: "inspect safe settings and their owner controls. A device category asks the owner's open windows and connected phone once and says how fresh each answer is; nothing a device has not said is filled in. This command never changes a setting",
    run: (args) => {
      const flags = parseFlags(args);
      if (args.some((arg, i) => i % 2 === 0 && !["--category", "--id", "--cursor"].includes(arg)) || args.length % 2) {
        throw new Error("settings accepts only --category, --id and --cursor with values");
      }
      const query = new URLSearchParams();
      for (const key of ["category", "id", "cursor"]) {
        if (flags[key]) query.set(key, flags[key]);
      }
      return request("GET", `/api/agent/settings${query.size ? `?${query}` : ""}`);
    },
  },
  goal: {
    use: "goal",
    about:
      "the goal the person set for this conversation, if any: what done looks like, which turn this is of how many, " +
      "and the check that has to pass. Only the person sets or changes a goal",
    // nothing to pass: the credential already names the conversation, and
    // a goal is read here, never set
    run: () => request("GET", "/api/agent/goal"),
  },
  location: {
    use: "location [--fresh]",
    about:
      "where the person's iPhone last placed them, how long ago and how exactly (a city, a neighbourhood, or an exact position), " +
      "or why it is not known: sharing off or paused, or nothing said yet. --fresh asks the phone for a new reading and waits up to 15 seconds; " +
      "it can answer only while Bloks is open on it, and says plainly when none came. Never treat an old or approximate reading as where they are right now: " +
      "say its age, or ask",
    run: (args) => {
      if (args.some((arg) => arg !== "--fresh")) throw new Error("location takes only --fresh");
      return request("GET", `/api/agent/location${args.includes("--fresh") ? "?fresh=1" : ""}`);
    },
  },
  agents: {
    use: "agents",
    about:
      "everyone in the workspace, with their roles and skills, and whether each one's engine can answer now: " +
      "ready, not signed in, out until a time, or unavailable. Only the person can fix the last three",
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
        engine: engineWord(bot.engine),
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
      const { bloks } = await request("GET", "/api/bloks?messages=0");
      // an archived room is out of the sidebar, so it stays out of this list too
      return (bloks ?? []).filter((room) => !room.archived).map((room) => ({ id: room.id, name: room.name, members: room.memberIds }));
    },
  },
  say: {
    use: "say <agent-id|room-id> [--now] [--task <name>] <text…>",
    about:
      "say something to another agent, or in a room. A busy agent hears it when its turn ends; " +
      "--now is for a correction to work already under way: it goes into the running turn, read after the step it is on, " +
      "when your message started that turn or you may stop that agent, and otherwise waits as usual. Rooms keep their order. " +
      "--task names the separate piece of work this hands off (a review, a fix, a correction to one task), in up to 60 characters; " +
      "without it a message goes on with the task your turn is on. When the person allows a budget across separate tasks, " +
      "each named task counts its own turns in a row toward the limit, and every task together still counts toward that budget, " +
      "so name the work truly: a new name for the same work adds nothing. " +
      "When the agent cannot answer right now (its engine is not signed in, out until a time, or unavailable), the answer says so in `engine`",
    run: async (args) => {
      // --now and --task before the text, either side of who it is to,
      // and --now as the last word of it too, which is where somebody who
      // thought of it late puts it. Anything else is the text.
      const rest = [...args];
      let now = false;
      let task;
      const flags = (at) => {
        for (;;) {
          if (rest[at] === "--now") {
            now = true;
            rest.splice(at, 1);
          } else if (rest[at] === "--task") {
            task = rest[at + 1];
            if (!task || task.startsWith("--")) throw new Error("--task needs the name of the task this hands off");
            rest.splice(at, 2);
          } else return;
        }
      };
      flags(0);
      flags(1);
      if (rest.length > 2 && rest.at(-1) === "--now") {
        now = true;
        rest.pop();
      }
      const [target, ...words] = rest;
      const text = words.join(" ");
      if (!target || !text) throw new Error("say needs someone to say it to, and something to say");
      // an id is either an agent or a room; try the agent first because
      // that is what most of them are
      try {
        return await request("POST", `/api/bots/${target}/messages`, { text, ...(now ? { now: true } : {}), ...(task ? { task } : {}) });
      } catch (error) {
        if (!/no such agent/i.test(String(error.message))) throw error;
        const said = await request("POST", `/api/bloks/${target}/messages`, { text });
        // a room's agents speak one at a time, so nothing joins a turn
        // there, and a room's count is the room's own
        const notes = [
          ...(now ? ["Rooms keep their order, so --now does nothing there"] : []),
          ...(task ? ["A room counts its own turns, so --task does nothing there"] : []),
        ];
        return notes.length ? { ...said, note: `${notes.join(". ")}; this was said in the room as usual.` } : said;
      }
    },
  },
  "take-back": {
    use: "take-back <agent-id>",
    about: "take back all your messages still waiting for another agent, and list their words. Already received messages cannot be taken back; send a correction instead. Rooms are not included",
    run: (args) => {
      if (args.length !== 1 || !args[0]) throw new Error("take-back needs one agent id");
      return request("POST", `/api/bots/${encodeURIComponent(args[0])}/take-back`);
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
    use: 'watch --folder <path> | --page <url> | --feed <url> | --check "<command>" | --arrive <place> | --leave <place> --do "<what to do when it changes>" [--name <name>] [--every <minutes>] [--mentions <text>] [--radius <metres>] [--once] [--until <date and time>] [--thread <conversation>] [--rehearse]',
    about:
      "act when a folder, a web page or a feed changes, when a cheap check you wrote finds something, or when the person arrives at or leaves a place: " +
      "--check runs a command every --every minutes without waking you; exit 0 means act (what it prints is passed on), exit 1 means nothing to do. " +
      "Unless you may run commands without asking, the person approves the command before it runs. " +
      '--arrive and --leave take a place as their iPhone names it ("Toronto", "Shinjuku, Tokyo") or as latitude,longitude with --radius in metres (500 unless said); ' +
      "it acts when their phone next says where they are, needs location sharing on there, and a place by coordinates needs Exact position on. " +
      "--once is done after acting once; --until stops it at a time, such as 2026-10-24T18:00, when its purpose runs out. " +
      "The instruction (--do) and folder, page or feed target can each be up to 1,000 characters; a check command can be up to 500. Longer text is refused, not cut. " +
      "Its turns come to your first conversation, where the person talks to you; --thread sends them to another, by its title (made if missing) or its id",
    run: async (args) => {
      const flags = parseFlags(args);
      const kind = flags.folder ? "folder" : flags.page ? "page" : flags.feed ? "feed" : flags.check ? "check" : flags.arrive || flags.leave ? "place" : null;
      if (!kind) throw new Error("watch needs --folder, --page, --feed, --check, --arrive or --leave");
      if (flags.arrive && flags.leave) throw new Error("watch takes one of --arrive or --leave");
      if (!flags.do) throw new Error('watch needs --do "what to do when it changes"');
      if (flags.once !== undefined && flags.once !== "true" && flags.once !== "false") throw new Error("--once is true or false");
      const asked = flags.every ? Number(flags.every) : undefined;
      if (kind === "place" && flags.radius !== undefined && !Number.isFinite(Number(flags.radius))) throw new Error("--radius needs a number of metres");
      const filed = await request("POST", "/api/watchers", {
        kind,
        target: kind === "place" ? (flags.arrive ?? flags.leave) : flags[kind],
        instruction: flags.do,
        name: flags.name,
        every: asked,
        mentions: flags.mentions,
        ...(kind === "place"
          ? {
              when: flags.leave ? "leave" : "arrive",
              ...(flags.radius !== undefined ? { radius: Number(flags.radius) } : {}),
            }
          : {}),
        ...(Object.hasOwn(flags, "once") ? { once: flags.once === "true" } : {}),
        ...(Object.hasOwn(flags, "until") ? { until: flags.until } : {}),
        ...(flags.thread ? { thread: flags.thread } : {}),
        mode: flags.rehearse ? "rehearse" : "act",
      });
      // The workspace keeps --every within its bounds without saying so,
      // and an agent that asked for 2 would otherwise plan on 2 (GitHub
      // 166). A folder is watched as it changes, and a place as the phone
      // says where it is, so their --every is moot.
      const every = filed.watcher?.every;
      if (kind === "folder" || kind === "place" || !Number.isFinite(asked) || typeof every !== "number" || Math.round(asked) === every) return filed;
      const clamped = `Checks every ${every} minutes (the ${every > asked ? "minimum" : "maximum"}; you asked for ${asked}).`;
      return { ...filed, note: filed.note ? `${filed.note} ${clamped}` : clamped };
    },
  },
  watchers: {
    use: "watchers",
    about: "your watchers, and when each last fired",
    run: async () => (await request("GET", "/api/watchers")).watchers,
  },
  "edit-watch": {
    use: 'edit-watch <watcher-id> [--do "<what to do>"] [--folder <path> | --page <url> | --feed <url> | --check "<command>" | --arrive <place> | --leave <place>] [--name <name>] [--every <minutes>] [--mentions <text>] [--radius <metres>] [--once | --once=false] [--until <date and time>] [--thread <conversation>]',
    about:
      "change supplied fields of one of your watchers, keeping its id and fire history; leave out a flag to keep that field. " +
      "Use --mentions=, --thread= or --until= to clear those fields. The same text limits as watch apply. " +
      "A changed check command needs approval again unless you already run commands without asking",
    run: async (args) => {
      const [id, ...rest] = args;
      if (!id || id.startsWith("--")) throw new Error("edit-watch needs a watcher id");
      const fields = { do: "instruction", name: "name", every: "every", mentions: "mentions", thread: "thread", radius: "radius", until: "until" };
      const kinds = ["folder", "page", "feed", "check", "arrive", "leave"];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        const key = arg.split("=")[0].slice(2);
        if (!arg.startsWith("--") || (!Object.hasOwn(fields, key) && !kinds.includes(key) && key !== "once")) throw new Error(`edit-watch does not understand ${arg}`);
        // --once stands alone; --once=false takes it back
        if (key === "once") continue;
        if (!arg.includes("=")) {
          if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) throw new Error(`--${key} needs a value`);
          i++;
        }
      }
      const flags = parseFlags(rest);
      if (flags.once !== undefined && flags.once !== "true" && flags.once !== "false") throw new Error("--once is true or false");
      const targets = kinds.filter((kind) => Object.hasOwn(flags, kind));
      if (targets.length > 1) throw new Error("edit-watch takes only one of --folder, --page, --feed, --check, --arrive or --leave");
      const body = {};
      for (const [flag, field] of Object.entries(fields)) {
        if (Object.hasOwn(flags, flag)) body[field] = flag === "every" || flag === "radius" ? Number(flags[flag]) : flags[flag];
      }
      if (Object.hasOwn(flags, "once")) body.once = flags.once !== "false";
      if (targets.length) {
        const [target] = targets;
        Object.assign(body, target === "arrive" || target === "leave" ? { kind: "place", target: flags[target], when: target } : { kind: target, target: flags[target] });
      }
      if (!Object.keys(body).length) throw new Error("edit-watch needs at least one field to change");
      if (Object.hasOwn(body, "every") && !Number.isFinite(body.every)) throw new Error("--every needs a number of minutes");
      if (Object.hasOwn(body, "radius") && !Number.isFinite(body.radius)) throw new Error("--radius needs a number of metres");
      const edited = await request("PATCH", `/api/watchers/${encodeURIComponent(id)}`, body);
      const every = edited.watcher?.every;
      if (edited.watcher?.kind === "folder" || !Number.isFinite(body.every) || typeof every !== "number" || Math.round(body.every) === every) return edited;
      return { ...edited, note: `Checks every ${every} minutes (the ${every > body.every ? "minimum" : "maximum"}; you asked for ${body.every}).` };
    },
  },
  unwatch: {
    use: "unwatch <watcher-id>",
    about: "stop one of your watchers",
    run: (args) => {
      if (!args[0]) throw new Error("unwatch needs a watcher id");
      return request("DELETE", `/api/watchers/${args[0]}`);
    },
  },
  intent: {
    use: 'intent --when "<words or phrases, comma separated>" (--note "<what to post>" | --mention <agent-id> [--say "<why>"] | --message <agent-id> --say "<what to send>") [--name <name>] [--rooms "<room-id>,..."] [--cooldown <hours>]',
    about:
      "propose a standing intent: whenever one of the words or phrases comes up in a new message in your conversations or the rooms you are in, " +
      "post a note there, bring an agent in, or send an agent a short message. Matching is whole words in any case; end a word with * for its other endings (refund*). " +
      "It fires at most once a day in one conversation and three times a day in all, and stops after 90 days unless renewed. " +
      "--rooms narrows the rooms it listens in (--rooms= for none). Nothing happens until the person approves it in Automations",
    run: async (args) => {
      const flags = parseFlags(args);
      if (!flags.when || flags.when === "true") throw new Error('intent needs --when "the words to listen for"');
      const kinds = ["note", "mention", "message"].filter((kind) => Object.hasOwn(flags, kind));
      if (kinds.length !== 1) throw new Error("intent takes one of --note, --mention or --message");
      const [kind] = kinds;
      const value = flags[kind];
      if (!value || value === "true") throw new Error(kind === "note" ? "--note needs the words to post" : `--${kind} needs an agent id, from \`agents\``);
      const say = flags.say && flags.say !== "true" ? flags.say : "";
      if (kind === "message" && !say) throw new Error('--message needs --say "what to send"');
      const body = {
        phrases: flags.when.split(","),
        action: kind === "note" ? { kind, text: value } : { kind, botId: value, ...(say ? { text: say } : {}) },
        ...(flags.name && flags.name !== "true" ? { name: flags.name } : {}),
        ...(flags.cooldown !== undefined ? { cooldownHours: Number(flags.cooldown) } : {}),
      };
      if (flags.rooms !== undefined) {
        const me = await request("GET", "/api/agent/whoami");
        const rooms = flags.rooms === "true" ? [] : flags.rooms.split(",").map((id) => id.trim()).filter(Boolean);
        body.covers = { agents: [me.botId ?? me.id], rooms };
      }
      return request("POST", "/api/intents", body);
    },
  },
  intents: {
    use: "intents",
    about: "the standing intents you proposed, and whether each is waiting for approval, listening, paused or expired",
    run: async () => (await request("GET", "/api/intents")).intents,
  },
  unintent: {
    use: "unintent <intent-id>",
    about: "withdraw a standing intent you proposed that is still waiting for approval",
    run: (args) => {
      if (!args[0]) throw new Error("unintent needs an intent id, from `intents`");
      return request("DELETE", `/api/intents/${encodeURIComponent(args[0])}`);
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
  "message-person": {
    use: 'message-person "<their name>" "<the message>"',
    about:
      "send one person in this workspace a message in their private conversation with you, marked as sent on behalf of whoever asked. " +
      "Only when the owner or an admin asked you to, in a team conversation or a room; the answer says whether it went",
    run: (args) => {
      const [person, ...rest] = args;
      const text = rest.join(" ").trim();
      if (!person || !text) throw new Error('message-person needs a name and the message, like message-person "Sam" "The draft is ready"');
      return request("POST", "/api/agent/message-person", { person, text });
    },
  },
  secret: {
    use: 'secret "<what it is>" [--hint "<where to find it>"]',
    about:
      "ask the person for an API key or other secret: a secure field appears in the chat, and the value is never shown to you there. " +
      "Once they save it, it is in your environment on your next turn, under the name this answers with. End your turn after asking",
    run: async (args) => {
      const flags = parseFlags(args);
      // the words that are not a flag or a flag's value are the label
      const words = [];
      for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith("--")) words.push(args[i]);
        else if (!args[i].includes("=") && args[i + 1] && !args[i + 1].startsWith("--")) i++;
      }
      const name = words.join(" ").trim();
      if (!name) throw new Error('secret needs to say what it is, like "Transistor API key"');
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", `/api/bots/${me.botId}/secrets`, {
        name,
        ...(flags.hint && flags.hint !== "true" ? { hint: flags.hint } : {}),
      });
    },
  },
  telegram: {
    use: 'telegram connect @<your bot\'s username> | telegram send <file> [--caption "<words>"]',
    about:
      "connect: ask the person to connect a Telegram bot you made for yourself with BotFather: a card in the chat names you and the bot, " +
      "they paste its token there, and it goes to your own Telegram settings without ever being shown to you. Pairing stays theirs. End your turn after asking. " +
      "send: send one file from your working folder or your own files to the person's Telegram chat with your bot, whatever started this turn, " +
      "up to 50 MB, with an optional caption of up to 1024 characters. Only while your bot is paired with them. A turn they started on Telegram " +
      "already sends the files it saved back there, so do not send those again. The answer says whether it went",
    run: async (args) => {
      const [action, ...rest] = args;
      if (action === "send") {
        const flags = parseFlags(rest);
        const files = positional(rest);
        if (files.length !== 1) throw new Error('telegram send takes one file, like telegram send chart.png --caption "The Q3 chart"');
        // the path as the agent sees it, judged again by the workspace,
        // which opens only a file in the agent's own folders
        const at = resolve(files[0]);
        let real;
        try {
          real = realpathSync(at);
        } catch {
          throw new Error(`there is no file at ${at}`);
        }
        if (!statSync(real).isFile()) throw new Error("telegram send takes one file, not a folder. Send the files in it one at a time");
        const caption = flags.caption !== undefined && flags.caption !== "true" ? flags.caption : undefined;
        const me = await request("GET", "/api/agent/whoami");
        return request("POST", `/api/bots/${me.botId}/telegram/send`, { path: at, ...(caption ? { caption } : {}) });
      }
      const [name, ...more] = rest;
      if (action !== "connect" || !name || more.length) {
        throw new Error('telegram takes connect and your bot\'s username, like telegram connect @PlanningBot, or send and a file, like telegram send chart.png');
      }
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", `/api/bots/${me.botId}/secrets`, { telegramBot: name });
    },
  },
  hire: {
    use: 'hire --name <name> --title <role> [--about <description>] [--skills "a,b,c"] [--effort <level>] [--section <name>] [--pin] [--at <position>]',
    about:
      "add a teammate to the workspace, optionally filed into a sidebar section, and pinned there " +
      "(--pin puts it after the pins already there; --at puts it at that place among them, 1 at the top). " +
      "--effort is how hard it thinks: low, medium, high, xhigh or max, where the engine it starts on has that level; " +
      "left out, it starts on the workspace's default",
    run: (args) => {
      const flags = parseFlags(args);
      if (!flags.name) throw new Error("hire needs a --name");
      const at = flags.at === undefined ? undefined : placeNumber(flags.at);
      return request("POST", "/api/bots", {
        name: flags.name,
        title: flags.title ?? "",
        description: flags.about ?? "",
        skills: flags.skills ? flags.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        // which levels its engine has is the workspace's to say, and it does
        ...(flags.effort !== undefined ? { effort: flags.effort } : {}),
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
        ...(r.quiet ? { quiet: true } : {}),
        next: r.nextRunAt ? localStamp(new Date(r.nextRunAt)) : null,
        enabled: r.enabled,
      }));
    },
  },
  routine: {
    use: 'routine --prompt <text> (--time HH:MM [--date YYYY-MM-DD] [--quiet] | --every 30m [--between 09:00-18:00]) [--days "1,2,3"] [--name <name>] [--thread <conversation>]',
    about:
      "file a routine for yourself: at a --time on --days (0 is Sunday, 6 is Saturday), once on --date to come back to something later, " +
      "or a check-in --every 15m to 24h, optionally --between two times. Leave out --days and it runs every day. " +
      "A check-in's turn may answer QUIET when nothing needs the person, and then they are not told; --quiet lets a --time routine do the same. " +
      "The prompt can be up to 4,000 characters. " +
      "It runs in your first conversation, where the person talks to you; --thread runs it in another, by its title (made if missing) or its id",
    run: async (args) => {
      const flags = parseFlags(args);
      if (!flags.prompt) throw new Error("a routine needs a --prompt");
      const every = flags.every !== undefined ? interval(flags.every) : null;
      if (every === null && flags.between !== undefined) throw new Error("--between is for a check-in; give it --every too");
      if (every !== null) {
        if (flags.time !== undefined || flags.date !== undefined) {
          throw new Error("a check-in runs --every so often, not at a --time or on a --date");
        }
      } else if (!/^\d{1,2}:\d{2}$/.test(flags.time ?? "")) {
        throw new Error("a routine needs a --time like 09:00, or --every like 30m for a check-in");
      }
      let once = null;
      let days = [];
      if (flags.date !== undefined) {
        if (flags.days !== undefined) throw new Error("a routine runs once on a --date or weekly on --days, not both");
        once = onceAt(flags.date, flags.time);
      } else if (flags.days !== undefined) {
        days = weekdays(flags.days);
      }
      const between = flags.between !== undefined ? hours(flags.between) : null;
      const me = await request("GET", "/api/agent/whoami");
      return request("POST", "/api/routines", {
        targetId: me.botId,
        targetKind: "agent",
        name: flags.name,
        prompt: flags.prompt,
        ...(every !== null ? { every, ...(between ? { activeHours: between } : {}) } : { time: flags.time }),
        ...(flags.quiet === "true" && every === null ? { quiet: true } : {}),
        // another conversation, so it does not share context with the rest
        ...(flags.thread ? { thread: flags.thread } : {}),
        ...(once
          ? { repeat: "once", date: once, days: [] }
          : { days }),
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
  pauses: {
    use: "pauses",
    about: "the engine pauses that apply to you: what is paused, until when, and which you made yourself",
    run: async () => {
      const { pauses } = await request("GET", "/api/engine-pauses");
      return (pauses ?? []).map((p) => ({
        id: p.id,
        paused: p.label,
        until: localStamp(new Date(p.until)),
        ...(p.by === "owner" ? { by: "the person" } : { by: "you" }),
        ...(p.note ? { note: p.note } : {}),
      }));
    },
  },
  pause: {
    use: "pause --for <30m|2h> [--model <id>] [--engine <engine-id>] [--kind <engine-kind>] [--family <anthropic|openai|...>] [--why <note>]",
    about:
      "pause an engine or a model for yourself, up to a day: your own work on it waits, and goes on its own when the pause ends. " +
      "With none of --model, --engine, --kind or --family it pauses the engine and model you are on now. " +
      "Your turn now carries on. You cannot pause another agent; ask the person for that",
    run: (args) => {
      const flags = parseFlags(args);
      if (flags.for === undefined) throw new Error("a pause needs --for, how long, like 30m or 2h, up to 24h");
      const what = Object.fromEntries(
        [["model", flags.model], ["instanceId", flags.engine], ["driver", flags.kind], ["family", flags.family]].filter(([, v]) => v !== undefined),
      );
      if (Object.values(what).some((v) => v === "true" || !v)) throw new Error("--model, --engine, --kind and --family each need a value");
      return request("POST", "/api/engine-pauses", {
        minutes: duration(flags.for),
        ...(Object.keys(what).length ? { what } : {}),
        ...(flags.why && flags.why !== "true" ? { note: flags.why } : {}),
      });
    },
  },
  unpause: {
    use: "unpause <pause-id>",
    about: "call off a pause you made on yourself, from `pauses`; what it held goes now",
    run: (args) => {
      if (!args[0]) throw new Error("unpause needs a pause id, from `pauses`");
      return request("DELETE", `/api/engine-pauses/${encodeURIComponent(args[0])}`);
    },
  },
  incident: {
    use: 'incident <id> | incident retry <id> | incident hand <id> <agent id> "<what to do>" | incident tell <id> "<what you need>"',
    about:
      "deal with an incident Bloks handed you because you lead: read it, try the failed thing once more, " +
      "hand it to a teammate with what to do, or tell the person what is needed, which they see as a card. " +
      "One of the three settles it; choosing none leaves it with the person",
    run: (args) => {
      const [first, id, ...rest] = args;
      if (first === "retry") {
        if (!id) throw new Error("incident retry needs the incident's id");
        return request("POST", `/api/incidents/${encodeURIComponent(id)}/retry`);
      }
      if (first === "hand") {
        const [to, ...words] = rest;
        if (!id || !to) throw new Error('incident hand needs the incident\'s id, the teammate\'s id, and what to do');
        return request("POST", `/api/incidents/${encodeURIComponent(id)}/hand`, { to, note: words.join(" ") });
      }
      if (first === "tell") {
        const text = rest.join(" ").trim();
        if (!id || !text) throw new Error("incident tell needs the incident's id and what you need from the person");
        return request("POST", `/api/incidents/${encodeURIComponent(id)}/tell`, { text });
      }
      if (!first || id) throw new Error("incident needs an incident's id, or retry, hand or tell and one");
      return request("GET", `/api/incidents/${encodeURIComponent(first)}`);
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
    use: "memory [--write <text>] | memory --topics | memory --topic <name> [--write <text> | --forget] | memory --shared",
    about:
      "read what you remember between conversations, or replace it; list, read, write or forget a topic file; or read the shared memory the person keeps for every agent (read only)",
    run: async (args) => {
      const flags = parseFlags(args);
      // the person writes the shared memory; an agent only reads it
      if (flags.shared !== undefined) {
        if (flags.write !== undefined) throw new Error("the shared memory is the person's to write; you can read it");
        return request("GET", "/api/memory/shared");
      }
      const me = await request("GET", "/api/agent/whoami");
      if (flags.topics !== undefined) return { topics: (await request("GET", `/api/bots/${me.botId}/memory`)).topics ?? [] };
      if (flags.topic !== undefined) {
        // one plain file name, so it is a single safe path part
        const raw = flags.topic === "true" ? "" : String(flags.topic).trim().replace(/^memory\//, "").replace(/\.md$/i, "");
        const name = raw.replace(/[^\w.-]+/g, "-").replace(/^[^\w]+/, "").slice(0, 100);
        if (!name) throw new Error("--topic needs a name, like people");
        const route = `/api/bots/${me.botId}/memory/topics/${encodeURIComponent(`${name}.md`)}`;
        if (flags.forget !== undefined) return request("DELETE", route);
        if (flags.write !== undefined) return request("PUT", route, { text: flags.write });
        return request("GET", route);
      }
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
    about:
      "answer with a component instead of prose: chart, table, decision, steps, quote, refused. " +
      "Text over a field's limit is refused, not cut, and the refusal names every field to shorten",
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
  share: {
    use: "share <file> [--as <name>]",
    about:
      "put one file in the conversation as a card the person can open in the app, here or on their phone, and get back a link " +
      "to write in your reply. The file can be anywhere on this computer you can read: it is copied into your files unless it " +
      "is already there. --as names the copy, folders allowed (reports/q3.pdf). A `warning` in the answer means it is shared but too " +
      "large to open on the person's paired devices through Bloks Cloud: make it smaller or send it another way",
    run: async (args) => {
      const flags = parseFlags(args);
      const [file] = positional(args);
      if (!file) throw new Error("share needs the file, as a path");
      const at = resolve(file);
      let real;
      try {
        real = realpathSync(at);
      } catch {
        throw new Error(`there is no file at ${at}`);
      }
      if (!statSync(real).isFile()) throw new Error("share takes one file, not a folder. Share the files in it one at a time");
      const me = await request("GET", "/api/agent/whoami");
      // Already in its files: no copy, the card points at the file as it is.
      let root = null;
      try {
        root = me.files ? realpathSync(me.files) : null;
      } catch {}
      const rel = root ? relative(root, real) : "";
      const there = rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).some((part) => part.startsWith("."));
      if (there && flags.as === undefined) {
        return request("POST", `/api/bots/${me.botId}/artifacts`, { name: rel.split(sep).join("/") });
      }
      // Anywhere else: this command reads it, as the agent, and sends the
      // bytes. The workspace never opens a path it is handed.
      const name = flags.as && flags.as !== "true" ? flags.as : basename(at);
      return upload(`/api/bots/${me.botId}/artifacts?name=${encodeURIComponent(name)}`, real);
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

/** An agent's engine as `agents` lists it: ready, not signed in, out until
 * a time on this Mac's clock, or unavailable. Nothing from a workspace too
 * old to say. */
function engineWord(engine) {
  if (!engine?.state) return undefined;
  if (engine.state === "signedOut") return "not signed in";
  if (engine.state === "out") return `out until ${localStamp(new Date(engine.until))}`;
  return engine.state;
}

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

/** The days a weekly routine runs on, checked here so a typo is an error
 * now and not a routine on the wrong days. Nothing at all means every day;
 * anything else has to be days 0 to 6, every one of them. */
function weekdays(raw) {
  if (raw === "true") throw new Error('--days needs the days, like --days "1,2,3"; leave it out for every day');
  if (!raw.trim()) return [];
  return raw.split(",").map((day) => {
    if (!/^[0-6]$/.test(day.trim())) {
      throw new Error(`--days is days of the week as numbers, 0 (Sunday) to 6 (Saturday), like "1,2,3", and "${day.trim()}" is not one`);
    }
    return Number(day.trim());
  });
}

/** How often a check-in runs, in minutes, from the ways somebody writes
 * it: 30m, 30, 90min, 2h, 1h30m. Checked here against the same bounds
 * the workspace keeps, so a typo is an error now and not a check-in at
 * a pace nobody asked for. */
function interval(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const match = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/.exec(text);
  const minutes = match && (match[1] || match[2]) ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : NaN;
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
    throw new Error(`--every is how often, 15m to 24h, like 30m or 2h, and "${raw}" is not one`);
  }
  return minutes;
}

/** How long a pause lasts, "45m", "2h", "1h30m", in minutes: a minute to
 * a day, which is as long as an agent may pause itself. */
function duration(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const match = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/.exec(text);
  const minutes = match && (match[1] || match[2]) ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`--for is how long, 1m to 24h, like 45m or 2h, and "${raw}" is not one`);
  }
  return minutes;
}

/** A check-in's hours, "09:00-18:00", both ends real times on one day. */
function hours(raw) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(raw ?? "").trim());
  const minutes = match ? [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])] : null;
  if (!match || Number(match[1]) > 23 || Number(match[3]) > 23 || Number(match[2]) > 59 || Number(match[4]) > 59 || minutes[0] >= minutes[1]) {
    throw new Error(`--between is two times on one day, the earlier first, like 09:00-18:00, and "${raw}" is not that`);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return { from: `${pad(match[1])}:${match[2]}`, to: `${pad(match[3])}:${match[4]}` };
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
    // an empty argument is a value, as `--flag=` is, not a bare flag
    flags[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
  }
  return flags;
}

/** The words that are not flags or a flag's value. */
function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** One file's bytes, streamed rather than read whole: a recording can be
 * larger than this process would want to hold. */
async function upload(path, file) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(statSync(file).size),
      authorization: `Bearer ${TOKEN}`,
      origin: BASE,
    },
    body: Readable.toWeb(createReadStream(file)),
    duplex: "half",
  }).catch((error) => {
    throw new Error(unreachable(error));
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

/**
 * Why the workspace could not be reached, in words an agent can act on.
 *
 * fetch says only "fetch failed" and keeps the reason in its cause. From
 * inside a sandbox with no network access, which is how Codex runs
 * commands unless told otherwise, even this computer's own address is
 * refused, and the bare message read as Bloks being down: an agent spent
 * its turns retrying a command that only needed permission (GitHub 251).
 * The address is safe to say; the credential is never part of it.
 */
function unreachable(error) {
  const cause = error?.cause;
  const codes = [cause?.code, ...(Array.isArray(cause?.errors) ? cause.errors.map((e) => e?.code) : [])].filter(Boolean);
  const again = "Run the same command again with network access allowed";
  if (codes.some((code) => code === "EPERM" || code === "EACCES")) {
    return (
      `network access required: this command was not allowed to reach the Bloks workspace at ${BASE}, which is on this computer. ` +
      `A sandbox is blocking it. ${again}. Bloks is running and the command is fine as written.`
    );
  }
  if (codes.includes("ECONNREFUSED")) {
    return `nothing is answering at ${BASE}. Bloks may be restarting, or not running; try again in a moment.`;
  }
  return (
    `could not reach the Bloks workspace at ${BASE}${codes.length ? ` (${codes[0]})` : ""}. ` +
    `If this ran in a sandbox without network access, that is the cause: ${again[0].toLowerCase()}${again.slice(1)}.`
  );
}

async function request(method, path, body, credential = TOKEN) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
      // the workspace refuses anything that does not look like it came
      // from this machine, and this is what says so
      origin: BASE,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error) => {
    throw new Error(unreachable(error));
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
    // said here because an agent reads this before its first command, and
    // a sandbox's refusal otherwise looks like Bloks being down
    network:
      "Every command talks to the workspace on this computer, over its own address. " +
      'In a sandbox without network access a command answers "network access required": run it again with network access allowed.',
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
  // named, since the likeliest cause is an engine that kept the turn's
  // environment from this shell, and that is something a person can fix
  if (!TOKEN && !(name === "reply" && process.env.BLOKS_REPLY_TOKEN)) throw new Error("no credential in this environment (BLOKS_TOKEN is not set), so there is nobody to act as");
  const result = await command.run(args);
  process.stdout.write(`${JSON.stringify(result ?? { ok: true }, null, 2)}\n`);
} catch (error) {
  // an error is JSON too: the caller is a model, and a stack trace on
  // stderr is a turn spent working out what went wrong
  process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
}
