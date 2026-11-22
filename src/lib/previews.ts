// What the Bloks browser's empty tab offers to open
// (src/components/browser/BrowserPanel.tsx): the addresses on this
// computer an agent's own terminal tabs printed (a dev server's "ready
// on http://localhost:5173"), then the pages this window showed lately.
// Only what Bloks already knows: nothing here starts a server or scans a
// port. No React and no page in the part the tests read.

export interface Preview {
  url: string;
  /** Where it came from: an agent's tab, by its title, or a recent page. */
  from: { kind: "terminal"; title: string; agent: string } | { kind: "recent"; title?: string };
}

/** How many recent pages are kept, and offered. */
export const MAX_RECENT = 6;
export const RECENT_KEY = "bloks-browser-recent";

interface TabLike {
  title: string;
  exitedAt?: number;
  agent?: { name: string };
  urls?: string[];
}

/** The agent's own running tabs' addresses first, newest tab first, then
 * recent pages not already offered. */
export function previewsFrom(tabs: readonly TabLike[], recent: ReadonlyArray<{ url: string; title?: string }>): Preview[] {
  const out: Preview[] = [];
  const seen = new Set<string>();
  for (const tab of [...tabs].reverse()) {
    if (!tab.agent || tab.exitedAt) continue;
    for (const url of [...(tab.urls ?? [])].reverse()) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, from: { kind: "terminal", title: tab.title, agent: tab.agent.name } });
    }
  }
  for (const page of recent) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    out.push({ url: page.url, from: { kind: "recent", ...(page.title ? { title: page.title } : {}) } });
  }
  return out;
}

/** A page shown, at the front of the recent list: http(s) only, one entry
 * per address, the oldest past the cap dropped. */
export function noteRecent(list: ReadonlyArray<{ url: string; title?: string }>, page: { url?: string; title?: string }): Array<{ url: string; title?: string }> {
  const url = page.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return [...list];
  const title = page.title?.trim();
  return [{ url, ...(title ? { title } : {}) }, ...list.filter((p) => p.url !== url)].slice(0, MAX_RECENT);
}

/** The recent list as stored, or nothing for anything that is not one. */
export function parseRecent(raw: string | null): Array<{ url: string; title?: string }> {
  try {
    const said = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(said)) return [];
    return said
      .filter((p): p is { url: string; title?: unknown } => Boolean(p) && typeof p.url === "string" && /^https?:\/\//i.test(p.url))
      .map((p) => ({ url: p.url, ...(typeof p.title === "string" && p.title ? { title: p.title } : {}) }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}
