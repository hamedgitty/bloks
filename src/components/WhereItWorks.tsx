// Where an agent works: this computer, a Docker container, or another
// machine over SSH (server/workplace.ts).
//
// One card in the agent's Engine settings. This computer is the default
// and stays one click away. Picking Docker or SSH opens that place's few
// settings with sensible defaults already in, and nothing changes until
// Save: a half-typed host is not somewhere to send the next turn.
//
// The Test button is the point of the card. It goes there, the way a turn
// would, and says what it found as a short list, with anything missing
// said as one thing to do. A sign-in that is missing there is the common
// case, and the card offers the two ways out side by side: sign in there,
// which opens Terminal with the command already running, or copy this
// computer's sign-in, which asks first and says exactly which file goes
// where. Nothing is ever copied without that answer.
//
// Under a saved place, a quiet note says what working there changes:
// which of undo, rewind and rehearsals still work, and where its files go.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Check } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Copy } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { LogIn } from "@/components/icons";
import { Minus } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { placeLine, type PlaceState, type Workplace, type WorkplaceStatus } from "@/lib/workplace";
import { HealthLine, type Health } from "./ConnectionKit";
import { SettingRow, SettingsSelect } from "./SettingsLayout";
import { formatDate, t, tr, type MessageKey } from "@/lib/i18n";

interface TestCheck {
  id: string;
  ok: boolean | null;
  label: string;
}

interface Report {
  ok: boolean;
  checks: TestCheck[];
  problems: string[];
  signIn?: { command: string };
  canCopySignIn?: boolean;
}

interface View {
  workplace: Workplace | null;
  seen: { home?: string; node?: boolean; copied?: Array<{ engine: string; files: string[]; at: number }> } | null;
  status: WorkplaceStatus | null;
  engine: { name: string; driverKind: string };
  support: { ok: true } | { ok: false; why: string };
  networkOff: { ok: true } | { ok: false; why: string };
  lineHosts: string[] | null;
  localFolder: string;
  /** The same, as a person reads it: ~ for the home folder. */
  localFolderShown?: string;
  defaults: { image: string; name: string; path: string; idleMinutes: number };
  filesHere: boolean;
  running: number;
}

type Kind = "here" | "docker" | "ssh";

/** The card's fields, as typed: strings while being edited, read into a
 * place only to save or test. */
interface Draft {
  kind: Kind;
  source: "image" | "container";
  image: string;
  name: string;
  folder: "mount" | "copy";
  containerPath: string;
  cpus: string;
  memoryGb: string;
  network: boolean;
  idleMinutes: number;
  autoRemove: boolean;
  host: string;
  port: string;
  sshPath: string;
  command: string;
}

const IDLE_CHOICES: Array<[number, MessageKey]> = [
  [15, "whereItWorks.idle.15"],
  [60, "whereItWorks.idle.60"],
  [240, "whereItWorks.idle.240"],
  [0, "whereItWorks.idle.never"],
];

function draftOf(view: View, agentName: string): Draft {
  const place = view.workplace;
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const base: Draft = {
    kind: "here",
    source: "image",
    image: view.defaults.image,
    name: view.defaults.name,
    folder: "mount",
    containerPath: view.defaults.path,
    cpus: "",
    memoryGb: "",
    network: true,
    idleMinutes: view.defaults.idleMinutes,
    autoRemove: false,
    host: "",
    port: "",
    sshPath: `~/bloks/${slug}`,
    command: "",
  };
  if (!place) return base;
  if (place.kind === "ssh") return { ...base, kind: "ssh", host: place.host, port: place.port ? String(place.port) : "", sshPath: place.path, command: place.command ?? "" };
  if (place.source === "container") return { ...base, kind: "docker", source: "container", name: place.name, containerPath: place.path, command: place.command ?? "" };
  return {
    ...base,
    kind: "docker",
    source: "image",
    image: place.image,
    name: place.name,
    folder: place.folder,
    containerPath: place.path,
    cpus: place.cpus ? String(place.cpus) : "",
    memoryGb: place.memoryGb ? String(place.memoryGb) : "",
    network: place.network,
    idleMinutes: place.idleMinutes,
    autoRemove: place.autoRemove,
    command: place.command ?? "",
  };
}

