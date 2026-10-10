// The security checkup, as a page of Settings.
//
// Each finding is one row: how much it wants your attention, what was
// found, one sentence on why it matters, and the way to narrow it. Most
// of the ways are links to where the setting already lives, so there is
// still one place to change each thing; the page itself only does what
// has no other home (a file's mode, a saved secret) and the one change
// that is always safe to make in a click (taking an agent off full
// access, since narrowing never needs asking twice).
//
// The findings come from the server (server/security.ts) and only on the
// computer Bloks runs on: on a phone or at bloks.dev/web the page says so
// rather than guessing.
import { useState } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import { useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/plural";
import {
  checkupApi,
  refreshCheckup,
  useSecurityCheckup,
  type CheckupFinding,
  type CheckupLevel,
  type CheckupReport,
} from "@/lib/securityCheckup";
import { SettingsGroup } from "./SettingsLayout";

const LEVEL: Record<CheckupLevel, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-success/10 text-success" },
  look: { label: "Worth a look", className: "bg-warning/15 text-warning" },
  risky: { label: "Risky", className: "bg-destructive/10 text-destructive" },
};

/** Items shown before "and N more": a workspace can have hundreds of
 * agents' keys, and the finding's summary already says how many. */
const MAX_ITEMS = 8;

function LevelPill({ level }: { level: CheckupLevel }) {
  const { label, className } = LEVEL[level];
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>
      {label}
    </span>
  );
}

function when(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${plural(minutes, "minute")} ago` : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Summary({ report, loading }: { report: CheckupReport; loading: boolean }) {
  const risky = report.findings.filter((f) => f.level === "risky").length;
  const look = report.findings.filter((f) => f.level === "look").length;
  const line = risky
    ? `${plural(risky, "risky finding")}${look ? `, and ${look} worth a look` : ""}.`
    : look
      ? `Nothing risky. ${plural(look, "finding")} worth a look.`
      : "Nothing risky, and nothing worth a look.";
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-4 py-3.5">
      {risky ? (
        <ShieldAlert size={20} className="shrink-0 text-destructive" aria-hidden />
      ) : (
        <ShieldCheck size={20} className={cn("shrink-0", look ? "text-warning" : "text-success")} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-foreground">{line}</div>
        <div className="text-[12px] text-muted-foreground">Checked {when(report.checkedAt)}. Nothing changes unless you press a button.</div>
      </div>
      <Button size="sm" variant="secondary" disabled={loading} onClick={() => void refreshCheckup()}>
        {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        Check again
      </Button>
    </div>
  );
}

function Row({ finding }: { finding: CheckupFinding }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const fix = finding.fix;

  const act = async (key: string, run: () => Promise<CheckupReport | void>) => {
    setBusy(key);
    setError(null);
    try {
      const answered = await run();
      const report = await refreshCheckup(answered ? Promise.resolve(answered) : undefined);
      if (report?.failed?.length) setError(`Could not change ${report.failed.join(", ")}. It may belong to another account.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const openAgent = (id: string) => {
    dispatch({ type: "select", id });
    dispatch({ type: "toggleSettings", open: true });
  };

  // what each item's own buttons are, by what the finding offers
  const itemActions = (item: { id: string; name: string }) => {
    if (!fix) return null;
    switch (fix.kind) {
      case "full-access":
        return (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                void act(item.id, async () => {
                  await checkupApi(`/api/bots/${item.id}`, { method: "PATCH", body: JSON.stringify({ approvals: "auto" }) });
                })
              }
            >
              {busy === item.id && <Loader2 size={12} className="animate-spin" />}
              {fix.label}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openAgent(item.id)}>
              Open
            </Button>
          </>
        );
      case "agents":
        return (
          <Button size="sm" variant="ghost" onClick={() => openAgent(item.id)}>
            {fix.label}
          </Button>
        );
      case "rooms":
        return (
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "select", id: item.id })}>
            {fix.label}
          </Button>
        );
      case "secrets":
        return forgetting === item.id ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() =>
                void act(item.id, () => checkupApi(`/api/security/secrets/${encodeURIComponent(item.id)}`, { method: "DELETE" })).then(() =>
                  setForgetting(null),
                )
              }
            >
              {busy === item.id && <Loader2 size={12} className="animate-spin" />}
              Forget {item.name}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForgetting(null)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setForgetting(item.id)}>
            {fix.label}
          </Button>
        );
      default:
        return null;
    }
  };

  // and the finding's own button, for a fix that is not per item
  const findingAction = (() => {
    if (!fix) return null;
    switch (fix.kind) {
      case "page":
        return (
          <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: fix.page })}>
            {fix.label}
          </Button>
        );
      case "automations":
        return (
          <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "toggleRoutines", open: true, tab: fix.tab })}>
            {fix.label}
            <ExternalLink size={12} aria-hidden />
          </Button>
        );
      case "permissions":
        return (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void act("permissions", () => checkupApi("/api/security/permissions", { method: "POST" }))}
          >
            {busy === "permissions" && <Loader2 size={12} className="animate-spin" />}
            {fix.label}
          </Button>
        );
      default:
        return null;
    }
  })();

  const items = finding.items ?? [];
  const perItem = fix && ["full-access", "agents", "rooms", "secrets"].includes(fix.kind);
  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-foreground">{finding.title}</span>
            <LevelPill level={finding.level} />
          </div>
          <div className="mt-1 text-pretty text-[13px] leading-relaxed text-foreground">{finding.summary}</div>
          <div className="mt-0.5 text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{finding.why}</div>
        </div>
        {findingAction && <div className="shrink-0">{findingAction}</div>}
      </div>
      {items.length > 0 && (
        <ul className="mt-2.5 flex flex-col divide-y rounded-xl border">
          {items.slice(0, MAX_ITEMS).map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <div className="min-w-0 flex-1 basis-[160px]">
                <div className={cn("truncate text-[12.5px] text-foreground", fix?.kind === "secrets" || fix?.kind === "permissions" ? "font-mono" : "font-medium")}>
                  {item.name}
                </div>
                {item.detail && <div className="truncate text-[12px] text-muted-foreground">{item.detail}</div>}
              </div>
              {perItem && <div className="flex shrink-0 items-center gap-1">{itemActions(item)}</div>}
            </li>
          ))}
          {items.length > MAX_ITEMS && (
            <li className="px-3 py-2 text-[12px] text-muted-foreground">and {items.length - MAX_ITEMS} more</li>
          )}
        </ul>
      )}
      {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

export function SecurityCheckup() {
  const { report, error, loading } = useSecurityCheckup(0);
  if (!report) {
    return (
      <SettingsGroup>
        <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-muted-foreground">
          {error ? (
            error === "not from here" ? (
              "The checkup looks at files and settings on the computer Bloks runs on, so it only opens there."
            ) : (
              <>
                <span className="min-w-0 flex-1">The checkup could not run: {error}</span>
                <Button size="sm" variant="secondary" onClick={() => void refreshCheckup()}>
                  Try again
                </Button>
              </>
            )
          ) : (
            <>
              <Loader2 size={14} className="animate-spin" />
              Checking…
            </>
          )}
        </div>
      </SettingsGroup>
    );
  }
  return (
    <>
      <Summary report={report} loading={loading} />
      <SettingsGroup>
        {report.findings.map((finding) => (
          <Row key={finding.id} finding={finding} />
        ))}
      </SettingsGroup>
    </>
  );
}
