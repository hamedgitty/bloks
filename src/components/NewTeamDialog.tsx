// A new team, from the Agents page (GitHub 525). A team is a room: its
// members, its lead and who answers a message that names nobody. So this
// is the room dialog's own picker and drawing (NewRoomDialog.tsx), with
// the two things a team adds: it answers through its lead unless the
// owner says otherwise, and its members may be put under that lead in the
// reporting lines, in one step. The server makes the room and draws the
// lines together, or refuses both (POST /api/registry/teams).
import { useMemo, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { MemberPicker, RoomPreview, useModelLabel } from "./NewRoomDialog";
import { roomLead } from "@/lib/roomLead";
import { ROOM_ANSWERS, answersWords, type RoomAnswers } from "@/lib/roomRoute";
import { roomCandidates, togglePicked } from "@/lib/roomEdit";
import type { OrgView } from "@/lib/registry";
import { t } from "@/lib/i18n";

export function NewTeamDialog({ onClose, onMade }: { onClose: () => void; onMade: (org: OrgView, roomId: string) => void }) {
  const { state, dispatch } = useStore();
  const agents = roomCandidates(state.bots).filter((b) => !b.archivedAt);
  const modelLabel = useModelLabel();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [leadId, setLeadId] = useState<string | null>(null);
  // a team speaks through its lead, which is what makes it one
  const [answers, setAnswers] = useState<RoomAnswers>("lead");
  const [reportToLead, setReportToLead] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => picked.map((id) => agents.find((a) => a.id === id)).filter((a): a is Bot => Boolean(a)), [agents, picked]);
  const lead = useMemo(() => roomLead(chosen, leadId), [chosen, leadId]);
  const ready = picked.length >= 2 && name.trim().length > 0;

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api("/api/registry/teams", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          memberIds: picked,
          ...(leadId && picked.includes(leadId) ? { leadId } : {}),
          answers,
          reportToLead,
        }),
      });
      dispatch({ type: "blokPatched", blok: made.blok });
      onMade(made.org as OrgView, made.blok.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(860px,92vh)] w-[calc(100vw-24px)] max-w-[960px] flex-col gap-0 overflow-hidden p-0">
        <header className="border-b px-6 pb-4 pt-5 pr-14">
          <DialogTitle className="text-heading">{t("newTeam.title")}</DialogTitle>
          <DialogDescription className="mt-0.5">{t("newTeam.description")}</DialogDescription>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
          <div className="flex flex-col md:min-h-0 md:overflow-y-auto">
            <div className="px-6 pt-5">
              <label className="mb-1.5 block text-body font-medium text-muted-foreground" htmlFor="team-name">
                {t("common.name")}
              </label>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
                placeholder={t("newTeam.namePlaceholder")}
                autoFocus
                className="h-10 rounded-xl text-lead"
              />
            </div>
            <MemberPicker
              className="mt-6"
              agents={agents}
              picked={picked}
              onToggle={(id) => setPicked((prev) => togglePicked(prev, id))}
              lead={lead}
              onLead={setLeadId}
              modelLabel={modelLabel}
            />
          </div>
          <aside aria-label={t("newTeam.theTeam")} className="flex flex-col border-t bg-sidebar/50 md:min-h-0 md:border-l md:border-t-0">
            <div className="flex-1 px-5 py-5 md:overflow-y-auto">
              <RoomPreview name={name.trim()} chosen={chosen} lead={lead} onLead={setLeadId} modelLabel={modelLabel} unnamed={t("newTeam.yourTeam")} />
              <div className="mt-5">
                <div className="mb-1.5 text-body font-medium text-muted-foreground">{t("newRoomDialog.whoAnswers")}</div>
                <Segmented
                  aria-label={t("newRoomDialog.whoAnswers")}
                  size="sm"
                  value={answers}
                  onChange={setAnswers}
                  options={ROOM_ANSWERS.map((value) => ({ value, label: answersWords(value, null).label }))}
                />
                <p className="mt-1.5 text-pretty text-small leading-relaxed text-muted-foreground">
                  {answersWords(answers, lead?.name ?? null).hint}
                </p>
              </div>
              <label className="mt-5 flex items-start justify-between gap-3" htmlFor="team-report">
                <span className="min-w-0">
                  <span className="block text-body font-medium text-foreground">
                    {lead && chosen.length >= 2 ? t("newTeam.reportToNamed", { name: lead.name }) : t("newTeam.reportToLead")}
                  </span>
                  <span className="mt-0.5 block text-pretty text-small leading-relaxed text-muted-foreground">{t("newTeam.reportToLeadLine")}</span>
                </span>
                <Switch id="team-report" checked={reportToLead} onCheckedChange={setReportToLead} />
              </label>
            </div>
          </aside>
        </div>
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3">
          <p role={error ? "alert" : undefined} className="mr-auto min-w-0 text-pretty text-small text-destructive">
            {error}
          </p>
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="secondary" onClick={onClose} className="max-sm:flex-1">
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void create()} disabled={!ready || busy} className="min-w-[132px] max-sm:flex-1">
              {busy
                ? t("newTeam.making")
                : picked.length < 2
                  ? t("newRoomDialog.pickMore", { count: 2 - picked.length })
                  : !name.trim()
                    ? t("newTeam.nameIt")
                    : t("newTeam.create")}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