/** The draft as the server reads a place. Numbers stay as typed; the
 * server says what is wrong with one. */
function placeOf(draft: Draft): Record<string, unknown> | null {
  const command = draft.command.trim() || null;
  if (draft.kind === "here") return null;
  if (draft.kind === "ssh") return { kind: "ssh", host: draft.host.trim(), port: draft.port.trim() || null, path: draft.sshPath.trim() || "~", command };
  if (draft.source === "container") return { kind: "docker", source: "container", name: draft.name.trim(), path: draft.containerPath.trim(), command };
  return {
    kind: "docker",
    source: "image",
    image: draft.image.trim(),
    name: draft.name.trim(),
    folder: draft.folder,
    path: draft.containerPath.trim(),
    cpus: draft.cpus.trim() || null,
    memoryGb: draft.memoryGb.trim() || null,
    network: draft.network,
    idleMinutes: draft.idleMinutes,
    autoRemove: draft.autoRemove,
    command,
  };
}

const TONES: Record<PlaceState, Health> = {
  idle: "off",
  starting: "wait",
  ready: "on",
  working: "on",
  stopped: "off",
  removed: "off",
  dropped: "issue",
  reconnecting: "wait",
  unreachable: "issue",
};

const STATE_WORDS: Record<PlaceState, MessageKey> = {
  idle: "whereItWorks.state.idle",
  starting: "whereItWorks.state.starting",
  ready: "whereItWorks.state.ready",
  working: "whereItWorks.state.working",
  stopped: "whereItWorks.state.stopped",
  removed: "whereItWorks.state.removed",
  dropped: "whereItWorks.state.dropped",
  reconnecting: "whereItWorks.state.reconnecting",
  unreachable: "whereItWorks.state.unreachable",
};

/** A short aside under a row, as the rest of the page has them. */
function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <div
      className={cn(
        "mt-2.5 rounded-xl px-3 py-2 text-pretty text-small leading-relaxed",
        tone === "warning" ? "bg-warning/10 text-warning" : "bg-muted/60 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** A labelled field in the place's grid. */
function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-small font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-pretty text-small text-muted-foreground">{hint}</p>}
    </div>
  );
}

const field = "h-8 font-mono text-small";

