// A project: a thing you switch into rather than a setting you change.
//
// We already had folders. An agent has one, a room has one, and a turn
// runs in whichever applies. What we did not have was the thing those
// belong to: a name, the folders it covers, the people on it, and the
// standing brief everybody working on it should have read.
//
// Two decisions shape the rest.
//
//   A project is a lens, not a container. Agents are not moved into it and
//   nothing is hidden from anyone; opening a project scopes what you are
//   looking at and gives its agents a folder and a brief. Closing it puts
//   everything back. Moving objects into containers is how a workspace
//   becomes a filing problem.
//
//   A folder that has gone is said out loud. Berd carries a list of
//   working directories per project, and the thing that matters is what
//   happens when one of them moves: falling back to somewhere else is
//   worse than stopping, because an agent quietly writing into the wrong
//   directory is harder to notice than an agent refusing to start.
//
// The pure half is here. Reading the disk and running turns is the
// caller's problem.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import type { BlokColor, BlokShape } from "./store.ts";

export const MAX_PROJECTS = 60;
export const MAX_NAME = 60;
export const MAX_BRIEF = 4_000;
export const MAX_FOLDERS = 8;
export const MAX_INCLUDES = 24;

export interface Project {
  id: string;
  name: string;
  /** What everybody working on this should have read. Joins the persona
   * of any agent taking a turn inside the project. */
  brief: string;
  /** The identity system we already have, so a project looks like the
   * things it holds rather than like a folder icon. */
  color: BlokColor;
  shape: BlokShape;
  /** Where the work lives. More than one, because a project is often a
   * couple of repositories rather than a directory. */
  folders: string[];
  /** What matters inside those folders, as the person would say it.
   * Advisory: it goes into the brief rather than filtering anything, so
   * it can be wrong without breaking a turn. */
  include: string[];
  /** Who is on it. */
  memberIds: string[];
  createdAt: number;
  lastOpenedAt?: number;
  /** Set rather than deleted, so a finished project stops appearing
   * without taking its history with it. */
  archivedAt?: number;
}

/** What a folder is doing right now. */
export type FolderState = "ok" | "missing" | "not-a-folder";

export interface FolderStanding {
  path: string;
  state: FolderState;
}

/** A project, with the disk's opinion of its folders. */
export interface ProjectStanding extends Project {
  folderStates: FolderStanding[];
  /** True when at least one folder is gone. The project still opens and
   * still reads; what stops is running a turn in a folder that is not
   * there. */
  broken: boolean;
}

/**
 * Where a turn should run for this project.
 *
 * The first folder that is actually there. Null when none of them are,
 * which is a turn that should not start rather than a turn that should
 * run somewhere else.
 */
export function workingFolder(standing: ProjectStanding): string | null {
  return standing.folderStates.find((folder) => folder.state === "ok")?.path ?? null;
}

/** What an agent taking a turn inside a project is told. */
export function briefFor(project: Project): string {
  const lines: string[] = [`You are working on ${project.name}.`];
  if (project.brief.trim()) lines.push(project.brief.trim());
  if (project.folders.length > 1) {
    lines.push(`Its folders: ${project.folders.join(", ")}. You are running in the first of them.`);
  }
  if (project.include.length) {
    lines.push(
      `What matters here: ${project.include.join(", ")}. Anything else in these folders is probably not what you were asked about.`,
    );
  }
  return lines.join("\n\n");
}

/** Said when somebody tries to work in a project whose folder has gone. */
export function missingFolderMessage(project: Project, missing: string[]): string {
  const list = missing.join(", ");
  return missing.length === 1
    ? `${project.name} points at ${list}, which is not there any more. Nothing will run in it until that folder is back or the project points somewhere else.`
    : `${project.name} points at folders that are not there any more: ${list}. Nothing will run in it until they are back or the project points somewhere else.`;
}

const COLORS: BlokColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
const SHAPES: BlokShape[] = ["star", "burst", "diamond", "bit", "triangle", "cloud", "drop", "invader"];

export interface NewProject {
  name?: string;
  brief?: string;
  color?: string;
  shape?: string;
  folders?: string[];
  include?: string[];
  memberIds?: string[];
}

