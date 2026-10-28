// Where something lives in the app, for an agent to tell the person, and
// a button that takes them there.
//
// An agent asked "how do I turn off the nightly tidy" used to answer from
// its own idea of the app, which is how a person ends up looking for a
// page that moved two versions ago. So the answer comes from the same
// index the app's own settings search reads (server/settings-index.ts),
// searched the same way, in English, and the page it names is one the app
// can open: `bloks open` puts a card in the conversation with one button
// that takes the person's window there. Navigation only. Nothing changes
// until the person changes it, on the page, themselves.
//
// The words are the app's own catalogue (src/locales/en.json), read once
// from beside the server: next to it in a checkout, in Resources beside
// the compiled server in the packaged app, where electron-builder puts
// the catalogues for the menu bar, and beside dist-server in bloks-server
// (scripts/pack-server.mjs).
import { readFileSync } from "node:fs";

import {
  PLACE_INDEX,
  SETTINGS_GROUP_INDEX,
  SETTINGS_PAGE_INDEX,
  SETTINGS_REDIRECTS,
  type PlaceEntry,
  type SettingsPageEntry,
} from "./settings-index.ts";

let catalogue: Record<string, string> | null = null;

/** The English catalogue, or an empty one when neither copy is there: a
 * missing file makes the answers terser, never wrong. */
function english(): Record<string, string> {
  if (catalogue) return catalogue;
  for (const at of ["../src/locales/en.json", "../locales/en.json"]) {
    try {
      catalogue = JSON.parse(readFileSync(new URL(at, import.meta.url), "utf8")) as Record<string, string>;
      return catalogue;
    } catch {
      /* the other place, or neither */
    }
  }
  return (catalogue = {});
}

/** A key's English words. A key the catalogue does not have is said as
 * its last part, which still names the thing. */
