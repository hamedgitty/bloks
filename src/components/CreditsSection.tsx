// Bloks AI, on the Plan page.
//
// A monthly allowance on the licence, with top-ups, that pays for model
// use, so an agent can run with no sign-in and no API key of its own.
// The Plan page shows how much of the month is used, the way the service
// says it, beside the rest of what the plan includes, with Top up there
// sending the person to bloks.dev in their browser (never a purchase in
// here). This file reads it (useBloksAi) and holds the choices that are
// theirs in a group of their own (BloksAiSettings): whether work nobody
// asked for this minute may use it, and on a team, how much of it each
// teammate may use in a day.
//
// The shares are the service's. Nothing here prices them, converts them,
// or names a model: Bloks AI is the only name it has.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api, useStore } from "@/state/store";
import { memberRows, parseCap, type BloksAiStatus, type MemberRow } from "@/lib/credits";
import { SecretField } from "./ConnectionKit";
import { SettingRow, SettingsGroup } from "./SettingsLayout";
import { TeamSignInNotice } from "./TeamSignInNotice";

const CLOUD_KEY = /^blok_live_[0-9a-f]{32}$/;

/** GET /api/credits, as the server says it. */
export type CreditsStatus = BloksAiStatus;

/** Bloks AI as this workspace's server says it, and the choices on it. */
export function useBloksAi() {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<CreditsStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the stream says when a run was refused or more was added
  const refusedAt = state.config?.credits?.refused?.at ?? null;

  const load = useCallback((fresh = false) => {
    api(`/api/credits${fresh ? "?fresh=1" : ""}`)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load, refusedAt]);

  // Back from bloks.dev in the browser: look again rather than make
  // anybody press a refresh they would have to know about.
  useEffect(() => {
    const look = () => load(true);
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [load]);

  const connect = (key: string) => {
    const trimmed = key.trim();
    if (busy || !CLOUD_KEY.test(trimmed)) return Promise.resolve(false);
    setBusy(true);
    setError(null);
    return api("/api/credits/connect", { method: "POST", body: JSON.stringify({ key: trimmed }) })
      .then((next) => {
        setStatus(next);
        return true;
      })
      .catch((e: Error) => {
        setError(e.message);
        return false;
      })
      .finally(() => setBusy(false));
  };

  const setBackground = (background: boolean) => {
    setBusy(true);
    setError(null);
    api("/api/credits", { method: "PATCH", body: JSON.stringify({ background }) })
      .then((next: CreditsStatus) => {
        setStatus(next);
        if (state.config) {
          dispatch({
            type: "credits",
            credits: { offered: next.offered, background: next.background, refused: next.refused, checkoutUrl: next.checkoutUrl, team: next.team },
          });
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const setCap = (member: string, cap: number | null) =>
    api("/api/credits", { method: "PATCH", body: JSON.stringify({ memberCaps: { [member]: cap } }) }).then((next: CreditsStatus) => {
      setStatus(next);
      toast.success(cap === null ? "Daily cap removed" : "Daily cap saved");
    });

  return { status, loaded, busy, error, load, connect, setBackground, setCap };
}

export type BloksAi = ReturnType<typeof useBloksAi>;

/** The choices that are the person's: connecting a key on a machine that
 * activated Cloud before Bloks AI existed, background work, and a team's
 * daily caps. */
export function BloksAiSettings({ ai, canConnect = true }: { ai: BloksAi; canConnect?: boolean }) {
  const [key, setKey] = useState("");
  const status = ai.status;
  if (!status || !status.offered) return <TeamSignInNotice className="mb-9" />;
  const rows = status.team !== false ? memberRows(status.members) : [];
  const connect = () => void ai.connect(key).then((ok) => ok && setKey(""));

  return (
    <>
      {status.teamSignInWarning && <TeamSignInNotice className="mb-6" />}
      <SettingsGroup title="Bloks AI" footnote={status.fromEnvironment ? "This machine came with its own Bloks AI token." : undefined}>
        {canConnect && status.needsKey && (
          <SettingRow label="Connect Bloks AI" description="The same key you activated Cloud with." rowId="connect-bloks-ai" error={ai.error}>
            <div className="mt-3 flex items-start gap-2">
              <SecretField
                id="credits-key"
                label="Bloks key"
                quietLabel
                value={key}
                onChange={(value) => setKey(value)}
                shape={CLOUD_KEY}
                hint="Starts with blok_live_. It's in your confirmation email."
                placeholder="blok_live_..."
                onEnter={connect}
                className="min-w-0 flex-1"
              />
              <Button size="sm" variant="brand" className="h-8" disabled={ai.busy || !CLOUD_KEY.test(key.trim())} onClick={connect}>
                {ai.busy ? <Loader2 size={13} className="animate-spin" /> : "Connect"}
              </Button>
            </div>
          </SettingRow>
        )}
        <SettingRow
          label="Let background work use Bloks AI"
          info="The nightly memory tidy, skill suggestions and quiet compaction of idle conversations run without anybody asking at that moment. Off, they skip agents on Bloks AI."
          description="Off unless you turn it on. Work you ask for always can."
          error={status.needsKey ? null : ai.error}
          control={<Switch aria-label="Let background work use Bloks AI" checked={status.background} disabled={ai.busy} onCheckedChange={ai.setBackground} />}
        />
      </SettingsGroup>
      {rows.length > 0 && (
        <SettingsGroup title="Your team this month" footnote="A daily cap is a share of the month one person may use in a day. Empty is no cap.">
          {rows.map((row) => (
            <MemberCapRow key={row.member} row={row} onSave={ai.setCap} />
          ))}
        </SettingsGroup>
      )}
    </>
  );
}

/** One teammate: what they used this month, and a daily cap the owner
 * can set as a share of the monthly allowance. Empty is no cap. */
function MemberCapRow({ row, onSave }: { row: MemberRow; onSave: (member: string, cap: number | null) => Promise<void> }) {
  const [text, setText] = useState(row.capPercent === null ? "" : String(row.capPercent));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(row.capPercent === null ? "" : String(row.capPercent)), [row.capPercent]);
  const cap = parseCap(text);
  const changed = cap !== undefined && cap !== row.capPercent;

  const save = () => {
    if (!changed || saving) return;
    setSaving(true);
    setProblem(null);
    onSave(row.member, cap)
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setSaving(false));
  };

  const id = `cap-${row.member}`;
  return (
    <SettingRow
      label={row.name}
      description={`${row.used}. ${row.cap}.`}
      htmlFor={id}
      error={cap === undefined ? "A cap is a percent above 0 and at most 100." : problem}
      control={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Input
              id={id}
              inputMode="decimal"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="No cap"
              aria-label={`Daily cap for ${row.name}, as a percent of the month`}
              aria-invalid={cap === undefined}
              className="h-8 w-24 pr-7 tabular-nums"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-small text-muted-foreground">%</span>
          </div>
          <Button size="sm" variant="secondary" className="h-8" disabled={!changed || saving} onClick={save}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : "Save"}
          </Button>
        </div>
      }
    />
  );
}
