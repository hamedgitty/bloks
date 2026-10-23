// Who is in a room, changed after it opened (GitHub 370). The same picker
// and the same drawing of the room as the New room dialog, so adding an
// agent here reads the way choosing one did there; what is different is
// that the room already has a conversation, which stays as it is.
//
// Saved as one change, the roster and any crown together, so no turn
// ever runs under half of it.
import { useState } from "react";
import { api, useStore, type Blok, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MemberPicker, RoomPreview, useModelLabel } from "../NewRoomDialog";
import { leadNote, MIN_MEMBERS, roomCandidates, rosterPatch, togglePicked } from "@/lib/roomEdit";
import { roomLead } from "@/lib/roomLead";

export function RoomAgentsDialog({ blok, onClose }: { blok: Blok; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const modelLabel = useModelLabel();
  // as the room has them now, in its order; additions go on the end
  const [picked, setPicked] = useState<string[]>(() => [...blok.memberIds]);
  // the room's own crown until another is tapped
  const [leadId, setLeadId] = useState<string | null>(blok.leadId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agents = roomCandidates(state.bots, blok.memberIds);
  const chosen = picked.map((id) => agents.find((a) => a.id === id)).filter((a): a is Bot => Boolean(a));
  // The crown is worn by someone who can answer, as the room decides it
  // (RoomView), so an archived member keeps its seat but never leads.
  const answering = chosen.filter((a) => !a.archivedAt);
  const lead = roomLead(answering, leadId);
  // who led when this opened, to say so if they are taken out
  const [before] = useState(() =>
    roomLead(
      blok.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b && !b.archivedAt)),
      blok.leadId,
    ),
  );
  const note = leadNote(before, answering, leadId);
  const change = rosterPatch(blok, picked, leadId);

  const save = () => {
    if (!change || picked.length < MIN_MEMBERS || saving) return;
    setSaving(true);
    setError(null);
    // Straight to the server rather than shown first: a roster it refuses
    // (too few, too many) stays here with the reason, not in the room.
    api(`/api/bloks/${blok.id}`, { method: "PATCH", body: JSON.stringify(change) })
      .then(({ blok: saved }) => {
        dispatch({ type: "blokPatched", blok: saved });
        onClose();
      })
      .catch((e: Error) => {
        setError(e.message);
        setSaving(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(860px,92vh)] w-[calc(100vw-24px)] max-w-[960px] flex-col gap-0 overflow-hidden p-0">
        <header className="border-b px-6 pb-4 pt-5 pr-14">
          <DialogTitle className="truncate text-heading">Agents in {blok.name}</DialogTitle>
          <DialogDescription className="mt-0.5">
            Add or remove agents. The conversation so far stays as it is.
          </DialogDescription>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
          <div className="flex flex-col md:min-h-0 md:overflow-y-auto">
            <MemberPicker
              className="mt-5"
              agents={agents}
              picked={picked}
              onToggle={(id) => setPicked((prev) => togglePicked(prev, id))}
              lead={lead}
              onLead={setLeadId}
              modelLabel={modelLabel}
            />
          </div>
          <aside
            aria-label="The room"
            className="flex flex-col border-t bg-sidebar/50 md:min-h-0 md:border-l md:border-t-0"
          >
            <div className="flex-1 px-5 py-5 md:overflow-y-auto">
              <RoomPreview name={blok.name} chosen={answering} lead={lead} onLead={setLeadId} modelLabel={modelLabel} />
              {note && (
                <p className="mt-3 text-pretty text-small leading-relaxed text-muted-foreground" role="status">
                  {note}
                </p>
              )}
            </div>
          </aside>
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3 text-small">
          <div className="mr-auto min-w-0 text-destructive">{error}</div>
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="secondary" onClick={onClose} className="max-sm:flex-1">
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={!change || picked.length < MIN_MEMBERS || saving}
              className="min-w-[112px] max-sm:flex-1"
            >
              {saving ? "Saving…" : picked.length < MIN_MEMBERS ? `Pick ${MIN_MEMBERS - picked.length} more` : "Save"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
