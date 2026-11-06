// The bridge that lets an agent ask its owner something mid-turn.
//
// Claude Code will not stop and wait on its own. Given a headless run it
// either proceeds or silently refuses, depending on its permission mode,
// and neither is what a person watching a chat window expects. Pointing it
// at `--permission-prompt-tool` changes that: the CLI now calls a tool
// whenever it wants a decision, and blocks on the reply.
//
// This file is that tool. It is spawned by the CLI as an MCP server over
// stdio, and every question it receives is forwarded down a unix socket to
// the broker inside the harness (see the broker in server/drivers/
// claude.ts), which turns it into a card in the transcript and waits for a
// human to press something.
//
// Two kinds of tool are published:
//
//   approve    the CLI's own permission checkpoint. The reply has to match
//              the shape `--permission-prompt-tool` expects.
//   ask_user   the agent choosing to ask. Whatever the person typed comes
//              back as the tool result, unedited. request_secret and
//              request_connection are asks of the same kind.
//
// On full access there is no checkpoint, but the agent can still ask, so
// the harness names the tools to publish in BLOKS_PUBLISH and leaves
// approve out. Nothing else is answered then: a call to a tool that was
// not published is refused, never read as a permission request.
//
// It is its own entry file rather than a mode of the main server because
// the CLI spawns it with `process.execPath`, and a shared entry point that
// dispatched on argv would be one bad argument away from a process
// spawning copies of itself.
//
// Nothing may ever be written to stdout except protocol frames.
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

import { readJsonLines } from "./ndjson.ts";
import { PERSON_REPLY_TOOL, personReplyText } from "./person-turn.ts";
import { NOT_SHOWN } from "./harness/ask-questions.ts";

/** What the broker is told when it is not there to be told anything. The
 * wording is aimed at the model, not the user: it should give up on this
 * one action and carry on with the rest of the turn. */
const BROKER_GONE = "Bloks: permission broker unavailable, skip this action";

// ── the link back to the harness ───────────────────────────────────────

const socketPath = process.argv[2] ?? "";
const outstanding = new Map<string, (reply: any) => void>();
const socket = connect(socketPath);

/** Fail every question still in flight, and any that arrive later. Called
 * when the socket errors or closes, which in practice means the turn ended
 * or the harness went away. Answering "deny" is the safe direction: an
 * action nobody approved does not happen. */
function abandonAll() {
  for (const settle of outstanding.values()) {
    settle({ behavior: "deny", message: BROKER_GONE });
  }
  outstanding.clear();
}
socket.on("error", abandonAll);
socket.on("close", abandonAll);
readJsonLines(socket, (frame) => {
  if (frame.t !== "answer") return;
  outstanding.get(frame.id)?.(frame);
  outstanding.delete(frame.id);
});

/** Put a question to the broker and wait for the person to answer it.
 * There is no timeout here on purpose: the broker owns that policy, and
 * it is the side that knows whether a card is still on screen. */
function askHuman(request: object): Promise<any> {
  const id = randomUUID();
  return new Promise((settle) => {
    outstanding.set(id, settle);
    if (socket.destroyed) return abandonAll();
    try {
      socket.write(JSON.stringify({ ...request, id }) + "\n");
    } catch {
      abandonAll();
    }
  });
}

// ── the MCP surface ────────────────────────────────────────────────────

const writeFrame = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");

