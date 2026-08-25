// Assemble a room. Picking members is really picking an org chart, so
// the model each agent runs on is shown here: the lead does judgement on
// the expensive model, everyone else does volume on cheaper ones.
import { useEffect, useMemo, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Crown from "lucide-react/dist/esm/icons/crown.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { api, useStore, type Bot } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { TEAM_LIBRARY } from "@/lib/teamLibrary";
import { TeamHireDialog, type HireableTeam } from "./TeamHireDialog";

interface SavedTeam {
  id: string;
  name: string;
  members: unknown[];
  savedAt: number;
}
import { Button } from "@/components/ui/button";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

const MAX_MEMBERS = 8;

export function NewRoomDialog() {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<"agents" | "library">("agents");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hiring, setHiring] = useState<HireableTeam | null>(null);
  const [saved, setSaved] = useState<SavedTeam[] | null>(null);
  const [scoutError, setScoutError] = useState<string | null>(null);

  /** Point at a project folder; its shape proposes the roster. */
  const scoutFolder = (path: string) => {
    setScoutError(null);
    api("/api/teams/scout", { method: "POST", body: JSON.stringify({ path }) })
      .then(({ team, path: desk }) => {
        setHiring({ name: team.name, members: team.members, brief: team.brief, desk });
      })
      .catch((e: Error) => setScoutError(e.message));
  };

  const agents = state.bots.filter((b) => !b.hidden);
  const close = () => dispatch({ type: "toggleNewRoom", open: false });

  // rooms someone banked earlier, shown above the premade shelf
  useEffect(() => {
    api("/api/team-library")
      .then((r) => setSaved(r.teams ?? []))
      .catch(() => setSaved([]));
  }, []);

  /** Hiring opens the seat dialog: each role defaults to a fresh agent
   * with a drawn name, and seats can be given to existing agents. With
   * an empty workspace there are no seats to map, but names still need
   * drawing, so the dialog runs either way. */
  const hire = (team: HireableTeam) => setHiring(team);

  const removeSaved = (id: string) => {
    api(`/api/team-library/${id}`, { method: "DELETE" })
      .then(() => setSaved((prev) => (prev ?? []).filter((t) => t.id !== id)))
      .catch(() => {});
  };

  /** A .bloks-team.json from someone else becomes agents and a room in
   * one step. Parsed here only to fail fast; the server clamps and
   * validates everything for real. */
  const importTeam = (file: File) => {
    file
      .text()
      .then((text) => JSON.parse(text))
      .then((manifest) =>
        api("/api/teams/import", {
          method: "POST",
          body: JSON.stringify({ name: manifest.name, members: manifest.members }),
        }),
      )
      .then(({ blok }) =>
        api("/api/bloks").then(({ bloks }) => {
          dispatch({ type: "hydrateBloks", bloks });
          dispatch({ type: "select", id: blok.id });
          close();
        }),
      )
      .catch(() => {});
  };

  const modelLabel = (bot: Bot) => {
    const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
    const option = instance?.models.options.find((o) => o.id === bot.modelSelection.model);
    return option?.label ?? bot.modelSelection.model;
  };

  const lead = useMemo(() => {
    const chosen = agents.filter((a) => picked.includes(a.id));
    return chosen.reduce<Bot | null>(
      (best, a) => (!best || (a.seniority ?? 1) > (best.seniority ?? 1) ? a : best),
      null,
    );
  }, [agents, picked]);

  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id)
        ? prev.filter((p) => p !== id)
        : prev.length >= MAX_MEMBERS
          ? prev
          : [...prev, id],
    );

  const create = () => {
    if (picked.length < 2) return;
    dispatch({
      type: "createRoom",
      name: name.trim() || agents.filter((a) => picked.includes(a.id)).map((a) => a.name).join(" + "),
      memberIds: picked,
    });
  };

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex max-h-[80%] w-[520px] max-w-[92vw] animate-pop-in flex-col rounded-2xl border bg-popover p-4 shadow-2xl shadow-[--shadow-color] sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[16px] font-semibold text-foreground">New room</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              Agents talk to each other here. The most senior one reviews the rest.
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
            <X size={16} />
          </Button>
        </div>

        <div className="mt-4 flex gap-1 rounded-xl bg-muted p-1">
          {(
            [
              ["agents", "Your agents"],
              ["library", "Team library"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "flex-1 rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                tab === key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "library" ? (
          <>
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0.5">
              {Boolean(window.bloks?.pickFolder) && (
                <div className="mb-3 flex items-center gap-3 rounded-xl border border-dashed bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold text-foreground">
                      Scout a project folder
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      Point at a repo and get a team shaped to what is in it, desk included.
                    </div>
                    {scoutError && (
                      <div className="mt-1 text-[11.5px] text-destructive">{scoutError}</div>
                    )}
                  </div>
                  <BrowseFolderButton onPick={scoutFolder} />
                </div>
              )}
              {saved && saved.length > 0 && (
                <>
                  <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    My teams
                  </div>
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    {saved.map((team) => (
                      <div key={team.id} className="flex flex-col rounded-xl border bg-card p-3">
                        <div className="text-[13.5px] font-semibold text-foreground">{team.name}</div>
                        <div className="mt-0.5 flex-1 text-[11.5px] text-muted-foreground">
                          {(team.members as any[]).length} agents, saved from your own room
                        </div>
                        <div className="mt-2.5 flex gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            className="flex-1"
                            onClick={() =>
                              hire({ name: team.name, members: team.members as HireableTeam["members"] })
                            }
                          >
                            Hire this team
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Remove from library"
                            onClick={() => removeSaved(team.id)}
                          >
                            <X size={13} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Premade
                  </div>
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                {TEAM_LIBRARY.map((team) => (
                  <div key={team.slug} className="flex flex-col rounded-xl border bg-card p-3">
                    <div className="text-[13.5px] font-semibold text-foreground">{team.name}</div>
                    <div className="mt-0.5 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">
                      {team.blurb}
                    </div>
                    <div className="mt-2.5 flex items-center">
                      {team.members.map((member, i) => (
                        <span
                          key={member.title}
                          className={cn("rounded-full ring-2 ring-card", i > 0 && "-ml-1.5")}
                          title={member.title}
                        >
                          <BlokAvatar color={member.color} shape={member.shape} size={22} />
                        </span>
                      ))}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {team.members.length} agents
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[10.5px] text-muted-foreground/80">
                      Lead: {team.members.find((m) => m.seniority === 5)?.title}
                    </div>
                    <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => hire(team)}>
                      Hire this team
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              One step creates the agents and the room. Everything is editable afterwards.
            </div>
          </>
        ) : (
          <>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name, e.g. Launch week"
          className="mt-4"
        />

        <div className="mb-1.5 mt-4 flex items-baseline justify-between">
          <span className="text-[12.5px] font-medium text-muted-foreground">
            Members {picked.length > 0 && `(${picked.length})`}
          </span>
          {lead && (
            <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <Crown size={10} />
              {lead.name} leads
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
          {agents.map((agent, i) => {
            const on = picked.includes(agent.id);
            const isLead = lead?.id === agent.id && picked.length > 1;
            return (
              <button
                key={agent.id}
                onClick={() => toggle(agent.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150",
                  i > 0 && "border-t",
                  on ? "bg-brand-soft" : "hover:bg-accent",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded",
                    on ? "bg-brand-ink text-brand-foreground" : "border",
                  )}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <AgentAvatar bot={agent} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium text-foreground">
                      {agent.name}
                    </span>
                    {isLead && <Crown size={11} className="shrink-0 text-brand-ink" />}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {agent.title || "No stated role"}
                  </span>
                </span>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  {modelLabel(agent)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Seniority is set per agent in its settings. Give the reviewer your most capable model and
          the rest cheaper ones, so the expensive thinking is spent on checking the work.
        </div>

        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={close} className="flex-1">
            Cancel
          </Button>
          <Button onClick={create} disabled={picked.length < 2} className="flex-1">
            Create room
          </Button>
        </div>

          </>
        )}

        {hiring && <TeamHireDialog team={hiring} onClose={() => setHiring(null)} />}

        <label className="mt-2 block cursor-pointer text-center text-[12px] text-muted-foreground transition-colors hover:text-foreground">
          Or import a team file
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importTeam(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