export function WhereItWorksCard({ bot }: { bot: Bot }) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hosts, setHosts] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | "save" | "test" | "copy" | "signin" | "stop" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [more, setMore] = useState(false);
  const [atServer, setAtServer] = useState(false);
  const { state } = useStore();
  const ids = useId();

  const load = useCallback(() => {
    api(`/api/bots/${bot.id}/workplace`)
      .then((next: View) => {
        setView(next);
        setDraft((current) => current ?? draftOf(next, bot.name));
      })
      .catch((e: Error & { status?: number }) => {
        // From a device (a browser, a paired app) this is refused on
        // purpose: it picks the server's own keys and machines, so it is
        // set at the server. Said as that, not as something gone wrong.
        if (e.status === 403) setAtServer(true);
        else setError(e.message);
      });
  }, [bot.id, bot.name]);

  useEffect(() => load(), [load]);
  // what the server says of the place moves with the agent's own frames
  useEffect(() => {
    setView((current) => (current ? { ...current, status: bot.workplaceStatus ?? null } : current));
  }, [bot.workplaceStatus]);

  useEffect(() => {
    if (draft?.kind !== "ssh" || hosts.length) return;
    api("/api/workplaces/ssh-hosts")
      .then((r) => setHosts(r.hosts ?? []))
      .catch(() => {});
  }, [draft?.kind, hosts.length]);

  const saved = useMemo(() => (view ? JSON.stringify(placeOf(draftOf(view, bot.name))) : ""), [view, bot.name]);
  const dirty = Boolean(draft && view && JSON.stringify(placeOf(draft)) !== saved);

  if (!view || !draft) {
    return (
      <SettingRow label={t("whereItWorks.whereItWorks")} description={t("whereItWorks.whereItsEngineRunsWith")}>
        {atServer ? (
          <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-pretty text-small leading-relaxed text-muted-foreground">
            {t("whereItWorks.setAtServer", { computer: state.config?.deployment?.computer || t("workspaceSettings.server.thisServer") })}
          </p>
        ) : error ? (
          <p className="mt-2 text-small text-destructive">{error}</p>
        ) : (
          <Loader2 size={14} className="mt-3 animate-spin text-muted-foreground" />
        )}
      </SettingRow>
    );
  }

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setReport(null);
    setError(null);
  };

  const save = () => {
    setBusy("save");
    setError(null);
    api(`/api/bots/${bot.id}/workplace`, { method: "PUT", body: JSON.stringify({ workplace: placeOf(draft) }) })
      .then((next: View) => {
        setView(next);
        setDraft(draftOf(next, bot.name));
        toast.success(next.workplace ? t("whereItWorks.savedThere") : t("whereItWorks.savedHere"));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const test = () => {
    setBusy("test");
    setError(null);
    setReport(null);
    api(`/api/bots/${bot.id}/workplace/test`, { method: "POST", body: JSON.stringify({ workplace: placeOf(draft) }) })
      .then((r: { report: Report } & View) => {
        setReport(r.report);
        setView((current) => (current ? { ...current, status: r.status, seen: r.seen } : current));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const signInThere = () => {
    setBusy("signin");
    api(`/api/bots/${bot.id}/workplace/sign-in`, { method: "POST", body: JSON.stringify({ workplace: placeOf(draft) }) })
      .then((r: { opened: boolean; command: string }) => {
        if (r.opened) toast.success(t("whereItWorks.terminalOpen"));
        else {
          void navigator.clipboard?.writeText(r.command).catch(() => {});
          toast.info(t("whereItWorks.runToSignIn", { command: r.command }), { duration: 12_000 });
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  /** Copying a sign-in: the plan first, word for word, and only a yes
   * copies it. */
  const copySignIn = async () => {
    setBusy("copy");
    setError(null);
    try {
      const asked = await api(`/api/bots/${bot.id}/workplace/sign-in-copy`);
      if (!asked.possible) {
        setError(asked.why);
        return;
      }
      const plan = asked.plan as { files: Array<{ from: string; to: string }>; says: string; fingerprint: string };
      const yes = await confirm({
        title: t("whereItWorks.copySignInTitle", { engine: view.engine.name }),
        // the plan's own words, which name each file at both ends
        body: plan.says,
        confirmLabel: t("whereItWorks.copySignIn"),
      });
      if (!yes) return;
      await api(`/api/bots/${bot.id}/workplace/sign-in-copy`, { method: "POST", body: JSON.stringify({ consent: true, fingerprint: plan.fingerprint }) });
      toast.success(t("whereItWorks.copiedTestAgain"));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const containerAct = async (verb: "stop" | "remove") => {
    if (verb === "remove") {
      const place = view.workplace;
      const lost = place?.kind === "docker" && place.source === "image" && place.folder === "copy";
      const yes = await confirm({
        title: place?.kind === "docker" ? t("whereItWorks.removeNamed", { name: place.name }) : t("whereItWorks.removeTheContainer"),
        body: lost ? t("whereItWorks.removeLosesCopy") : t("whereItWorks.removeKeepsFolder"),
        confirmLabel: t("common.remove"),
        destructive: true,
      });
      if (!yes) return;
    }
    setBusy(verb);
    setError(null);
    api(`/api/bots/${bot.id}/workplace/${verb}`, { method: "POST", body: "{}" })
      .then((next: View) => setView(next))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const status = view.status;
  const savedPlace = view.workplace;
  const off = !view.support.ok;
  const remote = draft.kind !== "here";
  const madeHere = savedPlace?.kind === "docker" && savedPlace.source === "image";

  return (
    <SettingRow
      label={t("whereItWorks.whereItWorks")}
      description={
        savedPlace
          ? savedPlace.kind === "ssh"
            ? t("whereItWorks.filesOverSsh", { host: savedPlace.host })
            : t("whereItWorks.filesInContainer", { name: savedPlace.name })
          : t("whereItWorks.itsEngineCommandsAndFiles")
      }
      control={status && savedPlace && !dirty ? <HealthLine tone={TONES[status.state]} label={t(STATE_WORDS[status.state])} title={status.detail ?? placeLine(status, false) ?? undefined} /> : null}
    >
      <Segmented<Kind>
        aria-label={t("whereItWorks.whereItWorks")}
        className="mt-3 max-w-[420px]"
        value={draft.kind}
        onChange={(kind) => set({ kind })}
        options={[
          { value: "here", label: t("whereItWorks.kind.here") },
          { value: "docker", label: "Docker", disabled: off, ...(off ? { title: (view.support as { why: string }).why } : {}) },
          { value: "ssh", label: "SSH", disabled: off, ...(off ? { title: (view.support as { why: string }).why } : {}) },
        ]}
      />
      {off && <Note>{(view.support as { why: string }).why}</Note>}

      {draft.kind === "docker" && (
        <div className="mt-4 space-y-4">
          <Segmented<"image" | "container">
            aria-label={t("whereItWorks.whichContainer")}
            size="sm"
            className="max-w-[420px]"
            value={draft.source}
            onChange={(source) => set({ source })}
            options={[
              { value: "image", label: t("whereItWorks.source.image") },
              { value: "container", label: t("whereItWorks.source.container") },
            ]}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {draft.source === "image" && (
              <Field label={t("whereItWorks.image")} htmlFor={`${ids}-image`} hint={t("whereItWorks.itNeedsTheEngineInstalled")}>
                <Input id={`${ids}-image`} className={field} value={draft.image} spellCheck={false} onChange={(e) => set({ image: e.target.value })} />
              </Field>
            )}
            <Field
              label={draft.source === "image" ? t("whereItWorks.containerName") : t("whereItWorks.container")}
              htmlFor={`${ids}-name`}
              hint={draft.source === "image" ? t("whereItWorks.bloksMakesItAndOnly") : t("whereItWorks.runningAlreadyBloksOnlyRuns")}
            >
              <Input id={`${ids}-name`} className={field} value={draft.name} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </div>

          {draft.source === "image" && (
            <div>
              <div className="mb-1 text-small font-medium text-foreground">{t("common.workingFolder")}</div>
              <Segmented<"mount" | "copy">
                aria-label={t("common.workingFolder")}
                size="sm"
                className="max-w-[420px]"
                value={draft.folder}
                onChange={(folder) => set({ folder })}
                options={[
                  { value: "mount", label: t("whereItWorks.folder.mount") },
                  { value: "copy", label: t("whereItWorks.folder.copy") },
                ]}
              />
              <p className="mt-1 text-pretty text-small text-muted-foreground">
                {tr(draft.folder === "mount" ? "whereItWorks.folder.mountNote" : "whereItWorks.folder.copyNote", {
                  folder: <span className="font-mono">{view.localFolderShown ?? view.localFolder}</span>,
                })}
              </p>
            </div>
          )}

          <Field label={t("whereItWorks.folderInTheContainer")} htmlFor={`${ids}-path`}>
            <Input id={`${ids}-path`} className={field} value={draft.containerPath} spellCheck={false} onChange={(e) => set({ containerPath: e.target.value })} />
          </Field>

          {draft.source === "image" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("whereItWorks.cpus")} htmlFor={`${ids}-cpus`}>
                  <Input id={`${ids}-cpus`} className={field} inputMode="decimal" placeholder={t("whereItWorks.noLimit")} value={draft.cpus} onChange={(e) => set({ cpus: e.target.value })} />
                </Field>
                <Field label={t("whereItWorks.memoryGb")} htmlFor={`${ids}-mem`}>
                  <Input id={`${ids}-mem`} className={field} inputMode="decimal" placeholder={t("whereItWorks.noLimit")} value={draft.memoryGb} onChange={(e) => set({ memoryGb: e.target.value })} />
                </Field>
              </div>
              <label className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-body font-medium text-foreground">{t("whereItWorks.network")}</span>
                  <span className="block text-pretty text-small text-muted-foreground">
                    {draft.network
                      ? t("whereItWorks.onItCanReachThe")
                      : view.lineHosts?.length
                        ? t("whereItWorks.networkOffWithHosts", { engine: view.engine.name, hosts: view.lineHosts.join(", ") })
                        : t("whereItWorks.networkOff")}
                  </span>
                </span>
                <Switch
                  checked={draft.network}
                  disabled={draft.network && !view.networkOff.ok}
                  onCheckedChange={(network) => set({ network })}
                  aria-label={t("whereItWorks.network")}
                />
              </label>
              {!view.networkOff.ok && <Note>{(view.networkOff as { why: string }).why}</Note>}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <Field label={t("whereItWorks.stopTheContainer")} htmlFor={`${ids}-idle`}>
                  <SettingsSelect id={`${ids}-idle`} className="w-[220px]" value={String(draft.idleMinutes)} onChange={(e) => set({ idleMinutes: Number(e.target.value) })}>
                    {IDLE_CHOICES.map(([minutes, label]) => (
                      <option key={minutes} value={minutes}>
                        {t(label)}
                      </option>
                    ))}
                  </SettingsSelect>
                </Field>
                <label className="flex items-center gap-2 pb-1 text-body text-muted-foreground">
                  {t("whereItWorks.removeInstead")}
                  <Switch checked={draft.autoRemove} disabled={draft.idleMinutes === 0} onCheckedChange={(autoRemove) => set({ autoRemove })} aria-label={t("whereItWorks.removeItInsteadOfStopping")} />
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {draft.kind === "ssh" && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_96px]">
          <Field label={t("whereItWorks.host")} htmlFor={`${ids}-host`} hint={t("whereItWorks.aHostFromSshConfig")}>
            <Input
              id={`${ids}-host`}
              className={field}
              list={`${ids}-hosts`}
              placeholder="build-box"
              value={draft.host}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set({ host: e.target.value })}
            />
            <datalist id={`${ids}-hosts`}>
              {hosts.map((host) => (
                <option key={host} value={host} />
              ))}
            </datalist>
          </Field>
          <Field label={t("whereItWorks.port")} htmlFor={`${ids}-port`}>
            <Input id={`${ids}-port`} className={field} inputMode="numeric" placeholder="22" value={draft.port} onChange={(e) => set({ port: e.target.value })} />
          </Field>
          <Field label={t("whereItWorks.folderThere")} htmlFor={`${ids}-there`} hint={t("whereItWorks.madeOnTheFirstTurn")} className="sm:col-span-2">
            <Input id={`${ids}-there`} className={field} value={draft.sshPath} spellCheck={false} onChange={(e) => set({ sshPath: e.target.value })} />
          </Field>
        </div>
      )}

      {remote && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setMore(!more)}
            aria-expanded={more}
            className="flex items-center gap-1 rounded text-small text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight size={11} className={cn("transition-transform", more && "rotate-90")} />
            {t("whereItWorks.engineCommandThere")}
          </button>
          {more && (
            <div className="mt-2 max-w-[360px]">
              <Input
                aria-label={t("whereItWorks.engineCommandThere")}
                className={field}
                placeholder={view.engine.driverKind === "claudeAgent" ? "claude" : view.engine.driverKind === "codex" ? "codex" : t("whereItWorks.itsUsualName")}
                value={draft.command}
                spellCheck={false}
                onChange={(e) => set({ command: e.target.value })}
              />
              <p className="mt-1 text-small text-muted-foreground">{t("whereItWorks.onlyWhenInstalledElsewhere", { engine: view.engine.name })}</p>
            </div>
          )}
        </div>
      )}

      {(remote || dirty) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {dirty && (
            <Button variant="brand" size="sm" disabled={busy !== null} onClick={save}>
              {busy === "save" && <Loader2 size={12} className="animate-spin" />}
              {t("common.save")}
            </Button>
          )}
          {remote && (
            <Button variant="secondary" size="sm" disabled={busy !== null || off} onClick={test}>
              {busy === "test" && <Loader2 size={12} className="animate-spin" />}
              {busy === "test" ? (draft.kind === "docker" ? t("whereItWorks.testingAFirstImageCan") : t("whereItWorks.testing")) : t("whereItWorks.test")}
            </Button>
          )}
          {!dirty && madeHere && status && (status.state === "ready" || status.state === "idle") && (
            <Button variant="ghost" size="sm" disabled={busy !== null || view.running > 0} onClick={() => void containerAct("stop")}>
              {busy === "stop" && <Loader2 size={12} className="animate-spin" />}
              {t("whereItWorks.stopContainer")}
            </Button>
          )}
          {!dirty && madeHere && (
            <Button variant="ghost" size="sm" disabled={busy !== null || view.running > 0} onClick={() => void containerAct("remove")}>
              {busy === "remove" && <Loader2 size={12} className="animate-spin" />}
              {t("whereItWorks.removeContainer")}
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-pretty text-small text-destructive">
          {error}
        </p>
      )}

      {report && (
        <div className="mt-3 rounded-xl border bg-background p-3" aria-live="polite">
          <ul className="space-y-1">
            {report.checks.map((check) => (
              <li key={check.id + check.label} className="flex items-start gap-2 text-body">
                <span className="mt-[3px] shrink-0">
                  {check.ok === true ? (
                    <Check size={13} className="text-success" aria-label={t("whereItWorks.fine")} />
                  ) : check.ok === false ? (
                    <X size={13} className="text-destructive" aria-label={t("whereItWorks.missing")} />
                  ) : (
                    <Minus size={13} className="text-muted-foreground" aria-label={t("whereItWorks.notChecked")} />
                  )}
                </span>
                <span className={cn("min-w-0", check.ok === false ? "text-foreground" : "text-muted-foreground")}>{check.label}</span>
              </li>
            ))}
          </ul>
          {report.problems.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t pt-3">
              {report.problems.map((problem) => (
                <p key={problem} className="text-pretty text-small leading-relaxed text-foreground">
                  {problem}
                </p>
              ))}
            </div>
          )}
          {report.ok && report.problems.length === 0 && <p className="mt-2 text-small text-success">{dirty ? t("whereItWorks.readySaveToSend") : t("whereItWorks.ready")}</p>}
          {(report.signIn || report.canCopySignIn) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {report.signIn && (
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={signInThere}>
                  <LogIn size={12} />
                  {t("whereItWorks.signInThere")}
                </Button>
              )}
              {report.canCopySignIn && (
                <Button variant="outline" size="sm" disabled={busy !== null || dirty} title={dirty ? t("whereItWorks.saveFirst") : undefined} onClick={() => void copySignIn()}>
                  {busy === "copy" ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
                  {t("whereItWorks.copyMySignIn")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {savedPlace && !dirty && (
        <Note>
          {[
            view.filesHere ? t("whereItWorks.note.undoWorks") : t("whereItWorks.note.undoOff"),
            t("whereItWorks.note.rehearsalsOff"),
            view.seen?.node === false ? t("whereItWorks.note.outboxNoNode") : t("whereItWorks.note.outbox"),
            t("whereItWorks.note.terminal"),
            ...(view.seen?.copied?.length ? [t("whereItWorks.note.signInCopied", { date: formatDate(view.seen.copied.at(-1)!.at) })] : []),
          ].join(" ")}
        </Note>
      )}
    </SettingRow>
  );
}
