// The one line a conversation shows in the list.
//
// It is prose, so anything that is not words gets described rather than
// drawn: a chart, a saved file, an app waiting to be connected. An agent
// whose last message was one of those used to show an empty line, which
// reads as an agent that said nothing at all.
//
// Mirrors the iPhone app's preview line and conversation row, word
// for word, so the same
// conversation reads the same on both.
import type { Message } from "@/state/reducer";

/** The newest message that is in the conversation, for the row's line
 * and time. One still waiting to reach the agent, or one that never
 * went, is not what was last said. Nor is a compaction marker: it is
 * housekeeping, never news, and an idle compaction always leaves one as
 * the newest message, which would hide the reply the row's dot is about.
 * The server reads a lane's time past it the same way. */
export function lastSaid<M extends { queued?: boolean; unsent?: boolean; compaction?: unknown }>(
  messages: readonly M[],
): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.queued && !m.unsent && !m.compaction) return m;
  }
  return undefined;
}

/** Bubbles render markdown; the preview line is plain text, so strip the
 * markers rather than showing raw ** and ` to the user. */
export function plainText(text: string): string {
  return text
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A component, described. "What it is" beats an empty row. */
export function describeComponent(component: Record<string, unknown>): string {
  const named = typeof component.title === "string" ? component.title.trim() : "";
  switch (component.kind) {
    case "chart":
      return named || "A chart";
    case "table":
      return named || "A table";
    case "decision":
      return typeof component.question === "string" ? component.question : "A recommendation";
    case "steps":
      return named || "Some steps";
    case "quote":
      return typeof component.text === "string" ? component.text : "A quote";
    case "refused":
      return typeof component.what === "string" ? `Refused: ${component.what}` : "Refused";
    default:
      // A kind a newer harness knows about and this build does not.
      return "An answer";
  }
}

/** What the last message in a conversation says, in one line. */
export function previewLine(last: Message | undefined): string {
  if (!last) return "New agent";
  // Taken back, whatever it used to be: the row should not still
  // advertise words somebody removed.
  if (last.deleted) return "Message taken back";
  switch (last.kind) {
    case "options":
      return last.card ? last.card.title : "Asked you something";
    case "activity":
      return last.tool ? last.tool.name : "Working";
    case "screen":
      return "Shared a screen frame";
    case "artifact":
      return last.artifact ? `Saved ${last.artifact.name}` : "Saved a file";
    case "connector":
      return last.connector ? `Connect ${last.connector.label}` : "Connect an app";
    case "secret":
      return last.secret ? `Needs your ${last.secret.label}` : "Needs a key";
    case "component":
      return last.component ? describeComponent(last.component) : "An answer";
    case "changes":
      if (!last.changes) return "Changed files";
      // a rehearsal waiting, or let go, never touched the folder
      return last.changes.rehearsal && last.changes.rehearsal.state !== "applied"
        ? `Would change ${last.changes.total} file${last.changes.total === 1 ? "" : "s"}`
        : changedLine(last.changes.total - (last.changes.shared?.total ?? 0), last.changes.shared?.total);
    default:
      return last.text ? plainText(last.text) : "";
  }
}

/** "Changed 3 files", for a list row. A turn that ran beside other
 * agents in its folder claims only its own, and says how many more
 * changed around it rather than counting them as its work. */
export function changedLine(total: number, shared = 0): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  if (!shared) return `Changed ${files(total)}`;
  if (!total) return `${files(shared)} changed while others were working here`;
  return `Changed ${files(total)}, ${shared} more while others were working here`;
}

/** An agent as its row in the list needs it. `messages` are its open
 * conversation's, and `tasks` its conversations' summaries, which the
 * server sends whether or not the messages came too. */
interface RowAgent {
  title?: string;
  busy?: boolean;
  messages: Message[];
  olderMessages?: number;
  threadId: string;
  activeTaskId?: string;
  tasks?: Array<{ id: string; state?: string; lastAt?: number; createdAt: number }>;
}

/** Whether an agent has said things that are not here: through Bloks
 * Cloud its transcript can arrive trimmed to nothing, since one long
 * message can be more than the relay carries, and a conversation opened
 * on another device arrives empty until its messages are fetched. Its
 * open conversation's summary still says something was said there. */
export function unseenHistory(bot: RowAgent): boolean {
  if (lastSaid(bot.messages)) return false;
  if ((bot.olderMessages ?? 0) > 0) return true;
  const open = bot.tasks?.find((t) => t.id === (bot.activeTaskId ?? bot.threadId));
  return open?.lastAt !== undefined && open.lastAt > open.createdAt;
}

/** When the row says the agent was last heard from: its newest message,
 * or, when that is not here, its open conversation's own time. */
export function lastHeardAt(bot: RowAgent): number | undefined {
  const last = lastSaid(bot.messages);
  if (last) return last.at;
  return unseenHistory(bot) ? bot.tasks?.find((t) => t.id === (bot.activeTaskId ?? bot.threadId))?.lastAt : undefined;
}

/** The line under an agent's name in the list. An agent whose words did
 * not come along is not a new one, which is what an empty transcript used
 * to say: it reads as who it is until its words arrive. */
export function agentPreview(bot: RowAgent): string {
  // a lane waiting on a human outranks everything: that is the row the
  // user should open next
  if (bot.tasks?.some((t) => t.state === "needs-you")) return "Waiting for you…";
  if (bot.busy) return "Working…";
  if (unseenHistory(bot)) return bot.title?.trim() || "Open to see what was said";
  // an empty lane on an agent that has others is a fresh conversation,
  // not a fresh agent, which is what the shared wording would say
  if (!bot.messages.length && (bot.tasks?.length ?? 0) > 1) return "New conversation";
  return previewLine(lastSaid(bot.messages));
}
