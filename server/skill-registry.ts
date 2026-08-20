// A catalog of skills, and an honest answer about each one.
//
// A skill is a markdown file an agent follows. Ours have been local files
// only, which means the way to get one is to write it, and the way to
// find out somebody wrote a better one is to be told.
//
// The interesting part of a registry is not the browsing, it is what it
// says about a skill you already have. Three facts decide that, and the
// difference between them is the whole feature:
//
//   what the catalog is offering        the published content, hashed
//   what you installed                  the hash recorded at install
//   what is on your disk now            the hash of the file today
//
// If the last two disagree, you edited it, and an update would throw your
// edit away. Saying "update available" in that case, or worse just
// applying it, is how a tool loses somebody's work. So an edited skill is
// its own state, and replacing it is a separate thing to agree to.
//
// Everything here is pure. Fetching lives in server/index.ts.
import { createHash } from "node:crypto";

/** Where the catalog lives. Ours, on our own domain, because a registry
 * on somebody else's is a registry that can change under you. */
export const REGISTRY_URL = "https://bloks.dev/skills/index.json";

/** How long a fetched catalog is trusted before asking again. */
export const CATALOG_TTL_MS = 30 * 60 * 1000;

export const MAX_CATALOG_BYTES = 512 * 1024;
export const MAX_ENTRY_BODY = 16_000;

/** One skill as the catalog describes it. */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  /** Free text, so a catalog can say "2" or "2026.02" without us caring. */
  version: string;
  tags: string[];
  /** The instructions themselves, hashed so an install can be compared. */
  body: string;
  sha256: string;
  /** Who wrote it, for the detail page. */
  author?: string;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex");
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Read a catalog somebody else served us.
 *
 * Every field is taken by name and re-checked, and an entry that does not
 * survive is dropped rather than failing the catalog: one bad skill in a
 * list of forty should cost that skill, not the registry.
 */
export function parseCatalog(value: unknown): RegistryEntry[] {
  const list = Array.isArray((value as any)?.skills) ? (value as any).skills : value;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
    const body = typeof entry.body === "string" ? entry.body.trim() : "";
    if (!SLUG.test(id) || seen.has(id) || !body) continue;
    if (Buffer.byteLength(body, "utf8") > MAX_ENTRY_BODY) continue;
    seen.add(id);
    out.push({
      id,
      name: (typeof entry.name === "string" ? entry.name : id).trim().slice(0, 80) || id,
      description: (typeof entry.description === "string" ? entry.description : "").trim().slice(0, 200),
      version: (typeof entry.version === "string" ? entry.version : "1").trim().slice(0, 24) || "1",
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((t): t is string => typeof t === "string").slice(0, 8).map((t) => t.slice(0, 24))
        : [],
      body,
      // a catalog may state the hash, but ours is the one that counts:
      // a stated hash that disagrees with the bytes is not a hash
      sha256: hashBody(body),
      ...(typeof entry.author === "string" ? { author: entry.author.slice(0, 60) } : {}),
    });
  }
  return out;
}

// ── what state one skill is in ─────────────────────────────────────────

/** What we recorded about a skill when it was installed from a catalog. */
export interface InstalledMark {
  registry?: string;
  version?: string;
  /** The hash of the body as it was installed. */
  sha256?: string;
}

export type SkillState =
  /** Not here yet. */
  | "available"
  /** Here, and the same as what the catalog offers. */
  | "current"
  /** Here, older, and untouched since it was installed. */
  | "outdated"
  /** Here, changed on this machine since it was installed. */
  | "edited"
  /** Changed here, and the catalog has moved on too. */
  | "edited-and-outdated"
  /** Here, but not from this catalog: somebody wrote it themselves. */
  | "yours"
  /** A skill Bloks ships with, under the same name. Installing the
   * catalog's makes a copy that shadows it, and deleting that copy brings
   * the bundled one back, so nothing is lost either way. */
  | "bundled";

export interface Standing {
  state: SkillState;
  /** What a person should be told, in one line. */
  says: string;
  /** What the button should say, or null when there is nothing to do. */
  action: string | null;
  /** True when acting would discard something. */
  destructive: boolean;
}

/**
 * Where an installed skill stands against the catalog.
 *
 * `installed` is the file on disk right now; `mark` is what was recorded
 * when it arrived. Both are needed, because the question "has this been
 * edited" cannot be answered by either one alone.
 */
export function standing(
  entry: RegistryEntry,
  installed: { body: string; source?: "builtin" | "user" } | null,
  mark: InstalledMark | null,
): Standing {
  if (!installed) {
    return { state: "available", says: "Not installed", action: "Install", destructive: false };
  }
  // One Bloks ships with. Installing the catalog's writes a copy that
  // shadows it rather than replacing anything, and deleting that copy
  // brings the bundled one back, so this is not destructive and should
  // not be described as though it were.
  if (installed.source === "builtin") {
    return {
      state: "bundled",
      says: "Bloks ships a skill with this name. Installing the catalog's shadows it, and removing that copy brings the bundled one back",
      action: "Install",
      destructive: false,
    };
  }
  const here = hashBody(installed.body);

  // Nothing recorded: this file did not come from the catalog, whatever
  // its name is. Taking it over silently would be a tool overwriting
  // somebody's own work because the names happened to match.
  if (!mark?.registry || !mark.sha256) {
    return {
      state: "yours",
      says: "You have a skill with this name that you wrote yourself",
      action: "Replace",
      destructive: true,
    };
  }

  const edited = here !== mark.sha256;
  const behind = entry.sha256 !== mark.sha256;

  if (edited && behind) {
    return {
      state: "edited-and-outdated",
      says: `You have changed this, and version ${entry.version} has since been published`,
      action: "Replace",
      destructive: true,
    };
  }
  if (edited) {
    return {
      state: "edited",
      // The button says the verb and this says what it costs, so the
      // sentence has to carry what "restore" would throw away.
      says: "You have changed this since installing it. Restoring puts the catalog's version back and drops your edits",
      action: "Restore",
      destructive: true,
    };
  }
  if (behind) {
    return {
      state: "outdated",
      says: `Version ${entry.version} is available`,
      action: "Update",
      destructive: false,
    };
  }
  return { state: "current", says: `Up to date, version ${mark.version ?? entry.version}`, action: null, destructive: false };
}

/** The catalog with each entry's standing worked out. */
export interface Listing extends RegistryEntry {
  standing: Standing;
}

export function listing(
  catalog: RegistryEntry[],
  installed: Map<string, { body: string; source?: "builtin" | "user" } & InstalledMark>,
): Listing[] {
  return catalog.map((entry) => {
    const here = installed.get(entry.id) ?? null;
    return {
      ...entry,
      standing: standing(entry, here, here),
    };
  });
}

/** How many of these are worth telling somebody about. */
export function updateCount(entries: Listing[]): number {
  return entries.filter((entry) => entry.standing.state === "outdated").length;
}

/** Everything an installed skill's frontmatter records about where it
 * came from. Written on install, read on every comparison. */
export function markFor(entry: RegistryEntry): Required<InstalledMark> {
  return { registry: entry.id, version: entry.version, sha256: entry.sha256 };
}
