// Assemble a room. Picking members is really picking an org chart, so the
// room is drawn beside the list as it fills: the lead on top, wearing the
// crown, everyone else beneath, and the model each runs on in view, since
// the lead does judgement on the expensive model and the rest do volume on
// cheaper ones. The two settings a room has from its first turn, who
// answers and the folder it works in, are chosen here too, because the
// folder is fixed by that first turn.
//
// The other door is the team library: a whole team, premade, saved from a
// room of your own, scouted from a project folder or from the gallery,
// hired seat by seat in its own dialog.
//
// The picker and the drawing of the room are shared with a room's own
// Agents dialog (room/RoomAgentsDialog.tsx), so a team is chosen the same
// way before a room opens and after.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Check } from "@/components/icons";
import { Crown } from "@/components/icons";
import { FolderOpen } from "@/components/icons";
import { Search } from "@/components/icons";
import { Upload } from "@/components/icons";
import { Users } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Bot } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { TEAM_LIBRARY } from "@/lib/teamLibrary";
import { TeamHireDialog, type HireableTeam } from "./TeamHireDialog";
import { Button } from "@/components/ui/button";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/plural";
import { roomLead } from "@/lib/roomLead";
import { MAX_MEMBERS, roomCandidates, togglePicked } from "@/lib/roomEdit";

interface GalleryTeam {
  slug: string;
  name: string;
  blurb: string;
  author?: string;
  members: HireableTeam["members"];
}

interface SavedTeam {
  id: string;
  name: string;
  members: unknown[];
  savedAt: number;
}

/** Lists longer than this get a search box; shorter ones read at a glance. */
const SEARCH_ABOVE = 8;

const settle = { type: "spring", duration: 0.32, bounce: 0.15 } as const;