/** Everything a client may set, checked into shape. */
export function cleanInput(input: NewProject, existing?: Project): Partial<Project> {
  const out: Partial<Project> = {};
  if (input.name !== undefined) out.name = String(input.name).trim().slice(0, MAX_NAME);
  if (input.brief !== undefined) out.brief = String(input.brief).slice(0, MAX_BRIEF);
  if (typeof input.color === "string" && COLORS.includes(input.color as BlokColor)) {
    out.color = input.color as BlokColor;
  }
  if (typeof input.shape === "string" && SHAPES.includes(input.shape as BlokShape)) {
    out.shape = input.shape as BlokShape;
  }
  if (Array.isArray(input.folders)) {
    out.folders = input.folders
      .filter((f): f is string => typeof f === "string" && Boolean(f.trim()))
      .map((f) => f.trim())
      .slice(0, MAX_FOLDERS);
  }
  if (Array.isArray(input.include)) {
    out.include = input.include
      .filter((f): f is string => typeof f === "string" && Boolean(f.trim()))
      .map((f) => f.trim().slice(0, 120))
      .slice(0, MAX_INCLUDES);
  }
  if (Array.isArray(input.memberIds)) {
    out.memberIds = input.memberIds
      .filter((id): id is string => typeof id === "string" && /^[\w-]{1,64}$/.test(id))
      .slice(0, 40);
  }
  if (!out.name && !existing?.name) out.name = "Untitled project";
  return out;
}

const PROJECTS_FILE = join(DATA_DIR, "projects.json");

export class ProjectStore {
  projects: Project[] = [];

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
      if (Array.isArray(parsed)) {
        this.projects = parsed.filter((p) => p?.id && typeof p.name === "string");
      }
    } catch {
      /* no projects yet */
    }
  }

  private save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(PROJECTS_FILE, JSON.stringify(this.projects, null, 2), { mode: 0o600 });
    } catch {
      /* still a project for this session */
    }
  }

  list(includeArchived = false): Project[] {
    return this.projects
      .filter((p) => includeArchived || !p.archivedAt)
      .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt));
  }

  get(id: string): Project | null {
    return this.projects.find((p) => p.id === id) ?? null;
  }

  create(input: NewProject, now: number): Project {
    const clean = cleanInput(input);
    const project: Project = {
      id: newId(),
      name: clean.name ?? "Untitled project",
      brief: clean.brief ?? "",
      color: clean.color ?? COLORS[this.projects.length % COLORS.length],
      shape: clean.shape ?? SHAPES[this.projects.length % SHAPES.length],
      folders: clean.folders ?? [],
      include: clean.include ?? [],
      memberIds: clean.memberIds ?? [],
      createdAt: now,
    };
    this.projects.unshift(project);
    if (this.projects.length > MAX_PROJECTS) this.projects.length = MAX_PROJECTS;
    this.save();
    return project;
  }

  patch(id: string, input: NewProject): Project | null {
    const project = this.get(id);
    if (!project) return null;
    Object.assign(project, cleanInput(input, project));
    this.save();
    return project;
  }

  opened(id: string, now: number): Project | null {
    const project = this.get(id);
    if (!project) return null;
    project.lastOpenedAt = now;
    this.save();
    return project;
  }

  archive(id: string, now: number): Project | null {
    const project = this.get(id);
    if (!project) return null;
    project.archivedAt = now;
    this.save();
    return project;
  }

  remove(id: string): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length === before) return false;
    this.save();
    return true;
  }

  /** An agent that is deleted leaves every project it was on. */
  removeMember(botId: string) {
    let touched = false;
    for (const project of this.projects) {
      const next = project.memberIds.filter((id) => id !== botId);
      if (next.length !== project.memberIds.length) {
        project.memberIds = next;
        touched = true;
      }
    }
    if (touched) this.save();
  }

  /** The project an agent is on, if any. First match wins: an agent on
   * two projects is unusual and picking the most recently opened one is
   * the least surprising answer. */
  forAgent(botId: string): Project | null {
    return this.list().find((project) => project.memberIds.includes(botId)) ?? null;
  }
}
