// The words of a move between this computer and the hosted machine, apart from
// the screens (src/components/hosting/), so they can be tested alone.
//
// A move has six steps and says where it is in each of them in a word or
// two; while it sends, how much of it is across. What went wrong is the
// pipeline's own sentence (electron/hosting-move.mjs), shown as it came.
// The keys left behind are grouped by the Settings page they are entered
// on, so each page is one button.
import type { HostingMove, HostingMoveCounts, HostingMoveKey, HostingMoveStep } from "../types/bridge.d.ts";
import { SETTINGS_PAGE_LIST } from "./settingsPages.ts";
import { formatList, formatNumber, hasMessage, t, type MessageKey } from "./i18n.ts";
import { thisComputer } from "./thisComputer.ts";

// Each step's label is a key, read in the language it is drawn in.
export const MOVE_STEPS: ReadonlyArray<{ step: HostingMoveStep; label: MessageKey }> = [
  { step: "pairing", label: "libHostingMove.step.pairing" },
  { step: "packing", label: "libHostingMove.step.packing" },
  { step: "sending", label: "libHostingMove.step.sending" },
  { step: "unpacking", label: "libHostingMove.step.unpacking" },
  { step: "checking", label: "libHostingMove.step.checking" },
  { step: "done", label: "libHostingMove.step.done" },
];

const ORDER = MOVE_STEPS.map((s) => s.step);

/** Where a step stands in a move: behind it, the one under way, or to come. */
export function stepState(move: Pick<HostingMove, "step" | "phase">, step: HostingMoveStep): "done" | "now" | "next" {
  if (move.phase === "done") return "done";
  const at = ORDER.indexOf(move.step);
  const here = ORDER.indexOf(step);
  return here < at ? "done" : here === at ? "now" : "next";
}

/** A size as the progress line says it: whole megabytes, one decimal
 * under ten, gigabytes past a thousand. */
export function sizeWords(bytes: number, unit: "MB" | "GB" = bytes >= 1e9 ? "GB" : "MB"): string {
  const n = unit === "GB" ? bytes / 1e9 : bytes / 1e6;
  return n >= 10 || n === 0
    ? formatNumber(Math.round(n))
    : formatNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "Sending 12 of 340 MB". */
export function sendingWords(sent: number, size: number): string {
  const unit = size >= 1e9 ? "GB" : "MB";
  return t("libHostingMove.sendingOf", { sent: sizeWords(Math.min(sent, size), unit), size: sizeWords(size, unit), unit });
}

/** A step's label in the list: Sending says how far, once it has begun. */
export function stepLabel(move: Pick<HostingMove, "step" | "phase" | "sent" | "size">, step: HostingMoveStep): string {
  if (step === "sending" && move.size > 0 && stepState(move, "sending") !== "next") return sendingWords(move.sent, move.size);
  const label = MOVE_STEPS.find((s) => s.step === step)?.label;
  return label ? t(label) : step;
}

/** Where it goes: the hosted machine, a named workspace on this Mac, or
 * this Mac. Each is said as part of a whole sentence, so a language can
 * put the place where its grammar wants it. */
export function destination(move: Pick<HostingMove, "direction" | "to">): "hosted" | "named" | "mac" {
  return move.direction === "to-hosted" ? "hosted" : move.to.id ? "named" : "mac";
}

/** The card's heading for a move as it stands. */
export function headline(move: Pick<HostingMove, "direction" | "from" | "to" | "phase">): string {
  const params = { name: move.from.name, to: move.to.name, computer: thisComputer() };
  const where = destination(move);
  switch (move.phase) {
    case "done":
      return move.direction === "to-hosted" ? t("libHostingMove.headline.doneHosted", params) : t("libHostingMove.headline.doneMac", params);
    case "failed":
      return t("libHostingMove.headline.failed", params);
    case "stopped":
      return t("libHostingMove.headline.stopped", params);
    case "later":
      return t(`libHostingMove.headline.later.${where}`, params);
    default:
      return t(`libHostingMove.headline.moving.${where}`, params);
  }
}

/** "Personal starts moving to your hosted machine in 5 s." */
export function startsIn(move: Pick<HostingMove, "direction" | "from" | "to">, seconds: number): string {
  return t(`libHostingMove.startsIn.${destination(move)}`, { name: move.from.name, to: move.to.name, seconds, computer: thisComputer() });
}

/** The line under it. */
export function subline(move: Pick<HostingMove, "direction" | "from" | "phase" | "step">): string {
  const side = move.direction === "to-hosted" ? "mac" : "hosted";
  const params = { name: move.from.name, computer: thisComputer() };
  switch (move.phase) {
    case "done":
      return move.direction === "to-hosted" ? t("libHostingMove.subline.doneHosted", params) : t("libHostingMove.subline.doneMac");
    case "failed":
      return t("libHostingMove.subline.failed");
    case "stopped":
    case "later":
      return t(`libHostingMove.subline.paused.${side}`, params);
    case "waiting":
      return t("libHostingMove.subline.waiting");
    default:
      return move.step === "unpacking" || move.step === "checking"
        ? t("libHostingMove.subline.unpacking")
        : t(`libHostingMove.subline.carrying.${side}`, params);
  }
}

/** What a move carries, counted, in one line: "3 agents, 12 conversations
 * and 2 routines". What there are none of is left out. */
export function countsWords(counts: HostingMoveCounts | null | undefined): string {
  if (!counts) return t("libHostingMove.counts.unknown");
  const parts = (
    [
      ["agents", "libHostingMove.counts.agents"],
      ["conversations", "libHostingMove.counts.conversations"],
      ["rooms", "libHostingMove.counts.rooms"],
      ["routines", "libHostingMove.counts.routines"],
      ["watchers", "libHostingMove.counts.watchers"],
      ["workflows", "libHostingMove.counts.workflows"],
      ["memoryFiles", "libHostingMove.counts.memoryFiles"],
    ] as const
  )
    .filter(([key]) => counts[key] > 0)
    .map(([key, words]) => t(words, { count: counts[key] }));
  if (!parts.length) return t("libHostingMove.counts.none");
  if (parts.length === 1) return parts[0];
  // The last two are joined by the sentence's own "and", with no comma
  // before it in English; the rest by the reader's list separator.
  return t("libHostingMove.counts.list", { items: formatList(parts.slice(0, -1), { type: "unit", style: "short" }), last: parts[parts.length - 1] });
}

/** A Settings page by name, in the reader's language when the page list
 * keeps its labels as keys. */
export function pageLabel(page: string): string {
  const label: string | undefined = SETTINGS_PAGE_LIST.find((p) => p.id === page)?.label;
  if (!label) return t("libHostingMove.settings");
  return hasMessage(label) ? t(label) : label;
}

/** The keys to enter again, one group per Settings page, in the order the
 * keys came. With Bloks AI in the plan, its own key is not one of them:
 * agents run on it there already. */
export function keyGroups(keys: HostingMoveKey[] | null | undefined, bloksAi: boolean): Array<{ page: string; label: string; items: string[] }> {
  const groups: Array<{ page: string; label: string; items: string[] }> = [];
  for (const key of keys ?? []) {
    if (bloksAi && key.page === "plan") continue;
    let group = groups.find((g) => g.page === key.page);
    if (!group) {
      group = { page: key.page, label: pageLabel(key.page), items: [] };
      groups.push(group);
    }
    if (!group.items.includes(key.label)) group.items.push(key.label);
  }
  return groups;
}

export function bloksAiLine(): string {
  return t("libHostingMove.bloksAiLine");
}
export function stillPaidLine(): string {
  return t("libHostingMove.stillPaidLine");
}