export function NewRoomDialog() {
  const { state, dispatch } = useStore();
  // A fresh start from a room arrives filled in with its team, its crown,
  // who answers and its folder (src/lib/roomEdit.ts); the room it came
  // from is not touched. Read once, as the dialog opens.
  const [preset] = useState(state.newRoomPreset);
  const [tab, setTab] = useState<"agents" | "library">("agents");
  const [name, setName] = useState(preset?.name ?? "");
  const [picked, setPicked] = useState<string[]>(preset?.memberIds ?? []);
  const [leadOnly, setLeadOnly] = useState(preset?.leadOnly ?? false);
  // the member whose crown was tapped; until then the most senior leads
  const [leadId, setLeadId] = useState<string | null>(preset?.leadId ?? null);
  const [folder, setFolder] = useState(preset?.cwd ?? "");
  // the error count when Create was pressed, or false while not creating
  const [creating, setCreating] = useState<number | false>(false);
  const [hiring, setHiring] = useState<HireableTeam | null>(null);
  const [saved, setSaved] = useState<SavedTeam[] | null>(null);
  const [scoutError, setScoutError] = useState<string | null>(null);

  const agents = roomCandidates(state.bots);
  const close = () => dispatch({ type: "toggleNewRoom", open: false });

  /** Point at a project folder; its shape proposes the roster. */
  const scoutFolder = (path: string) => {
    setScoutError(null);
    api("/api/teams/scout", { method: "POST", body: JSON.stringify({ path }) })
      .then(({ team, path: desk }) => {
        setHiring({ name: team.name, members: team.members, brief: team.brief, desk });
      })
      .catch((e: Error) => setScoutError(e.message));
  };

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

  /** A team file from someone else, Markdown or an older JSON export,
   * read on the server and opened in the hire dialog: nothing is made
   * until the seats are chosen, the same as a premade team. */
  const [importError, setImportError] = useState<string | null>(null);
  const importTeam = (file: File) => {
    setImportError(null);
    file
      .text()
      .then((text) => api("/api/teams/parse", { method: "POST", body: JSON.stringify({ text }) }))
      .then(({ team }) => {
        setTab("library");
        hire({ name: team.name, members: team.members });
      })
      .catch((e: Error) => setImportError(e.message));
  };

  // Teams people have written, from the gallery on bloks.dev. Asked for
  // the first time the library is opened, not on every open of the dialog.
  const [galleryTeams, setGalleryTeams] = useState<GalleryTeam[] | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "library" || galleryTeams) return;
    api("/api/teams/gallery")
      // the premade six are on the gallery too, for people without the
      // app; here they are already on the shelf above
      .then((r) => {
        const premade = new Set(TEAM_LIBRARY.map((t) => t.slug));
        setGalleryTeams((r.teams ?? []).filter((t: GalleryTeam) => !premade.has(t.slug)));
      })
      .catch((e: Error) => {
        setGalleryTeams([]);
        setGalleryError(e.message);
      });
  }, [tab, galleryTeams]);

  // A bloks:// link from the website's gallery: find the team and open
  // the same hire review a manual import does. The premade six count too.
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    const slug = state.teamLink;
    if (!slug) return;
    dispatch({ type: "openTeamLink", slug: null });
    setLinkError(null);
    setTab("library");
    const premade = TEAM_LIBRARY.find((t) => t.slug === slug);
    if (premade) {
      hire({ name: premade.name, members: premade.members } as HireableTeam);
      return;
    }
    api("/api/teams/gallery")
      .then((r) => {
        const team = (r.teams ?? []).find((t: GalleryTeam) => t.slug === slug);
        if (team) hire({ name: team.name, members: team.members });
        else setLinkError("That team is not in the gallery any more.");
      })
      .catch((e: Error) => setLinkError(`Couldn't reach the gallery: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.teamLink]);

  const modelLabel = useModelLabel();

  // in the order they were picked, which is the order the room lists them
  const chosen = useMemo(
    () => picked.map((id) => agents.find((a) => a.id === id)).filter((a): a is Bot => Boolean(a)),
    [agents, picked],
  );
  // the crown the server will honour: a tapped one while that agent is
  // still picked, the most senior otherwise
  const lead = useMemo(() => roomLead(chosen, leadId), [chosen, leadId]);
  const defaultName = chosen.map((a) => a.name).join(" + ");

  const toggle = (id: string) => setPicked((prev) => togglePicked(prev, id));

  const create = () => {
    if (picked.length < 2 || creating !== false) return;
    setCreating(state.errorAt);
    dispatch({
      type: "createRoom",
      name: name.trim() || defaultName,
      memberIds: picked,
      ...(leadId && picked.includes(leadId) ? { leadId } : {}),
      ...(leadOnly ? { leadOnly: true } : {}),
      ...(folder.trim() ? { cwd: folder.trim() } : {}),
    });
  };
  // A failed create says so through the app's error line and leaves the
  // dialog open; the button comes back rather than waiting forever. Only
  // an error newer than the press counts.
  useEffect(() => {
    if (creating !== false && state.errorAt !== creating) setCreating(false);
  }, [creating, state.errorAt]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[min(860px,92vh)] w-[calc(100vw-24px)] max-w-[960px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-6 pb-4 pt-5 pr-14">
          <div className="min-w-0">
            <DialogTitle className="text-heading">New room</DialogTitle>
            <DialogDescription className="mt-0.5">
              {preset
                ? `A fresh start with the same team. ${preset.from} stays as it is.`
                : "Agents work together here. Tap a crown to choose the lead."}
            </DialogDescription>
          </div>
          <Segmented
            aria-label="Start from"
            className="w-[260px] max-w-full"
            value={tab}
            onChange={setTab}
            options={[
              { value: "agents", label: "Your agents" },
              { value: "library", label: "Team library" },
            ]}
          />
        </header>

        {tab === "agents" ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
            {/* who is in it */}
            {/* Side by side, each column scrolls on its own; stacked on a
                phone, the whole sheet scrolls and the buttons stay put. */}
            <div className="flex flex-col md:min-h-0 md:overflow-y-auto">
              <div className="px-6 pt-5">
                <label className="mb-1.5 block text-body font-medium text-muted-foreground" htmlFor="room-name">
                  Name
                </label>
                <Input
                  id="room-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                  placeholder={defaultName || "e.g. Launch week"}
                  autoFocus
                  className="h-10 rounded-xl text-lead"
                />
              </div>
              <MemberPicker
                className="mt-6"
                agents={agents}
                picked={picked}
                onToggle={toggle}
                lead={lead}
                onLead={setLeadId}
                modelLabel={modelLabel}
              />
            </div>

            {/* the room, taking shape */}
            <aside
              aria-label="The room"
              className="flex flex-col border-t bg-sidebar/50 md:min-h-0 md:border-l md:border-t-0"
            >
              <div className="flex-1 px-5 py-5 md:overflow-y-auto">
                <RoomPreview
                  name={name.trim() || defaultName}
                  chosen={chosen}
                  lead={lead}
                  onLead={setLeadId}
                  modelLabel={modelLabel}
                />

                <div className="mt-5">
                  <div className="mb-1.5 text-body font-medium text-muted-foreground">Who answers</div>
                  <Segmented
                    aria-label="Who answers"
                    size="sm"
                    value={leadOnly ? "lead" : "everyone"}
                    onChange={(v) => setLeadOnly(v === "lead")}
                    options={[
                      { value: "everyone", label: "Everyone" },
                      { value: "lead", label: "Only the lead" },
                    ]}
                  />
                  <p className="mt-1.5 text-pretty text-small leading-relaxed text-muted-foreground">
                    {leadOnly
                      ? "Only the lead answers. Use @name to ask someone else."
                      : "Everyone answers. Use @name to ask one of them."}
                  </p>
                </div>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-body font-medium text-muted-foreground">
                    <FolderOpen size={13} />
                    Shared folder
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      placeholder="Optional. Each uses its own"
                      spellCheck={false}
                      aria-label="Shared folder"
                      className="h-8 rounded-lg bg-background font-mono text-small"
                    />
                    <BrowseFolderButton onPick={setFolder} />
                  </div>
                  <p className="mt-1.5 text-pretty text-small leading-relaxed text-muted-foreground">
                    Where members work. Fixed once the room starts.
                  </p>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5">
            {Boolean(window.bloks?.pickFolder) && (
              <div className="mb-6 flex items-center gap-4 rounded-2xl border border-dashed bg-card p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <FolderOpen size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-ui font-medium text-foreground">Scout a project folder</div>
                  <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
                    Pick a repo and get a team built for it.
                  </div>
                  {scoutError && <div className="mt-1 text-small text-destructive">{scoutError}</div>}
                </div>
                <BrowseFolderButton onPick={scoutFolder} className="h-9 px-3" />
              </div>
            )}

            {saved && saved.length > 0 && (
              <Shelf title="My teams">
                {saved.map((team) => (
                  <div key={team.id} className="group relative">
                    <TeamCard
                      name={team.name}
                      blurb="Saved from one of your rooms."
                      members={team.members as HireableTeam["members"]}
                      onHire={() => hire({ name: team.name, members: team.members as HireableTeam["members"] })}
                    />
                    <button
                      onClick={() => removeSaved(team.id)}
                      title="Remove from library"
                      aria-label={`Remove ${team.name} from the library`}
                      className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </Shelf>
            )}

            <Shelf title="Premade">
              {TEAM_LIBRARY.map((team) => (
                <TeamCard key={team.slug} name={team.name} blurb={team.blurb} members={team.members} onHire={() => hire(team)} />
              ))}
            </Shelf>

            <Shelf
              title="From the gallery"
              aside={
                <a
                  href="https://bloks.dev/teams/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-small text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  bloks.dev/teams
                </a>
              }
            >
              {galleryTeams === null ? (
                <div className="col-span-full p-4 text-body text-muted-foreground">Loading the gallery</div>
              ) : galleryTeams.length === 0 ? (
                <div className="col-span-full p-4 text-body text-muted-foreground">
                  {galleryError ? "Couldn't reach the gallery." : "Nothing in the gallery yet."}
                </div>
              ) : (
                galleryTeams.map((team) => (
                  <TeamCard
                    key={team.slug}
                    name={team.name}
                    blurb={team.blurb}
                    byline={team.author ? `by ${team.author}` : undefined}
                    members={team.members}
                    onHire={() => hire({ name: team.name, members: team.members })}
                  />
                ))
              )}
            </Shelf>
            <p className="mt-5 text-small leading-relaxed text-muted-foreground">
              Hiring a team creates its agents and room. You can edit them later.
            </p>
          </div>
        )}

        {/* outside the scroll, so Create is in reach however long the
            list, on a phone as much as anywhere */}
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3 text-small text-muted-foreground">
          <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md py-1 transition-colors duration-150 hover:text-foreground has-[:focus-visible]:text-foreground">
              <Upload size={12} />
              Import a team file (.md)
              <input
                type="file"
                accept=".md,.markdown,text/markdown,.json,application/json"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importTeam(file);
                  e.target.value = "";
                }}
              />
            </label>
            {importError && <span className="text-destructive">{importError}</span>}
            {linkError && <span className="text-destructive">{linkError}</span>}
          </div>
          {tab === "agents" && (
            <div className="flex gap-2 max-sm:w-full">
              <Button variant="secondary" onClick={close} className="max-sm:flex-1">
                Cancel
              </Button>
              <Button onClick={create} disabled={picked.length < 2 || creating !== false} className="min-w-[132px] max-sm:flex-1">
                {creating !== false ? "Opening…" : picked.length < 2 ? `Pick ${2 - picked.length} more` : "Create room"}
              </Button>
            </div>
          )}
        </footer>

        {hiring && <TeamHireDialog team={hiring} onClose={() => setHiring(null)} onHired={close} />}
      </DialogContent>
    </Dialog>
  );
}

/** What each agent runs on, as a picker labels it: the model's own name
 * where the engine gives one. */
export function useModelLabel(): (bot: Bot) => string {
  const { state } = useStore();
  return (bot: Bot) => {
    const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
    const option = instance?.models.options.find((o) => o.id === bot.modelSelection.model);
    return option?.label ?? (bot.modelSelection.model || instance?.models.default || "Default");
  };
}

/**
 * The agents to choose from, as tiles: a tap puts one in or takes it out,
 * and the crown beside a picked one makes it the lead. An archived member
 * of a room that exists is listed so it can be taken out, says so, and
 * never wears the crown, since it cannot answer.
 */
export function MemberPicker({
  agents,
  picked,
  onToggle,
  lead,
  onLead,
  modelLabel,
  className,
}: {
  agents: Bot[];
  picked: string[];
  onToggle: (id: string) => void;
  lead: Bot | null;
  onLead: (id: string) => void;
  modelLabel: (bot: Bot) => string;
  /** For the heading, which sits under whatever comes before it. */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? agents.filter((a) => `${a.name} ${a.title}`.toLowerCase().includes(q)) : agents;
  return (
    <>
      <div className={cn("mb-2.5 flex items-center justify-between gap-3 px-6", className)}>
        <span className="text-body font-medium text-muted-foreground">
          Members
          <span className="ml-1.5 tabular-nums text-muted-foreground/80">
            {picked.length ? `${picked.length} of ${MAX_MEMBERS}` : `up to ${MAX_MEMBERS}`}
          </span>
        </span>
        {agents.length > SEARCH_ABOVE && (
          <label className="flex h-8 w-[200px] items-center gap-2 rounded-full border bg-card px-3 transition-colors duration-150 focus-within:border-ring/50">
            <Search size={13} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an agent"
              aria-label="Find an agent"
              className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        )}
      </div>
      <div role="group" aria-label="Members" className="grid grid-cols-1 gap-1.5 px-6 pb-6 sm:grid-cols-2">
        {shown.map((agent) => {
          const on = picked.includes(agent.id);
          const full = !on && picked.length >= MAX_MEMBERS;
          const crownable = on && picked.length > 1 && !agent.archivedAt;
          const isLead = crownable && lead?.id === agent.id;
          return (
            // The crown is a button of its own beside the tile, not
            // inside it: one press picks the member, the other the lead.
            <div key={agent.id} className="relative min-w-0">
            <button
              role="checkbox"
              aria-checked={on}
              disabled={full}
              onClick={() => onToggle(agent.id)}
              className={cn(
                "group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,scale,opacity] duration-150 ease-out active:scale-[0.985] disabled:opacity-45",
                on ? "border-brand bg-brand-soft" : "bg-card hover:border-foreground/20 hover:bg-accent/40",
                crownable && "pr-12",
              )}
            >
              <span className="relative shrink-0">
                <AgentAvatar bot={agent} size={34} />
                <span
                  className={cn(
                    "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full ring-2 transition-[opacity,scale] duration-150 ease-out",
                    on ? "scale-100 bg-brand-ink text-brand-foreground opacity-100 ring-brand-soft" : "scale-75 opacity-0 ring-card",
                  )}
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-foreground">{agent.name}</span>
                <span className="block truncate text-small text-muted-foreground">
                  {agent.archivedAt ? "Archived" : agent.title || "No stated role"}
                </span>
              </span>
              <span className="max-w-[96px] shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
                {modelLabel(agent)}
              </span>
            </button>
            {crownable && (
              <CrownButton
                on={isLead}
                name={agent.name}
                onPick={() => onLead(agent.id)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2"
              />
            )}
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-body text-muted-foreground">
            {agents.length ? `No agent matches “${query.trim()}”.` : "No agents yet. Try the team library."}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The room as it will open: its name, its lead on top with the crown,
 * the others beneath. Members arrive and leave in place, and the crown
 * moves when a more senior agent joins or another is crowned, so the
 * shape of the org chart is seen changing rather than re-read.
 */
export function RoomPreview({
  name,
  chosen,
  lead,
  onLead,
  modelLabel,
}: {
  name: string;
  chosen: Bot[];
  lead: Bot | null;
  onLead: (id: string) => void;
  modelLabel: (bot: Bot) => string;
}) {
  const rest = chosen.filter((a) => a.id !== lead?.id);
  const ready = chosen.length >= 2;
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Users size={14} />
        </span>
        <span className={cn("min-w-0 truncate text-lead font-semibold tracking-tight", name ? "text-foreground" : "text-muted-foreground")}>
          {name || "Your room"}
        </span>
      </div>

      <LayoutGroup>
        <div className="mt-4 min-h-[148px]">
          {chosen.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <div className="flex items-center gap-2">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-9 rounded-[10px] border-2 border-dashed border-border" />
                ))}
              </div>
              <p className="max-w-[220px] text-pretty text-body leading-relaxed text-muted-foreground">
                Pick two or more agents, then crown a lead.
              </p>
            </div>
          ) : (
            <>
              {/* a new lead is a new row, so the change of hands reads as
                  one, rather than a name swapped under a still face */}
              <AnimatePresence initial={false} mode="popLayout">
              {lead && (
                <motion.div
                  key={lead.id}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  transition={settle}
                  className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5"
                >
                  <span className="relative shrink-0">
                    <AgentAvatar bot={lead} size={36} />
                    {ready && (
                      <motion.span
                        initial={{ scale: 0.4, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", duration: 0.35, bounce: 0.45 }}
                        className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full bg-brand-ink text-brand-foreground ring-2 ring-card"
                      >
                        <Crown size={10} />
                      </motion.span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-foreground">{lead.name}</span>
                    <span className="block truncate text-small text-muted-foreground">
                      {ready ? "Leads and decides" : "Pick one more"}
                    </span>
                  </span>
                  <span className="max-w-[90px] shrink-0 truncate text-caption text-muted-foreground">{modelLabel(lead)}</span>
                </motion.div>
              )}
              </AnimatePresence>
              {rest.length > 0 && (
                <>
                  {/* the line that makes it a chart: the lead above, the
                      team hanging off it */}
                  <div aria-hidden className="ml-[29px] h-3 w-px bg-border" />
                  <div className="flex flex-col gap-1">
                    <AnimatePresence initial={false}>
                      {rest.map((agent) => (
                        <motion.div
                          key={agent.id}
                          layout="position"
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, transition: { duration: 0.12 } }}
                          transition={settle}
                          className="group flex items-center gap-3 px-3 py-1.5"
                        >
                          <AgentAvatar bot={agent} size={28} />
                          <span className="min-w-0 flex-1 truncate text-body text-foreground">{agent.name}</span>
                          <span className="max-w-[90px] shrink-0 truncate text-caption text-muted-foreground">{modelLabel(agent)}</span>
                          {/* out of the way until the row is pointed at; the
                              list beside this always shows its crowns */}
                          <CrownButton
                            on={false}
                            name={agent.name}
                            onPick={() => onLead(agent.id)}
                            className="-my-1 -mr-1.5 size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </LayoutGroup>

      {ready && (
        <p className="mt-3 border-t pt-3 text-pretty text-small leading-relaxed text-muted-foreground">
          Tap a crown to change the lead. Give the lead your best model and the rest cheaper ones.
        </p>
      )}
    </div>
  );
}

/** A member's crown, as the way to make it the lead: filled on the lead,
 * faint on everyone else until pressed. */
function CrownButton({
  on,
  name,
  onPick,
  className,
}: {
  on: boolean;
  name: string;
  onPick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `${name} leads` : `Make ${name} the lead`}
      title={on ? "Leads" : "Make lead"}
      onClick={onPick}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-[background-color,color,opacity,scale] duration-150 ease-out active:scale-90",
        on
          ? "bg-brand-ink text-brand-foreground"
          : "text-muted-foreground/55 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground",
        className,
      )}
    >
      <Crown size={13} />
    </button>
  );
}

function Shelf({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-body font-semibold text-foreground">{title}</h3>
        {aside}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/** One team on a shelf: what it is for, its faces with the lead crowned,
 * and a click to hire it. */
function TeamCard({
  name,
  blurb,
  byline,
  members,
  onHire,
}: {
  name: string;
  blurb: string;
  byline?: string;
  members: HireableTeam["members"];
  onHire: () => void;
}) {
  const lead = members.reduce((best, m) => (m.seniority > best.seniority ? m : best), members[0]);
  return (
    <button
      onClick={onHire}
      className="flex h-full w-full min-w-0 flex-col rounded-xl border bg-card p-3.5 text-left outline-none transition-[border-color,background-color,scale] duration-150 ease-out hover:border-foreground/20 hover:bg-accent/40 active:scale-[0.985]"
    >
      <span className="flex items-center pr-6">
        {members.map((member, i) => (
          <span key={`${member.title}-${i}`} className={cn("relative rounded-[8px] ring-2 ring-card", i > 0 && "-ml-1.5")} title={member.title}>
            <BlokAvatar color={member.color} shape={member.shape} size={26} />
            {member === lead && (
              <Crown size={9} className="absolute -right-1 -top-1 rounded-full bg-card text-brand-ink" />
            )}
          </span>
        ))}
      </span>
      <span className="mt-3 text-ui font-medium text-foreground">{name}</span>
      <span className="mt-0.5 line-clamp-2 flex-1 text-small leading-relaxed text-muted-foreground">{blurb}</span>
      <span className="mt-2.5 truncate text-caption text-muted-foreground">
        {plural(members.length, "agent")}
        {lead ? `, led by the ${lead.title}` : ""}
        {byline ? `, ${byline}` : ""}
      </span>
    </button>
  );
}
