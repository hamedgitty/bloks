// Filling a team's seats.
//
// A team from the library is a set of roles, and a workspace usually
// already has people. So hiring is seat-by-seat: each role defaults to a
// brand-new agent with a freshly drawn name, and any seat can instead be
// given to an existing agent who already does that job. The server then
// creates only the new ones and builds the room around everybody.
import { useMemo, useState } from "react";
import Crown from "lucide-react/dist/esm/icons/crown.js";
import { api, useStore } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { drawNames, type LibraryMember } from "@/lib/teamLibrary";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface HireableTeam {
  name: string;
  members: (LibraryMember & { name?: string })[];
}

/** Which agent fills a seat: a new hire under a drawn name, or someone
 * who already works here. */
type Seat = { kind: "new"; name: string } | { kind: "existing"; botId: string };

export function TeamHireDialog({
  team,
  onClose,
}: {
  team: HireableTeam;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const agents = state.bots.filter((b) => !b.hidden);

  // one name per seat, drawn once so re-renders don't reshuffle; a saved
  // team's stored names are kept when no current agent already uses them
  const drawnNames = useMemo(() => {
    const taken = new Set(agents.map((a) => a.name.toLowerCase()));
    const fresh = drawNames(team.members.length, taken);
    return team.members.map((member, i) =>
      member.name && !taken.has(member.name.toLowerCase()) ? member.name : fresh[i],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  const [seats, setSeats] = useState<Seat[]>(() =>
    team.members.map((_, i) => ({ kind: "new", name: drawnNames[i] })),
  );
  const [hiring, setHiring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedBotIds = new Set(seats.flatMap((s) => (s.kind === "existing" ? [s.botId] : [])));
  const newCount = seats.filter((s) => s.kind === "new").length;

  /** What this team is for, and where they work. Both optional, both
   * worth asking: a team hired into silence spends its first turns
   * asking what the project is. */
  const [brief, setBrief] = useState("");
  const [desk, setDesk] = useState("");

  const hire = () => {
    if (hiring) return;
    setHiring(true);
    setError(null);
    const members = team.members.flatMap((member, i) => {
      const seat = seats[i];
      if (seat.kind !== "new") return [];
      const { name: _stored, ...role } = member;
      return [{ ...role, name: seat.name }];
    });
    const existingMemberIds = seats.flatMap((s) => (s.kind === "existing" ? [s.botId] : []));
    api("/api/teams/import", {
      method: "POST",
      body: JSON.stringify({
        name: team.name,
        members,
        existingMemberIds,
        ...(brief.trim() ? { brief: brief.trim() } : {}),
        ...(desk.trim() ? { cwd: desk.trim() } : {}),
      }),
    })
      .then(({ blok }) =>
        api("/api/bloks").then(({ bloks }) => {
          dispatch({ type: "hydrateBloks", bloks });
          dispatch({ type: "select", id: blok.id });
          onClose();
        }),
      )
      .catch((e: Error) => {
        setError(e.message);
        setHiring(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[500px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center border-b px-5">
          <DialogTitle className="text-[14.5px]">Hire {team.name}</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-2 pt-3">
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
            Every seat starts as a new agent. If someone here already does one of these jobs,
            give them the seat instead.
          </p>
          <div className="flex flex-col gap-1.5">
            {team.members.map((member, i) => {
              const seat = seats[i];
              const chosen = seat.kind === "existing" ? agents.find((a) => a.id === seat.botId) : null;
              return (
                <div key={i} className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2">
                  {chosen ? (
                    <AgentAvatar bot={chosen} size={30} />
                  ) : (
                    <BlokAvatar color={member.color} shape={member.shape} size={30} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                      {member.title}
                      {member.seniority === 5 && <Crown size={11} className="shrink-0 text-brand-ink" />}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {seat.kind === "new" ? `New agent, named ${seat.name}` : chosen?.name}
                    </span>
                  </span>
                  <select
                    value={seat.kind === "new" ? "" : seat.botId}
                    onChange={(e) =>
                      setSeats((prev) =>
                        prev.map((s, j) =>
                          j === i
                            ? e.target.value
                              ? { kind: "existing", botId: e.target.value }
                              : { kind: "new", name: drawnNames[i] }
                            : s,
                        ),
                      )
                    }
                    className="max-w-[150px] shrink-0 rounded-lg border border-input bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-ring/60"
                  >
                    <option value="">New: {drawnNames[i]}</option>
                    {agents.map((agent) => (
                      <option
                        key={agent.id}
                        value={agent.id}
                        disabled={usedBotIds.has(agent.id) && (seat.kind !== "existing" || seat.botId !== agent.id)}
                      >
                        {agent.name}
                        {agent.title ? ` · ${agent.title}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {/* Two questions, both skippable, that decide whether the team
              arrives knowing anything. The brief reaches every member's
              own description; the folder becomes the room's shared desk. */}
          <div className="mt-4 border-t pt-3.5">
            <label className="block">
              <span className="text-[12.5px] font-medium text-muted-foreground">
                What are they working on?
              </span>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={2}
                placeholder="e.g. Launching the new pricing page in March. Audience is developers."
                className="mt-1.5 w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-[12.5px] font-medium text-muted-foreground">
                A folder to work in
              </span>
              <input
                value={desk}
                onChange={(e) => setDesk(e.target.value)}
                placeholder="Optional. e.g. ~/Projects/pricing"
                className="mt-1.5 w-full rounded-xl border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
              />
            </label>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              Both are optional and can change later. Answering now means the room starts with
              context instead of asking for it.
            </p>
          </div>
          {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3.5">
          <span className="text-[12px] text-muted-foreground">
            {newCount} new
            {seats.length - newCount > 0 && ` · ${seats.length - newCount} existing`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={hire} disabled={hiring}>
              {hiring ? "Hiring…" : "Create room"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
