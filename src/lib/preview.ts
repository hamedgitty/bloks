// The one line a conversation shows in the list.
//
// It is prose, so anything that is not words gets described rather than
// drawn: a chart, a saved file, an app waiting to be connected. An agent
// whose last message was one of those used to show an empty line, which
// reads as an agent that said nothing at all.
//
// Mirrors the iPhone app's preview line and conversation row, word
// for word, so the same
// conversation reads the same on both (in English; here the words are
// the catalogue's, so they follow the language chosen).
import type { Message } from "@/state/reducer";
import { rowLane } from "../state/reducer.ts";
import { toolLabel } from "./tool-summary.ts";
import { t } from "./i18n.ts";

/** The newest message that is in the conversation, for the row's line
 * and time. One still waiting to reach the agent, or one that never
 * went, is not what was last said. Nor is a compaction marker: it is
 * housekeeping, never news, and an idle compaction always leaves one as
 * the newest message, which would hide the reply the row's dot is about.
 * Nor is a quiet check-in, for the same reason: one every half hour would
 * keep the row saying QUIET over whatever was last said to you. The
 * server reads a lane's time past those and session resets the same way. */
export function lastSaid<M extends { queued?: boolean; unsent?: boolean; compaction?: unknown; sessionReset?: boolean; quiet?: boolean }>(
  messages: readonly M[],
): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.queued && !m.unsent && !m.compaction && !m.sessionReset && !m.quiet) return m;
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
      return named || t("preview.chart");
    case "table":
      return named || t("preview.table");
    case "decision":
      return typeof component.question === "string" ? component.question : t("preview.recommendation");
    case "steps":
      return named || t("preview.steps");
    case "quote":
      return typeof component.text === "string" ? component.text : t("preview.quote");
    case "refused":
      return typeof component.what === "string" ? t("preview.refusedWhat", { what: component.what }) : t("preview.refused");
    default:
      // A kind a newer harness knows about and this build does not.
      return t("preview.answer");
  }
}

/** What the last message in a conversation says, in one line. */
export function previewLine(last: Message | undefined): string {
  if (!last) return t("preview.newAgent");
  // Taken back, whatever it used to be: the row should not still
  // advertise words somebody removed.
  if (last.deleted) return t("preview.takenBack");
  switch (last.kind) {
    case "options":
      return last.card ? last.card.title : t("preview.asked");
    case "activity":
      if (last.takeBack) {
        const count = last.takeBack.messages.length;
        return t("preview.tookBack", { count });
      }
      return last.tool ? toolLabel(last.tool) : t("preview.working");
    case "screen":
      return t("preview.screen");
    case "artifact":
      return last.artifact ? t("preview.saved", { name: last.artifact.name }) : t("preview.savedFile");
    case "connector":
      return last.connector ? t("preview.connect", { app: last.connector.label }) : t("preview.connectApp");
    case "secret":
      return last.secret ? t("preview.needsYour", { label: last.secret.label }) : t("preview.needsKey");
    case "component":
      return last.component ? describeComponent(last.component) : t("preview.answer");
    case "changes":
      if (!last.changes) return t("preview.changedFiles");
      // a rehearsal waiting, or let go, never touched the folder
      return last.changes.rehearsal && last.changes.rehearsal.state !== "applied"
        ? t("preview.wouldChange", { count: last.changes.total })
        : changedLine(last.changes.total - (last.changes.shared?.total ?? 0), last.changes.shared?.total);
    default:
      return last.text ? plainText(withoutInterface(last.text)) || t("preview.interactive") : "";
  }
}

/** A reply's words without the interface drawn in it, which as text is
 * code (src/components/genui). A fence still open runs to the end. */
export function withoutInterface(text: string): string {
  return text.replace(/^[ \t]*```[ \t]*openui(?:-lang)?[ \t]*$[\s\S]*?(?:^[ \t]*```[ \t]*$|(?![\s\S]))/gim, "");
}

/** "Changed 3 files", for a list row. A turn that ran beside other
 * agents in its folder claims only its own, and says how many more
 * changed around it rather than counting them as its work. */
export function changedLine(total: number, shared = 0): string {
  if (!shared) return t("preview.changed", { count: total });
  if (!total) return t("preview.changedAround", { count: shared });
  return t("preview.changedPlusAround", { count: total, shared });
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
  tasks?: Array<{ id: string; title?: string; state?: string; unread?: boolean; lastAt?: number; createdAt: number }>;
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
  // the conversation a click on the row opens (rowLane): the line says
  // what that one is doing, as the mark beside it does
  const lane = rowLane(bot);
  if (lane?.state === "needs-you") return t("preview.waitingForYou");
  if (lane?.state ? lane.state === "working" : bot.busy) return t("preview.workingNow");
  // one that pinged you from behind the open one: its words are not
  // here, its name is
  if (lane && lane.id !== (bot.activeTaskId ?? bot.threadId)) return lane.title?.trim() || t("preview.openToSee");
  if (unseenHistory(bot)) return bot.title?.trim() || t("preview.openToSee");
  // an empty lane on an agent that has others is a fresh conversation,
  // not a fresh agent, which is what the shared wording would say
  if (!bot.messages.length && (bot.tasks?.length ?? 0) > 1) return t("preview.newConversation");
  return previewLine(lastSaid(bot.messages));
}