const ALL_TOOLS = [
  PERSON_REPLY_TOOL,
  {
    name: "approve",
    description: "Ask the Bloks user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "request_connection",
    description:
      "Ask the user to connect an app (Slack, Gmail, GitHub, and so on) so you can use it. A sign-in card appears in the chat; never paste sign-in links into chat yourself. After calling this, wrap up your turn: the app resumes the task automatically once the user connects.",
    inputSchema: {
      type: "object",
      properties: {
        apps: {
          type: "array",
          items: { type: "string" },
          description: "App slugs to connect, lowercase, e.g. [\"slack\", \"gmail\"]",
        },
        reason: { type: "string", description: "One line on why, shown to the user" },
      },
      required: ["apps"],
    },
  },
  {
    name: "request_secret",
    description:
      "Ask the user for an API key or other secret value via a secure field in the chat. The value is stored on their computer and handed to your shell tools as an environment variable on your next turn; it never appears in the conversation. After calling this, wrap up your turn: the task resumes automatically once they save it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the secret is, e.g. \"Transistor API key\"" },
        hint: { type: "string", description: "One line on where to find it, shown under the field" },
        telegram_bot: { type: "string", description: "Only to connect a Telegram bot you made for yourself with BotFather: its @username. The user pastes its token into the card, it is saved to your own Telegram settings rather than your environment, and you never see it." },
      },
      required: ["name"],
    },
  },
  {
    name: "message_person",
    description:
      "Send a message to one person in this workspace, in their private conversation with you. Only when the owner or an admin asked you to, in a team conversation or a room. It is marked as sent on their behalf, and the answer says whether it went.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "The person's name, as the members list shows it" },
        text: { type: "string", description: "The message, written to them" },
      },
      required: ["person", "text"],
    },
  },
  {
    name: "ask_user",
    description:
      "Put a question to the person you work for and wait for their reply. Use it for anything that is genuinely theirs to decide: a preference, a missing fact, or sign-off before something consequential. Guessing is worse than asking here. Their answer comes back as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question. Carry enough context that it can be answered without going and looking something up.",
        },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Two to five likely answers, offered as buttons so a reply takes one tap.",
        },
      },
      required: ["question"],
    },
  },
];

const only = process.env.BLOKS_PUBLISH?.split(",").filter(Boolean);
// reply_to_sender and message_person are each for one kind of turn, and
// are only ever published by name
const PUBLISHED_TOOLS = only ? ALL_TOOLS.filter((tool) => only.includes(tool.name)) : ALL_TOOLS.filter((tool) => tool.name !== "reply_to_sender" && tool.name !== "message_person");

/** The CLI sometimes proposes permission rules of its own alongside a
 * request. On an "always allow" they are echoed back untouched so it can
 * stop asking at its own layer. Echoing beats inventing: the rule syntax
 * is theirs, and a rule we made up could widen permissions by accident. */
function proposedRules(args: any): unknown[] | null {
  if (Array.isArray(args.permission_suggestions)) return args.permission_suggestions;
  if (Array.isArray(args.suggestions)) return args.suggestions;
  return null;
}

/** What a question is told when the person gave it no words. */
const NO_ANSWER = "No answer was given. Use your best judgment.";

/**
 * The CLI's own question tool reads the person's reply from `answers` in
 * its input: question text to answer, several picks of one question
 * joined with commas, and a question left out is one nobody answered.
 *
 * A card that sent an answer per question is taken at its word, in the
 * order the questions were asked. One that sent a single string (a
 * phone, an older window, a chat) showed only the first question, so the
 * string is that one's and the others go unanswered, where the same
 * words against all of them would answer questions the person never saw.
 * Each of those carries a note saying why, in `annotations`, which the
 * CLI reads out beside a question left unanswered.
 */
function withAnswers(input: any, said: string, perQuestion?: unknown) {
  const answers: Record<string, string> = {};
  const notes: Record<string, { notes: string }> = {};
  const given = Array.isArray(perQuestion) ? perQuestion : null;
  input.questions.forEach((asked: any, i: number) => {
    if (typeof asked?.question !== "string") return;
    if (given) {
      const picked = (Array.isArray(given[i]) ? given[i] : []).filter((item: unknown): item is string => typeof item === "string" && item.trim() !== "");
      if (picked.length) answers[asked.question] = picked.join(", ");
    } else if (i === 0) answers[asked.question] = said;
    else notes[asked.question] = { notes: NOT_SHOWN };
  });
  return { ...input, answers, ...(Object.keys(notes).length ? { annotations: { ...input.annotations, ...notes } } : {}) };
}

/** The `--permission-prompt-tool` reply, as a string, because the contract
 * is a JSON document inside a text content block. */
