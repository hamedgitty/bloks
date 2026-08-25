// Projects: the thing folders, people and a brief belong to.
//
// A lens rather than a container. Nothing is moved into a project and
// nothing is hidden from anyone; a project says where its work happens,
// who is on it, and what everybody working on it should have read.
//
// The state worth designing for is the unhappy one. A folder that has
// moved is the normal end of a project's life, so it is shown per folder,
// on the card, in the words somebody would use: this is not there any
// more, and nothing will run in it until it is.
import { useCallback, useEffect, useState } from "react";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { api, useStore } from "@/state/store";
import { BLOK_COLOR_NAMES, BLOK_SHAPES, type BlokColor, type BlokShape } from "@/lib/mascot";
import { BlokAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { cn } from "@/lib/cn";

interface FolderStanding {
  path: string;
  state: "ok" | "missing" | "not-a-folder";
}

export interface ProjectRow {
  id: string;
  name: string;
  brief: string;
  color: BlokColor;
  shape: BlokShape;
  folders: string[];
  include: string[];
  memberIds: string[];
  createdAt: number;
  lastOpenedAt?: number;
  archivedAt?: number;
  folderStates: FolderStanding[];
  broken: boolean;
}

const WHY: Record<FolderStanding["state"], string | null> = {
  ok: null,
  missing: "not there any more",
  "not-a-folder": "not a folder",
};

export function ProjectsPanel() {
  const { state, dispatch } = useStore();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [editing, setEditing] = useState<ProjectRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api("/api/projects")
        .then((r) => {
          setProjects(r.projects ?? []);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const close = () => dispatch({ type: "toggleProjects", open: false });

  const open = (project: ProjectRow) => {
    void api(`/api/projects/${project.id}/open`, { method: "POST" }).catch(() => {});
    dispatch({ type: "openProject", id: project.id });
    close();
  };

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex h-[76%] w-[600px] max-w-[92vw] animate-pop-in flex-col rounded-2xl border bg-popover p-5 shadow-2xl shadow-[--shadow-color]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[16px] font-semibold text-foreground">Projects</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {editing
                ? "Where the work happens, who is on it, and what they should know."
                : "Switch into one and the app shows its people and its folders."}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {!editing && (
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
                <Plus size={13} />
                New
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Close projects" onClick={close}>
              <X size={16} />
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            {error}
          </div>
        )}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {editing ? (
            <ProjectForm
              project={editing === "new" ? null : editing}
              onDone={() => {
                setEditing(null);
                void load();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : projects === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Reading projects
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-[13px] text-muted-foreground">
              No projects yet. One is a name, some folders, and the people on it.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.map((project) => {
                const members = project.memberIds
                  .map((id) => state.bots.find((b) => b.id === id))
                  .filter(Boolean);
                return (
                  <div
                    key={project.id}
                    className={cn(
                      "rounded-2xl border bg-card p-3.5",
                      state.projectId === project.id && "border-foreground/25",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <BlokAvatar color={project.color} shape={project.shape} expression="focused" size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {project.name}
                          </span>
                          {state.projectId === project.id && (
                            <span className="shrink-0 text-[11px] text-brand-ink">open</span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[12px] text-muted-foreground">
                          {members.length
                            ? members.map((b) => b!.name).join(", ")
                            : "nobody on it yet"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(project)}>
                          Edit
                        </Button>
                        <Button
                          variant={state.projectId === project.id ? "ghost" : "secondary"}
                          size="sm"
                          onClick={() =>
                            state.projectId === project.id
                              ? dispatch({ type: "openProject", id: null })
                              : open(project)
                          }
                        >
                          {state.projectId === project.id ? "Leave" : "Open"}
                        </Button>
                      </div>
                    </div>

                    {project.brief && (
                      <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                        {project.brief}
                      </p>
                    )}

                    {project.folderStates.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {project.folderStates.map((folder) => (
                          <div
                            key={folder.path}
                            className={cn(
                              "flex items-center gap-1.5 text-[11.5px]",
                              folder.state === "ok" ? "text-muted-foreground" : "text-warning",
                            )}
                          >
                            {folder.state === "ok" ? (
                              <FolderOpen size={12} className="shrink-0" />
                            ) : (
                              <TriangleAlert size={12} className="shrink-0" />
                            )}
                            <span className="truncate font-mono">{folder.path}</span>
                            {WHY[folder.state] && <span className="shrink-0">· {WHY[folder.state]}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {project.broken && (
                      <div className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning">
                        Nothing will run in this project until those folders are back, or it points
                        somewhere else. An agent writing into the wrong directory is worse than one
                        that will not start.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectForm({
  project,
  onDone,
  onCancel,
}: {
  project: ProjectRow | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState(project?.name ?? "");
  const [brief, setBrief] = useState(project?.brief ?? "");
  const [folders, setFolders] = useState((project?.folders ?? []).join("\n"));
  const [include, setInclude] = useState((project?.include ?? []).join(", "));
  const [members, setMembers] = useState<string[]>(project?.memberIds ?? []);
  const [color, setColor] = useState<BlokColor>(project?.color ?? BLOK_COLOR_NAMES[0]);
  const [shape, setShape] = useState<BlokShape>(project?.shape ?? BLOK_SHAPES[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      name,
      brief,
      color,
      shape,
      folders: folders.split("\n").map((f) => f.trim()).filter(Boolean),
      include: include.split(",").map((f) => f.trim()).filter(Boolean),
      memberIds: members,
    });
    const request = project
      ? api(`/api/projects/${project.id}`, { method: "PATCH", body })
      : api("/api/projects", { method: "POST", body });
    request
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <BlokAvatar color={color} shape={shape} expression="focused" size={36} />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch week" autoFocus />
      </div>

      <div className="flex flex-wrap gap-1">
        {BLOK_COLOR_NAMES.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={c}
            className={cn(
              "size-5 rounded-full border-2 transition-transform duration-150 hover:scale-110",
              color === c ? "border-foreground" : "border-transparent",
            )}
            style={{ background: `var(--blok-${c})` }}
          />
        ))}
        <span className="mx-1 w-px bg-border" />
        {BLOK_SHAPES.map((s) => (
          <button
            key={s}
            onClick={() => setShape(s)}
            aria-label={s}
            className={cn(
              "rounded-md p-0.5 transition-colors duration-150",
              shape === s ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <BlokAvatar color={color} shape={s} expression="deadpan" size={18} />
          </button>
        ))}
      </div>

      <label className="text-[12.5px] text-muted-foreground">
        The standing brief. Everyone working on this gets it.
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="Ship small, ship often. Prefer the boring option."
          className="mt-1 resize-none"
        />
      </label>

      <label className="text-[12.5px] text-muted-foreground">
        Folders, one per line. The first one that exists is where turns run.
        <div className="mt-1 flex items-start gap-1.5">
          <Textarea
            value={folders}
            onChange={(e) => setFolders(e.target.value)}
            rows={2}
            placeholder="/Users/you/src/api"
            className="resize-none font-mono text-[12px]"
          />
          <BrowseFolderButton
            onPick={(path) =>
              setFolders((current: string) => (current.trim() ? `${current.trimEnd()}\n${path}` : path))
            }
          />
        </div>
      </label>

      <label className="text-[12.5px] text-muted-foreground">
        What matters inside them, comma separated. Advisory, not a filter.
        <Input
          value={include}
          onChange={(e) => setInclude(e.target.value)}
          placeholder="src/**, docs/*.md"
          className="mt-1 font-mono text-[12px]"
        />
      </label>

      <div>
        <div className="text-[12.5px] text-muted-foreground">Who is on it</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {state.bots
            .filter((b) => !b.hidden)
            .map((bot) => {
              const on = members.includes(bot.id);
              return (
                <button
                  key={bot.id}
                  onClick={() => setMembers(on ? members.filter((id) => id !== bot.id) : [...members, bot.id])}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[12px] transition-colors duration-150",
                    on ? "border-foreground/25 bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <BlokAvatar color={bot.color} shape={bot.shape} expression="friendly" size={18} />
                  {bot.name}
                </button>
              );
            })}
        </div>
      </div>

      {error && <div className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={saving || !name.trim()} onClick={save}>
          {saving && <Loader2 size={12} className="animate-spin" />}
          {project ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