export function say(key: string): string {
  return english()[key] ?? key.split(".").at(-1)!.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** One place the app can open, as an agent is told it and as a card
 * carries it. */
export interface Place {
  kind: "settings" | "panel";
  id: string;
  /** Its name, in English. */
  name: string;
  /** How a person gets there, in words: "Settings, Engines and keys". */
  path: string;
  /** What it holds, one line. */
  about: string;
  /** The rows it draws, in English (Settings pages only). */
  rows: string[];
  /** Only where the desktop app has workspaces. */
  workspace?: boolean;
}

function settingsPlace(page: SettingsPageEntry): Place {
  const name = say(page.label);
  return {
    kind: "settings",
    id: page.id,
    name,
    // the workspace's own group is titled with its name, which only the
    // window knows; said as what it is instead
    path: page.workspace ? `Settings, under the workspace's name, ${name}` : `Settings, ${name}`,
    about: say(page.description),
    rows: (page.rows ?? []).map(say),
    ...(page.workspace ? { workspace: true } : {}),
  };
}

function panelPlace(place: PlaceEntry): Place {
  const name = say(place.label);
  const parent = place.parent ? PLACE_INDEX.find((p) => p.id === place.parent) : undefined;
  return {
    kind: "panel",
    id: place.id,
    name,
    path:
      place.id === "agent"
        ? "the agent's own settings: Edit profile, in its menu in the sidebar"
        : parent
          ? `${say(parent.label)} on the main rail, then ${name}`
          : `${name} on the main rail`,
    about: say(place.description),
    rows: [],
  };
}

/** A place by its id, or an old Settings id where it went, or null. */
export function placeOf(id: string): Place | null {
  const asked = id.trim();
  const moved = SETTINGS_REDIRECTS[asked] ?? asked;
  const page = SETTINGS_PAGE_INDEX.find((p) => p.id === moved);
  if (page) return settingsPlace(page);
  const panel = PLACE_INDEX.find((p) => p.id === asked);
  return panel ? panelPlace(panel) : null;
}

/** Every id `bloks open` takes, for a refusal that lists them. */
export function placeIds(): string[] {
  return [...SETTINGS_PAGE_INDEX.map((p) => p.id), ...PLACE_INDEX.map((p) => p.id)];
}

/** A row of a page, by its English label or its address on the page
 * (the way rowKey in src/lib/settingsPages.ts writes it). */
export function rowOf(place: Place, asked: string): string | null {
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const want = key(asked);
  return place.rows.find((row) => key(row) === want) ?? null;
}

/** Words that say nothing about where a thing is. Left out of the
 * search, since a page is found only when every word is on it, and
 * "where do I change my" is on none. */
const FILLER = new Set(
  "a an and are can change do does find for from get go how i in is it me my of off on or set setting settings the there this to up want what where which with you your".split(" "),
);

export interface WhereMatch extends Place {
  /** The rows that hold the words, at most three. */
  matched: string[];
  /** What to run to put the button in the chat. */
  open: string;
}

/**
 * The best places for some words, best first.
 *
 * The app's settings search keeps a page only when every word is on it.
 * An agent's words are looser than a person's typed into a search box,
 * so here a place that holds some of them is kept too, ranked below one
 * that holds them all, and a word in a page's name counts for more than
 * one in its rows, its line or its search words, in that order.
 */
export function where(query: string, limit = 5): WhereMatch[] {
  const all = query.toLowerCase().split(/[^a-z0-9:+.-]+/).filter(Boolean);
  const words = all.filter((w) => !FILLER.has(w));
  const asked = words.length ? words : all;
  if (!asked.length) return [];
  const has = (text: string, word: string) => text.toLowerCase().includes(word);
  const scored: Array<{ match: WhereMatch; score: number; at: number }> = [];
  const candidates: Array<{ place: Place; keywords: string; groupName?: string }> = [
    ...SETTINGS_PAGE_INDEX.map((page) => ({
      place: settingsPlace(page),
      keywords: page.keywords,
      groupName: say(SETTINGS_GROUP_INDEX.find((g) => g.id === page.group)!.label),
    })),
    ...PLACE_INDEX.map((panel) => ({ place: panelPlace(panel), keywords: panel.keywords })),
  ];
  candidates.forEach(({ place, keywords, groupName }, at) => {
    let score = 0;
    let found = 0;
    for (const word of asked) {
      const weight = has(place.name, word) || has(place.id, word)
        ? 5
        : place.rows.some((row) => has(row, word))
          ? 3
          : has(place.about, word)
            ? 2
            : has(keywords, word) || (groupName && has(groupName, word))
              ? 1
              : 0;
      if (weight) found++;
      score += weight;
    }
    if (!found) return;
    // every word on the place is the app's own rule for a match, and
    // ranks above any that holds only some
    if (found === asked.length) score += 10;
    const matched = place.rows
      .map((row) => ({ row, n: asked.filter((w) => has(row, w)).length }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((r) => r.row);
    const row = matched[0];
    scored.push({
      match: { ...place, matched, open: `bloks open ${place.id}${row ? ` --row "${row}"` : ""}` },
      score,
      at,
    });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, Math.max(1, limit))
    .map((s) => s.match);
}

/** What a card that opens a place carries: enough for the app to open it,
 * and words for a window or a phone that cannot. */
export interface OpenPlan {
  kind: Place["kind"];
  page: string;
  /** The row to scroll to, by its English label. */
  row?: string;
  name: string;
  path: string;
  /** The agent whose own settings an `agent` place opens. */
  botId?: string;
  workspace?: boolean;
}

/** The card an agent's `bloks open` puts in its conversation, or why not. */
export function openCard(
  agent: { id: string; name: string },
  page: unknown,
  row: unknown,
): { ok: true; card: { title: string; subtitle: string; options: string[]; open: OpenPlan } } | { ok: false; error: string } {
  if (typeof page !== "string" || !page.trim()) return { ok: false, error: "open needs a page id: run `bloks where <words>` to find one" };
  const place = placeOf(page);
  if (!place) {
    return { ok: false, error: `there is no page "${page.slice(0, 60)}". Run \`bloks where <words>\` to find the right one; the ids are ${placeIds().join(", ")}` };
  }
  let rowLabel: string | undefined;
  if (row !== undefined && row !== null && row !== "") {
    if (typeof row !== "string") return { ok: false, error: "--row is a row's name, as `bloks where` lists it" };
    const found = rowOf(place, row);
    if (!found) {
      return {
        ok: false,
        error: place.rows.length
          ? `${place.name} has no row "${row.slice(0, 60)}". Its rows are: ${place.rows.join(", ")}`
          : `${place.name} has no rows to scroll to; open it without --row`,
      };
    }
    rowLabel = found;
  }
  const path = place.id === "agent" ? `${agent.name}'s settings: Edit profile, in its menu in the sidebar` : place.path;
  const name = place.id === "agent" ? `${agent.name}'s settings` : place.name;
  const where = rowLabel ? `${path}, ${rowLabel}` : path;
  return {
    ok: true,
    card: {
      // what a client that does not know the card draws: the words alone
      title: `Open ${name}`,
      subtitle: `${agent.name} points you to ${where}.`,
      options: [],
      open: {
        kind: place.kind,
        page: place.id,
        ...(rowLabel ? { row: rowLabel } : {}),
        name,
        path: where,
        ...(place.id === "agent" ? { botId: agent.id } : {}),
        ...(place.workspace ? { workspace: true } : {}),
      },
    },
  };
}