function permissionVerdict(reply: any, args: any): string {
  // A question that came through the checkpoint, answered. Allowing it
  // with the answers in its input is how the CLI's own tool is told. A
  // tool with nowhere to put them is refused with the reply as the
  // reason, the one way left for the words to reach the model.
  if (reply.behavior === "answer") {
    const said = reply.message || NO_ANSWER;
    return JSON.stringify(
      Array.isArray(args.input?.questions)
        ? { behavior: "allow", updatedInput: withAnswers(args.input, said, reply.answers) }
        : { behavior: "deny", message: `Answered in Bloks instead: ${said}` },
    );
  }
  if (reply.behavior !== "allow") {
    return JSON.stringify({
      behavior: "deny",
      message: reply.message || "Denied from Bloks",
    });
  }
  const rules = reply.always ? proposedRules(args) : null;
  return JSON.stringify({
    behavior: "allow",
    updatedInput: args.input ?? {},
    ...(rules ? { updatedPermissions: rules } : {}),
  });
}

async function dispatch(message: any) {
  switch (message.method) {
    case "initialize":
      return writeFrame({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bloks-permissions", version: "1" },
        },
      });

    case "tools/list":
      return writeFrame({ jsonrpc: "2.0", id: message.id, result: { tools: PUBLISHED_TOOLS } });

    case "tools/call": {
      const args = message.params?.arguments ?? {};
      const name = message.params?.name;
      const isQuestion = name === "ask_user";
      const isConnection = name === "request_connection";
      const isSecret = name === "request_secret";
      const isReply = name === "reply_to_sender";
      const isMessage = name === "message_person";

      if (!PUBLISHED_TOOLS.some((tool) => tool.name === name)) {
        return writeFrame({
          jsonrpc: "2.0",
          id: message.id,
          result: { isError: true, content: [{ type: "text", text: `Bloks: there is no ${String(name)} tool here` }] },
        });
      }

      if (isReply) {
        try {
          personReplyText(args);
          const reply = await askHuman({ t: "reply", input: args });
          return writeFrame({ jsonrpc: "2.0", id: message.id, result: {
            ...(reply.behavior !== "answer" ? { isError: true } : {}),
            content: [{ type: "text", text: reply.message || BROKER_GONE }],
          } });
        } catch (error) {
          return writeFrame({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Reply refused" }] } });
        }
      }

      // The schema describes a required question, but a tool call can
      // still omit it. Refuse before opening a card or waiting on it.
      if (isQuestion && (typeof args.question !== "string" || !args.question.trim())) {
        return writeFrame({
          jsonrpc: "2.0",
          id: message.id,
          result: { isError: true, content: [{ type: "text", text: "Bloks: ask_user requires a non-empty question" }] },
        });
      }

      // A message on somebody's behalf: the workspace decides and sends
      // it (no card), and its answer comes back as the tool's result.
      if (isMessage) {
        const reply = await askHuman({ t: "ask", kind: "question", tool: "message_person", input: { person: args.person, text: args.text } });
        return writeFrame({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: reply.message || BROKER_GONE }] } });
      }

      const reply = await askHuman(
        isSecret
          ? {
              t: "ask",
              kind: "question",
              tool: "request_secret",
              input: { name: args.name, hint: args.hint, telegram_bot: args.telegram_bot },
            }
          : isConnection
          ? {
              t: "ask",
              kind: "question",
              tool: "request_connection",
              input: { apps: args.apps, reason: args.reason },
            }
          : isQuestion
            ? {
                t: "ask",
                kind: "question",
                tool: "ask_user",
                input: { question: args.question, choices: args.choices },
              }
            : { t: "ask", tool: args.tool_name, input: args.input },
      );

      const text =
        isQuestion || isConnection || isSecret
          ? reply.message || NO_ANSWER
          : permissionVerdict(reply, args);

      return writeFrame({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }] },
      });
    }
  }

  // Notifications are fire and forget, and anything else is a method this
  // server does not implement. Only requests (which carry an id) deserve
  // an error frame back.
  if (String(message.method ?? "").startsWith("notifications/")) return;
  if (message.id != null) {
    writeFrame({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
  }
}

readJsonLines(process.stdin, (message) => void dispatch(message));
process.stdin.on("end", () => process.exit(0));
