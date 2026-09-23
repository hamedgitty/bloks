// Sharing a room with other people.
//
// Everything here is the owner's: who is invited, who is let in, what
// they can see, and when it stops. The person joining sees a four word
// check phrase on their screen and so does this panel; comparing the two
// is what makes letting someone in safe, so the phrase is the biggest
// thing on the card that asks.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import QRCode from "qrcode";
import { api, useStore, type Blok } from "@/state/store";
import type { RoomPerson, RoomSharing } from "@/state/reducer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface PendingInvite {
  id: string;
  role: "collaborator" | "viewer";
  status: "open" | "claimed";
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
  claim?: { name: string; at: number; phrase: string };
}

interface PeopleResponse {
  sharing: RoomSharing | null;
  hostName: string;
  plan: "cloud" | "team" | null;
  limits: { rooms: number | null; members: number } | null;
  people: Array<RoomPerson & { invitedBy: string }>;
  invites: PendingInvite[];
}

export function SharePanel({ blok, open, onOpenChange }: { blok: Blok; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"collaborator" | "viewer">("collaborator");
  const [link, setLink] = useState<{ url: string; qr: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const load = useCallback(() => {
    api(`/api/bloks/${blok.id}/people`)
      .then((next: PeopleResponse) => {
        setData(next);
        setName((current) => current || (next.hostName === "The owner" ? "" : next.hostName));
        // the badge on the header counts what is actually waiting
        dispatch({
          type: "joinRequest",
          roomId: blok.id,
          pending: next.invites.filter((i) => i.claim).length,
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [blok.id, dispatch]);

  // Reload whenever something about the room's people changes: a request
  // at the door, someone let in, someone leaving.
  const people = state.roomPeople[blok.id];
  const knocking = state.joinRequests[blok.id];
  useEffect(() => {
    if (open) load();
  }, [open, load, people, knocking, blok.sharing]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const share = (patch: Partial<RoomSharing> & { hostName?: string }) =>
    act("share", () => api(`/api/bloks/${blok.id}/share`, { method: "POST", body: JSON.stringify(patch) }));

  const invite = () =>
    act("invite", async () => {
      const made = await api(`/api/bloks/${blok.id}/invites`, { method: "POST", body: JSON.stringify({ role }) });
      const qr = await QRCode.toDataURL(made.link, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 168,
        color: { dark: "#111111", light: "#ffffff" },
      }).catch(() => null);
      setLink({ url: made.link, qr });
      setCopied(false);
    });

  const copy = () => {
    if (!link) return;
    void navigator.clipboard.writeText(link.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const shared = data?.sharing ?? blok.sharing ?? null;
  const waiting = data?.invites.filter((i) => i.claim) ?? [];
  const unopened = data?.invites.filter((i) => !i.claim) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-[480px] overflow-y-auto">
        <DialogTitle className="text-[15px] font-semibold">Share {blok.name}</DialogTitle>
        <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          People you invite talk to this room's agents from the Bloks app. The agents keep running on
          this computer, and anything that touches your accounts, files or computer waits for you.
        </DialogDescription>

        {error && (
          <div className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</div>
        )}

        {!data ? (
          <div className="mt-6 flex justify-center text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : !data.plan ? (
          <div className="mt-4 rounded-2xl border bg-card p-4 text-[13px] leading-relaxed text-muted-foreground">
            Sharing a room needs Bloks Cloud, which is what carries people's messages to this computer
            while they are away from it. Turn it on in Settings, under Devices, then come back here.
          </div>
        ) : !shared ? (
          <div className="mt-4 space-y-3">
            <label className="block text-[12.5px] font-medium text-foreground">
              Your name, as people in the room will see it
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="Your name"
                className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-[13.5px] outline-none focus:border-foreground/30"
              />
            </label>
            <PlanLine data={data} />
            <Button
              className="w-full"
              disabled={!name.trim() || busy === "share"}
              onClick={() => share({ hostName: name.trim() })}
            >
              {busy === "share" && <Loader2 size={14} className="animate-spin" />}
              Start sharing
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {/* who is at the door */}
            {waiting.map((inv) => (
              <div key={inv.id} className="rounded-2xl border border-brand-ink/30 bg-brand-ink/5 p-4">
                <div className="text-[13.5px] font-medium text-foreground">
                  {inv.claim!.name} wants to join as a {inv.role}
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  Check these words match what {inv.claim!.name} sees on their screen:
                </div>
                <div className="mt-2 rounded-xl bg-background px-3 py-2.5 text-center font-mono text-[17px] tracking-wide text-foreground">
                  {inv.claim!.phrase}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy !== null}
                    onClick={() => act(`in-${inv.id}`, () => api(`/api/invites/${inv.id}/approve`, { method: "POST" }))}
                  >
                    {busy === `in-${inv.id}` && <Loader2 size={14} className="animate-spin" />}
                    Let in
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => act(`out-${inv.id}`, () => api(`/api/invites/${inv.id}/decline`, { method: "POST" }))}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ))}

            {/* inviting */}
            <section>
              <SectionTitle>Invite someone</SectionTitle>
              <div className="flex gap-2">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "collaborator" | "viewer")}
                  className="rounded-lg border bg-background px-2 text-[13px]"
                  aria-label="Their role"
                >
                  <option value="collaborator">Collaborator: can talk and answer</option>
                  <option value="viewer">Viewer: can read</option>
                </select>
                <Button className="flex-1" disabled={busy === "invite"} onClick={invite}>
                  {busy === "invite" && <Loader2 size={14} className="animate-spin" />}
                  Make an invite link
                </Button>
              </div>
              {link && (
                <div className="mt-3 flex gap-3 rounded-2xl border bg-card p-3">
                  {link.qr && (
                    <div className="shrink-0 rounded-xl bg-white p-1.5">
                      <img src={link.qr} alt="Invite QR code" className="size-[112px]" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
                    Send this to one person. It works once, for 24 hours, and you still decide
                    whether they get in.
                    <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={copy}>
                      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                </div>
              )}
              {unopened.length > 0 && (
                <div className="mt-2 space-y-1">
                  {unopened.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between text-[12px] text-muted-foreground">
                      <span>
                        Invite for a {inv.role}, not opened yet
                        {inv.invitedBy !== data.hostName ? ` (from ${inv.invitedBy})` : ""}
                      </span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Cancel this invite"
                        onClick={() => act(`x-${inv.id}`, () => api(`/api/invites/${inv.id}`, { method: "DELETE" }))}
                      >
                        <X size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <PlanLine data={data} />
            </section>

            {/* who is in */}
            <section>
              <SectionTitle>In this room</SectionTitle>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-foreground">{data.hostName} (you)</span>
                  <span className="text-[12px] text-muted-foreground">Owner</span>
                </div>
                {data.people.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate text-foreground">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <select
                        value={p.role}
                        onChange={(e) =>
                          act(`role-${p.id}`, () =>
                            api(`/api/bloks/${blok.id}/people/${p.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ role: e.target.value }),
                            }),
                          )
                        }
                        className="rounded-md border bg-background px-1.5 py-0.5 text-[12px]"
                        aria-label={`${p.name}'s role`}
                      >
                        <option value="collaborator">Collaborator</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title={`Remove ${p.name}`}
                        onClick={() =>
                          act(`rm-${p.id}`, () => api(`/api/bloks/${blok.id}/people/${p.id}`, { method: "DELETE" }))
                        }
                      >
                        <X size={13} />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* how the room behaves */}
            <section>
              <SectionTitle>Room settings</SectionTitle>
              <div className="space-y-3">
                <Toggle
                  label="New people see the whole history"
                  hint="Off: they see the room from when they joined. Applies to everyone in it now."
                  checked={shared.history === "all"}
                  onChange={(on) => share({ history: on ? "all" : "join" })}
                />
                <Toggle
                  label="Collaborators can invite"
                  hint="They can make invite links. You still let every person in."
                  checked={shared.collaboratorsInvite}
                  onChange={(on) => share({ collaboratorsInvite: on })}
                />
                <Toggle
                  label="Show what agents' tools did"
                  hint="Off: people see that an agent searched or read a file, not what."
                  checked={shared.activityDetail}
                  onChange={(on) => share({ activityDetail: on })}
                />
                <Toggle
                  label="Agents can work with files in this room's folder"
                  hint="Off: agents in this room can only talk. Nothing of yours is reachable either way."
                  checked={shared.tools === "desk"}
                  onChange={(on) => share({ tools: on ? "desk" : "conversation" })}
                />
              </div>
            </section>

            <section className="border-t pt-4">
              {confirmStop ? (
                <div className="space-y-2">
                  <div className="text-[12.5px] text-muted-foreground">
                    Everyone leaves the room and their access ends now. The conversation stays with you.
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      className="flex-1"
                      disabled={busy === "stop"}
                      onClick={() =>
                        act("stop", async () => {
                          await api(`/api/bloks/${blok.id}/share`, { method: "DELETE" });
                          setConfirmStop(false);
                          setLink(null);
                        })
                      }
                    >
                      Stop sharing
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmStop(false)}>
                      Keep sharing
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" className="w-full text-destructive" onClick={() => setConfirmStop(true)}>
                  Stop sharing this room
                </Button>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[13px] text-foreground">{label}</div>
        <div className="text-[11.5px] leading-snug text-muted-foreground">{hint}</div>
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** What the plan allows, said once and plainly. */
function PlanLine({ data }: { data: PeopleResponse }) {
  if (data.plan !== "cloud" || !data.limits) return null;
  return (
    <div className="mt-2 text-[11.5px] leading-snug text-muted-foreground">
      Bloks Cloud includes one shared room with up to {data.limits.members} people. Bloks Team shares
      as many rooms as you like, with up to 10 people each.
    </div>
  );
}
