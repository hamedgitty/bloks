// Point at a folder, get a team.
//
// A project folder already says what work happens in it: the manifest
// names the stack, the directories name the concerns, the README names
// the thing itself. Scouting reads those signals shallowly, no file
// contents beyond the manifest and the README's first line, and maps
// them to a roster the hire dialog can present.
//
// The mapping is plain data on purpose, like the recommend list on the
// client: a proposal that gets edited constantly as we learn what
// people keep, and a scoring function would only make that harder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ScoutedSignals {
  /** The project's own name for itself, best effort. */
  name: string;
  entries: string[];
  dependencies: string[];
  extensions: Record<string, number>;
}

/** Read a folder's surface. Bounded on purpose: the top level, one
 * manifest, one README line. Scouting must feel instant. */
export function readFolderSignals(path: string): ScoutedSignals {
  let entries: string[] = [];
  try {
    entries = readdirSync(path).filter((entry) => !entry.startsWith(".")).slice(0, 400);
  } catch {
    /* unreadable: the roster falls back to the generalists */
  }

  let name = basename(path);
  let dependencies: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    if (typeof manifest.name === "string" && manifest.name) name = manifest.name;
    dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  } catch {
    /* not a node project, or a broken manifest; both fine */
  }
  try {
    const readme = readFileSync(join(path, "README.md"), "utf8").split("\n")[0] ?? "";
    const title = readme.replace(/^#+\s*/, "").trim();
    if (title && title.length <= 60) name = title;
  } catch {
    /* no README is no signal */
  }

  const extensions: Record<string, number> = {};
  for (const entry of entries) {
    const dot = entry.lastIndexOf(".");
    if (dot > 0) {
      const ext = entry.slice(dot + 1).toLowerCase();
      extensions[ext] = (extensions[ext] ?? 0) + 1;
    }
  }
  return { name, entries, dependencies, extensions };
}

export interface ScoutedMember {
  title: string;
  description: string;
  skills: string[];
  seniority: number;
  color: string;
  shape: string;
}

const COLORS = ["blue", "green", "orange", "purple"];
const SHAPES = ["square", "round", "arch", "pill"];

/**
 * Signals to roster. Every project gets a lead and a reviewer; what
 * stands between them depends on what the folder shows. Four seats at
 * most, because a first team should read at a glance.
 */
export function proposeTeam(signals: ScoutedSignals): {
  name: string;
  brief: string;
  members: ScoutedMember[];
} {
  const has = (entry: string) => signals.entries.includes(entry);
  const dep = (...names: string[]) =>
    names.some((wanted) => signals.dependencies.some((d) => d === wanted || d.startsWith(`${wanted}/`) || d.startsWith(`@${wanted}/`)));

  const middle: Array<Omit<ScoutedMember, "color" | "shape">> = [];

  if (dep("react", "vue", "svelte", "next", "solid-js") || has("components")) {
    middle.push({
      title: "Frontend engineer",
      description:
        "You build and refine the user interface of this project. You keep components small, match the codebase's existing patterns, and check your work in the running app before calling it done.",
      skills: [
        "Build UI: implement screens and components in the project's own idiom, not a generic one",
        "Polish pass: spacing, empty states, keyboard use and dark mode before any feature is called finished",
      ],
      seniority: 3,
    });
  }
  if (has("server") || has("api") || has("backend") || dep("express", "fastify", "hono", "koa")) {
    middle.push({
      title: "Backend engineer",
      description:
        "You own the server side of this project: routes, data, and the contracts the UI relies on. You change APIs deliberately and never break a consumer silently.",
      skills: [
        "Implement endpoints: request validation first, then the work, then an honest error path",
        "Data care: migrations and stored shapes change only with a compatibility plan",
      ],
      seniority: 3,
    });
  }
  if (has("ios") || signals.extensions.swift) {
    middle.push({
      title: "iOS engineer",
      description:
        "You work on the Swift side of this project and keep it feeling native: SwiftUI idioms, platform conventions, and no web habits smuggled in.",
      skills: ["Build screens in SwiftUI matching the app's existing navigation and style"],
      seniority: 3,
    });
  }
  if (signals.extensions.py || has("pyproject.toml") || has("requirements.txt")) {
    middle.push({
      title: "Python engineer",
      description:
        "You handle the Python in this project: scripts, services or analysis, written plainly and tested where it counts.",
      skills: ["Write and refactor Python that matches the project's existing structure"],
      seniority: 3,
    });
  }
  if (has("docs") || (signals.extensions.md ?? 0) >= 3) {
    middle.push({
      title: "Docs writer",
      description:
        "You keep this project's writing true and short: README, guides and changelogs that match what the code actually does today.",
      skills: ["Update docs alongside changes; delete anything the code no longer backs"],
      seniority: 2,
    });
  }

  const members: Array<Omit<ScoutedMember, "color" | "shape">> = [
    {
      title: "Tech lead",
      description: `You lead the team working on ${signals.name}. You break work down, keep everyone unblocked, and make the final call when opinions differ. You answer for the whole, not a part.`,
      skills: [
        "Plan: turn a goal into small reviewable steps with owners",
        "Unblock: when a teammate stalls, decide or escalate the same day",
      ],
      seniority: 5,
    },
    ...middle.slice(0, 2),
    {
      title: "Reviewer",
      description:
        "You review the team's work on this project before it ships: correctness first, then clarity, then style. You say what is wrong plainly and approve what is right without ceremony.",
      skills: [
        "Review: read the whole change, run what can be run, and name concrete problems or approve",
      ],
      seniority: 4,
    },
  ];

  return {
    name: `${signals.name} team`,
    brief: `Working on ${signals.name}, the project in this folder.`,
    members: members.map((member, i) => ({
      ...member,
      color: COLORS[i % COLORS.length]!,
      shape: SHAPES[i % SHAPES.length]!,
    })),
  };
}

/** The one entry the route calls. */
export function scoutFolder(path: string) {
  if (!existsSync(path)) throw new Error("that folder does not exist");
  return proposeTeam(readFolderSignals(path));
}
