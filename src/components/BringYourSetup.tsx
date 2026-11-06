// Bring your setup: what the person's other agent tools already know,
// offered item by item (server/setup-import.ts).
//
// A review, not a wizard. Everything found is on one list, grouped by what
// it becomes here, with a preview and where it would go. The person ticks
// what they want, settles any name that is already taken, and fills in
// the values a server or a chat app needs; only that is written. The
// server reads the files again on import and takes from here only those
// decisions, so nothing on this screen can change what gets imported.
//
// A value is never shown here, only its name. Each one is typed in, or
// copied from the other tool's config by ticking that one value's box.
//
// Used twice: as its own page in Settings, and as an optional step in the
// first-run flow when something was found. The step is the same list,
// with the way on left to the flow.
//
// What is read is the computer the workspace runs on, which is not always
// the one this window is on: the desktop app can be a window onto a
// server elsewhere (GitHub 397). So the screen asks which computer that
// is first, and names it whenever it is not this one. The one thing that
// travels from this window is a transfer file the person picks, sent to
// that computer to be read there like the folders are.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive } from "@/components/icons";
import { Bot } from "@/components/icons";
import { Brain } from "@/components/icons";
import { CalendarClock } from "@/components/icons";
import { Check } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Cpu } from "@/components/icons";
import { FileText } from "@/components/icons";
import { FolderOpen } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Lock } from "@/components/icons";
import { MessagesSquare } from "@/components/icons";
import { Scale } from "@/components/icons";
import { Server } from "@/components/icons";
import { ShieldCheck } from "@/components/icons";
import { Sparkles } from "@/components/icons";
import { Undo2 } from "@/components/icons";
import { Upload } from "@/components/icons";
import { UserRound } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { formatBytes, sendInParts } from "@/lib/attachments";
import { cn } from "@/lib/cn";
import {
  choicesFrom,
  conflictLine,
  groupReview,
  landingLine,
  missingSecrets,
  ownerMissing,
  pickFor,
  type Choice,
  type SetupDestination as Destination,
  type SetupItem,
  type SetupKind as Kind,
  type SetupReview,
  type SetupRun,
  type SetupSource,
  type SetupTransfer,
} from "@/lib/setupReview";
import { thisComputer } from "@/lib/thisComputer";
import { formatDate, formatList, t, tr, type MessageKey } from "@/lib/i18n";

export type { SetupItem, SetupReview, SetupSource } from "@/lib/setupReview";

interface Result {
  key: string;
  ok: boolean;
  did?: "added" | "updated" | "unchanged";
  note?: string;
  error?: string;
}

/** The computer a setup is read from: the one the workspace runs on, by
 * its name, and whether that is the computer this window is on. */
export interface SetupWhere {
  computer: string;
  here: boolean;
}

/** A workspace server from before 3.0.14 has no `where`, and brings a
 * setup over only for a window on its own computer. */
const OLDER_SERVER: MessageKey = "bringYourSetup.olderServer";

/** The review, looked up once and again on demand. Null while looking. */
export function useSetupReview(): {
  review: SetupReview | null;
  where: SetupWhere | null;
  error: string | null;
  reload: () => void;
  set: (r: SetupReview) => void;
} {
  const [review, setReview] = useState<SetupReview | null>(null);
  const [where, setWhere] = useState<SetupWhere | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    void (async () => {
      // which computer first, so the screen can say so before it reads
      let older = false;
      try {
        setWhere((await api("/api/setup-import/where")) as SetupWhere);
      } catch (e) {
        older = (e as { status?: number }).status === 404;
      }
      try {
        setReview((await api("/api/setup-import")) as SetupReview);
      } catch (e) {
        setError(older && (e as { status?: number }).status === 403 ? t(OLDER_SERVER) : (e as Error).message);
        setReview({ sources: [], fresh: 0 });
      }
    })();
  }, []);
  useEffect(reload, [reload]);
  return { review, where, error, reload, set: setReview };
}

/** The folders each tool keeps its setup in, as the person would copy
 * them (server/setup-import.ts reads these and nothing else). */
const SETUP_FOLDERS = "~/.claude, ~/.codex, ~/.cursor, ~/.openclaw, ~/.hermes or ~/OpenBot";

/** The largest transfer file the server takes (MAX_TRANSFER_BYTES in
 * server/setup-import.ts), said before anything is sent. */
const TRANSFER_MAX_BYTES = 256 * 1024 * 1024;

const KIND: Record<Kind, { label: MessageKey; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  agent: { label: "common.agent", icon: Bot },
  instructions: { label: "common.instructions", icon: FileText },
  memory: { label: "common.memory", icon: Brain },
  skill: { label: "bringYourSetup.kind.skill", icon: Sparkles },
  mcp: { label: "bringYourSetup.kind.mcp", icon: Server },
  setting: { label: "bringYourSetup.kind.setting", icon: Cpu },
  rule: { label: "bringYourSetup.kind.rule", icon: Scale },
  fact: { label: "bringYourSetup.kind.fact", icon: UserRound },
  channel: { label: "bringYourSetup.kind.channel", icon: MessagesSquare },
  files: { label: "bringYourSetup.kind.files", icon: FolderOpen },
  routine: { label: "bringYourSetup.kind.routine", icon: CalendarClock },
};

/**
 * The line every version of this screen opens with. On the workspace's
 * own computer, that nothing leaves it. Anywhere else, which computer is
 * read, that this one is not, and the way to bring this one's setup
 * instead, said before anything is looked at rather than after. Until the
 * server has said which it is, only what is true either way.
 */
export function SetupPrivacyLine({ where, className }: { where: SetupWhere | null; className?: string }) {
  const away = where && !where.here;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl bg-success/10 px-3 py-2.5", className)}>
      <ShieldCheck size={16} className="mt-px shrink-0 text-success" />
      <div className="min-w-0 text-body leading-relaxed">
        {away ? (
          <>
            <div className="font-medium text-foreground">
              {t("bringYourSetup.away.readOn", { computer: where.computer })}
            </div>
            <div className="text-muted-foreground">
              {t("bringYourSetup.away.nothingReadHere", { here: thisComputer(), computer: where.computer })}
            </div>
            <div className="mt-1.5 text-muted-foreground">
              {t("bringYourSetup.away.toBringFromHere", { here: thisComputer(), folders: SETUP_FOLDERS, computer: where.computer })}
            </div>
          </>
        ) : (
          <>
            <div className="font-medium text-foreground">
              {/* only said once the server has said it is this computer */}
              {where?.here
                ? t("bringYourSetup.nothingLeaves", { here: thisComputer() })
                : t("bringYourSetup.noKeyOrPasswordIs")}
            </div>
            <div className="text-muted-foreground">{t("bringYourSetup.nothingIsAddedUntilYou")}</div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: SetupItem["status"] }) {
  if (status === "imported") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
        <Check size={11} /> {t("bringYourSetup.broughtOver")}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-caption font-medium",
        status === "new" ? "bg-brand-soft text-brand-ink" : "bg-warning/10 text-warning",
      )}
    >
      {status === "new" ? t("common.new") : t("bringYourSetup.changed")}
    </span>
  );
}

/** Which agent, or a new one named after where this came from. A part of
 * an agent that came with it is offered that agent first, as whatever it
 * becomes here, in place of a new one. */
function AgentPicker({
  value,
  agentName,
  owner,
  onChange,
  label,
}: {
  value: string | undefined;
  agentName: string;
  owner?: SetupItem["owner"];
  onChange: (botId: string) => void;
  label: string;
}) {
  const { state } = useStore();
  const agents = state.bots.filter((b) => !b.archivedAt);
  return (
    <select
      aria-label={label}
      value={value ?? (owner ? "owner" : "new")}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 min-w-0 max-w-full rounded-md border bg-background px-2 text-body text-foreground"
    >
      {owner ? (
        <option value="owner">{t("bringYourSetup.ownerAgent", { name: owner.name })}</option>
      ) : (
        <option value="new">{t("bringYourSetup.newAgent", { name: agentName })}</option>
      )}
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

function WhereItGoes({ item, source, choice, onChange }: { item: SetupItem; source: SetupSource; choice: Choice; onChange: (next: Choice) => void }) {
  if (item.kind === "files" || item.kind === "routine") {
    const picker = (
      <AgentPicker
        value={choice.botId}
        agentName={source.agentName}
        owner={item.owner}
        label={t("bringYourSetup.whichAgentGoesTo", { item: item.title })}
        onChange={(botId) => onChange({ ...choice, botId })}
      />
    );
    return (
      <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
        {item.kind === "files" ? tr("bringYourSetup.filesForAgent", { agent: picker }) : tr("bringYourSetup.routineForAgent", { agent: picker })}
      </div>
    );
  }
  if (item.kind === "instructions" || item.kind === "memory") {
    const picker = (
      <AgentPicker
        value={choice.botId}
        agentName={source.agentName}
        owner={item.owner}
        label={t("bringYourSetup.whichAgentGoesTo", { item: item.title })}
        onChange={(botId) => onChange({ ...choice, botId })}
      />
    );
    // the words sit between the controls as the sentence orders them, so
    // they are the row's own text, in its small muted type
    return (
      <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
        {item.destinations.length > 1
          ? tr("bringYourSetup.whereForAgent", {
              where: (
                <Segmented
                  size="sm"
                  aria-label={t("bringYourSetup.whereItemGoes", { item: item.title })}
                  value={choice.to}
                  onChange={(to) => onChange({ ...choice, to })}
                  options={[
                    { value: "brief" as Destination, label: t("common.instructions") },
                    { value: "memory" as Destination, label: t("common.memory") },
                  ]}
                  className="w-auto"
                />
              ),
              agent: picker,
            })
          : tr("bringYourSetup.memoryOfAgent", { agent: picker })}
      </div>
    );
  }
  if (item.kind === "setting" || (item.kind === "channel" && item.channel?.perAgent)) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-small text-muted-foreground">
        {item.kind === "setting"
          ? tr("bringYourSetup.onEngineForAgent", {
              engine: item.setting?.engineName ?? t("bringYourSetup.itsEngine"),
              agent: (
                <AgentPicker
                  value={choice.botId}
                  agentName={source.agentName}
                  label={t("bringYourSetup.whichAgentRunsOn", { item: item.title })}
                  onChange={(botId) => onChange({ ...choice, botId })}
                />
              ),
            })
          : tr("bringYourSetup.answersAsAgent", {
              agent: (
                <AgentPicker
                  value={choice.botId}
                  agentName={source.agentName}
                  label={t("bringYourSetup.whichAgentAnswersAs", { item: item.title })}
                  onChange={(botId) => onChange({ ...choice, botId })}
                />
              ),
            })}
      </div>
    );
  }
  const line = landingLine(item);
  return line ? <div className="text-small leading-relaxed text-muted-foreground">{line}</div> : null;
}

/** A name already taken here: keep both, or write over the other. */
function ConflictChoice({ item, choice, onChange }: { item: SetupItem; choice: Choice; onChange: (next: Choice) => void }) {
  const c = item.conflict!;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-2">
      <span className="text-small text-foreground">{conflictLine(item)}</span>
      {c.canReplace ? (
        <Segmented
          size="sm"
          aria-label={t("bringYourSetup.whatToDoAbout", { name: c.name })}
          value={choice.conflict ?? "both"}
          onChange={(conflict) => onChange({ ...choice, conflict })}
          options={[
            { value: "both" as const, label: t("bringYourSetup.keepBoth") },
            { value: "replace" as const, label: c.kind === "agent" ? t("bringYourSetup.updateIt") : t("bringYourSetup.replaceIt") },
          ]}
          className="w-auto"
        />
      ) : (
        <span className="text-small text-muted-foreground">{t("bringYourSetup.thisOneIsAddedBeside")}</span>
      )}
    </div>
  );
}

/**
 * The values an item needs. Each is empty unless the person types one,
 * or ticks the box to copy the one the other tool's config holds, which
 * is offered only when there is one and is never ticked for them.
 */
function SecretFields({ item, choice, onChange }: { item: SetupItem; choice: Choice; onChange: (next: Choice) => void }) {
  const slots = item.secrets ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/60 px-2.5 py-2.5">
      <div className="flex items-center gap-1.5 text-small font-medium text-foreground">
        <Lock size={12} className="text-muted-foreground" />
        {slots.some((s) => s.required) ? t("bringYourSetup.needs") : t("bringYourSetup.valuesItUses")}
      </div>
      {slots.map((slot) => {
        const copying = Boolean(choice.copy?.[slot.id]);
        const fieldId = `secret-${item.key}-${slot.id}`;
        return (
          <div key={slot.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={fieldId} className="w-full font-mono text-caption text-foreground/80 sm:w-[38%] sm:truncate">
                {slot.name}
                {slot.required && <span className="text-muted-foreground"> {t("bringYourSetup.required")}</span>}
              </label>
              <Input
                id={fieldId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={copying}
                value={copying ? "" : (choice.typed?.[slot.id] ?? "")}
                onChange={(e) => onChange({ ...choice, typed: { ...choice.typed, [slot.id]: e.target.value } })}
                placeholder={copying ? t("bringYourSetup.copiedOnImport") : slot.required ? t("bringYourSetup.pasteItHere") : t("bringYourSetup.pasteItOrLeaveIt")}
                className="h-8 min-w-0 flex-1 rounded-lg font-mono text-body"
              />
            </div>
            {slot.copyFrom && (
              <label className="flex cursor-pointer items-center gap-2 text-small text-muted-foreground sm:pl-[calc(38%+0.5rem)]">
                <input
                  type="checkbox"
                  checked={copying}
                  onChange={(e) => onChange({ ...choice, copy: { ...choice.copy, [slot.id]: e.target.checked } })}
                  className="size-3.5 shrink-0 accent-(--brand)"
                />
                <span>{tr("bringYourSetup.copyTheOneIn", { file: <span className="font-mono text-caption">{slot.copyFrom}</span> })}</span>
              </label>
            )}
            {!slot.copyFrom && slot.ref && (
              <div className="text-caption text-muted-foreground sm:pl-[calc(38%+0.5rem)]">
                {tr("bringYourSetup.readFromShell", { ref: <span className="font-mono">${slot.ref}</span> })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  source,
  choice,
  result,
  ownerGone,
  onChange,
}: {
  item: SetupItem;
  source: SetupSource;
  choice: Choice;
  result?: Result;
  /** The agent this part goes with, when it is not coming over. */
  ownerGone?: string | null;
  onChange: (next: Choice) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = KIND[item.kind];
  const Icon = meta.icon;
  const id = `setup-${item.key}`;
  // a fact's preview is its title, and a rule's is its summary: nothing more to show
  const hasPreview = item.kind !== "fact" && item.kind !== "rule";
  const missing = choice.on ? missingSecrets(item, choice) : [];
  // a part of an agent says whose it is; the rest say what and from where
  const origin = item.owner
    ? t("bringYourSetup.ownerFromSource", { name: item.owner.name, source: source.name })
    : item.kind === "instructions" || item.kind === "memory"
      ? t("bringYourSetup.kindFromSource", { kind: t(meta.label), source: source.name })
      : source.name;
  return (
    <li className={cn("flex gap-3 px-3.5 py-3 transition-colors duration-150", choice.on && "bg-brand-soft/30")}>
      <input
        id={id}
        type="checkbox"
        checked={choice.on}
        onChange={(e) => onChange({ ...choice, on: e.target.checked })}
        className="mt-[3px] size-4 shrink-0 accent-(--brand)"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="flex min-w-0 cursor-pointer items-center gap-1.5">
            {item.kind === "agent" && item.agent?.photo ? (
              // the face it brings, as an agent's photo looks everywhere
              // else (AgentAvatar), asked for by the item and never a path
              <img
                src={`/api/setup-import/avatar?key=${encodeURIComponent(item.key)}&v=${item.agent.photo}`}
                width={16}
                height={16}
                draggable={false}
                alt=""
                className="size-4 shrink-0 rounded-full object-cover"
              />
            ) : (
              <Icon size={14} className="shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate text-ui font-medium text-foreground">{item.title}</span>
          </label>
          <span className="text-small text-muted-foreground">{origin}</span>
          <StatusChip status={item.status} />
        </div>
        {item.kind === "skill" && item.skill?.description && (
          <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">{item.skill.description}</div>
        )}
        {item.kind === "agent" && item.agent?.title && <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">{item.agent.title}</div>}
        {item.kind === "files" && item.files && (
          <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
            {t("bringYourSetup.filesSummary", { count: item.files.count, size: formatBytes(item.files.bytes) })}
          </div>
        )}
        {item.kind === "routine" && item.routine && (
          <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">{item.routine.summary}</div>
        )}
        <div className="mt-0.5 truncate font-mono text-caption text-muted-foreground/80">{item.from}</div>
        {item.sameAs && <div className="mt-1 text-small text-muted-foreground">{t("bringYourSetup.sameAs", { name: item.sameAs })}</div>}
        <div className="mt-2 flex flex-col gap-2">
          <WhereItGoes item={item} source={source} choice={choice} onChange={onChange} />
          {choice.on && item.conflict && <ConflictChoice item={item} choice={choice} onChange={onChange} />}
          {choice.on && (item.secrets?.length ?? 0) > 0 && <SecretFields item={item} choice={choice} onChange={onChange} />}
          {missing.length > 0 && (
            <div className="text-small text-warning">
              {t("bringYourSetup.needsItsValues", { values: formatList(missing.map((s) => s.name.toLowerCase())) })}
            </div>
          )}
          {ownerGone && <div className="text-small text-warning">{t("bringYourSetup.ownerMissing", { name: ownerGone })}</div>}
        </div>
        {item.notes.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {item.notes.map((note) => (
              // A rule's note says how it differs from the original, which
              // is worth reading before ticking it; the rest are just facts.
              <li key={note} className={cn("text-small leading-relaxed", item.kind === "rule" ? "text-warning" : "text-muted-foreground")}>
                {note}
              </li>
            ))}
          </ul>
        )}
        {hasPreview && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 flex items-center gap-1 rounded-md text-small text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight size={12} className={cn("transition-transform duration-150", open && "rotate-90")} />
            {open ? t("bringYourSetup.hidePreview") : t("common.preview")}
          </button>
        )}
        {open && (
          <pre className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/60 p-2.5 font-mono text-small leading-relaxed text-foreground">
            {item.preview}
          </pre>
        )}
        {result && (
          <div className={cn("mt-1.5 text-small", result.ok ? "text-success" : "text-destructive")} aria-live="polite">
            {result.ok
              ? // the note is the server's, as it words it
                `${result.did === "unchanged" ? t("bringYourSetup.result.alreadyHere") : result.did === "updated" ? t("bringYourSetup.result.updated") : t("bringYourSetup.result.broughtOver")}${result.note ? ` ${result.note}` : ""}`
              : t("bringYourSetup.result.notBroughtOver", { error: result.error ?? "" })}
          </div>
        )}
      </div>
    </li>
  );
}

function when(at: number): string {
  return formatDate(at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Picking an OpenBot transfer file, or the one being read and the way to
 * stop reading it. The file goes to the computer the workspace runs on a
 * part at a time, as an attachment does, so it works the same from the
 * desktop app, a window paired to another computer, and a browser on a
 * server with no screen; that computer judges it and says why when it
 * will not read it.
 */
function TransferChooser({
  transfer,
  onReview,
  quiet = false,
}: {
  transfer: SetupTransfer | null | undefined;
  onReview: (next: SetupReview) => void;
  /** The one line offered where OpenBot was not found. */
  quiet?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"sending" | "removing" | null>(null);
  const [sent, setSent] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async (file: File) => {
    setProblem(null);
    if (!/\.zip$/i.test(file.name)) return setProblem(t("bringYourSetup.openbot.notAZip"));
    if (file.size > TRANSFER_MAX_BYTES) return setProblem(t("bringYourSetup.openbot.tooBig", { max: formatBytes(TRANSFER_MAX_BYTES) }));
    setBusy("sending");
    setSent(0);
    try {
      const out = await sendInParts<{ review: SetupReview }>(file, {
        partBytes: 384 * 1024,
        base: "/api/setup-import/transfer/uploads",
        onPart: (done, parts) => setSent(Math.round((done / Math.max(parts, 1)) * 100)),
      });
      onReview(out.review);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t("bringYourSetup.somethingWentWrong"));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setProblem(null);
    setBusy("removing");
    try {
      const out: { review: SetupReview } = await api("/api/setup-import/transfer", { method: "DELETE" });
      onReview(out.review);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t("bringYourSetup.somethingWentWrong"));
    } finally {
      setBusy(null);
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept=".zip,application/zip"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void send(file);
      }}
    />
  );
  const choose = (label: string, variant: "secondary" | "ghost" = "secondary") => (
    <Button size="sm" variant={variant} disabled={busy !== null} onClick={() => input.current?.click()}>
      {busy === "sending" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
      {busy === "sending" ? t("bringYourSetup.openbot.sending", { percent: sent }) : label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {picker}
      {transfer ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small text-muted-foreground">
          <Archive size={13} className="shrink-0" />
          <span className="min-w-0 max-w-full truncate font-mono text-caption text-foreground/80">{transfer.name}</span>
          <span>{formatBytes(transfer.bytes)}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {choose(t("bringYourSetup.openbot.chooseAnother"))}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "removing" && <Loader2 size={13} className="animate-spin" />}
              {t("bringYourSetup.openbot.remove")}
            </Button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small leading-relaxed text-muted-foreground">
          <span>{quiet ? t("bringYourSetup.openbot.haveTransfer") : t("bringYourSetup.openbot.transferHint")}</span>
          {choose(quiet ? t("bringYourSetup.openbot.chooseIt") : t("bringYourSetup.openbot.choose"), quiet ? "ghost" : "secondary")}
        </div>
      )}
      {problem && (
        <div className="text-small text-destructive" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
}

/**
 * OpenBot, said once above its items: what it brings, the transfer file
 * that brings more, and in one quiet line what stays behind and why.
 */
function OpenBotSource({ review, onReview }: { review: SetupReview; onReview: (next: SetupReview) => void }) {
  return (
    <section aria-label={t("bringYourSetup.openbot.name")} className="flex flex-col gap-2 rounded-2xl border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-ui font-semibold text-foreground">{t("bringYourSetup.openbot.name")}</h2>
        <span className="text-small text-muted-foreground">{t("bringYourSetup.openbot.hint")}</span>
      </div>
      <TransferChooser transfer={review.transfer} onReview={onReview} />
      <div className="flex items-start gap-1.5 text-small leading-relaxed text-muted-foreground">
        <Lock size={12} className="mt-[3px] shrink-0" />
        <span>{t("bringYourSetup.openbot.stays")}</span>
      </div>
    </section>
  );
}

/**
 * The way back from an import: one button, and afterwards what went back
 * and what stayed because it had changed since.
 */
function UndoImport({
  run,
  onReview,
  onUndone,
  lead,
}: {
  run: SetupRun;
  onReview: (next: SetupReview) => void;
  /** The list's own word on each item is about the import, so it goes. */
  onUndone?: () => void;
  lead: string;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ undone: number; kept: Array<{ title: string; why: string }> } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const out: { undone: Array<{ title: string }>; kept: Array<{ title: string; why: string }>; review: SetupReview } = await api("/api/setup-import/undo", {
        method: "POST",
        body: JSON.stringify({ runId: run.id }),
      });
      setDone({ undone: out.undone.length, kept: out.kept });
      onUndone?.();
      onReview(out.review);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t("bringYourSetup.couldNotUndo"));
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <div className="flex flex-col gap-1 text-body text-foreground" aria-live="polite">
        <div>{done.undone ? t("bringYourSetup.tookBack", { count: done.undone }) : t("bringYourSetup.nothingNeededTakingBack")}</div>
        {done.kept.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {done.kept.map((k) => (
              <li key={`${k.title}:${k.why}`} className="text-small leading-relaxed text-muted-foreground">
                {t("bringYourSetup.keptWhy", { title: k.title, why: k.why })}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
      <span>{lead}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void undo()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
        {busy ? t("bringYourSetup.undoing") : t("bringYourSetup.undo")}
      </Button>
      {problem && <span className="text-small text-destructive">{problem}</span>}
    </div>
  );
}

/**
 * The review list and the button that imports what is ticked.
 *
 * `compact` is the first-run version: the sources are not explained at
 * length, the page itself scrolls rather than a box inside it, and the
 * parent owns the way out.
 */
export function SetupReviewList({
  review,
  onReview,
  compact = false,
  onImported,
}: {
  review: SetupReview;
  onReview: (next: SetupReview) => void;
  compact?: boolean;
  onImported?: (outcome: { brought: number; created: number }) => void;
}) {
  const { dispatch } = useStore();
  const [choices, setChoices] = useState<Record<string, Choice>>(() => choicesFrom(review));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // what the import did, as counts, so the line is worded when it draws
  const [summary, setSummary] = useState<{ brought: number; created: number; failed: number } | null>(null);
  const [run, setRun] = useState<SetupRun | null>(null);
  const [undone, setUndone] = useState(false);

  // A new review (after an import, or a look again) starts from its own
  // ticks. Values typed for an item still listed are kept: a person who
  // pasted a key should not have to paste it again after a second look.
  useEffect(
    () =>
      setChoices((current) => {
        const next = choicesFrom(review);
        for (const [key, choice] of Object.entries(next)) {
          if (current[key]?.typed) choice.typed = current[key].typed;
        }
        return next;
      }),
    [review],
  );

  const groups = useMemo(() => groupReview(review), [review]);
  const picked = useMemo(() => review.sources.flatMap((s) => s.items.filter((i) => choices[i.key]?.on)), [review, choices]);
  // a server that just came over without its keys is the one loose end
  const needsKeys = review.sources.some((s) => s.items.some((i) => i.mcp?.needs.length && results[i.key]?.ok && results[i.key]?.note?.startsWith("Still needs")));

  const set = (key: string, next: Choice) => setChoices((current) => ({ ...current, [key]: next }));
  const setAll = (keys: string[], on: boolean) =>
    setChoices((current) => {
      const next = { ...current };
      for (const key of keys) next[key] = { ...next[key], on };
      return next;
    });

  const bring = async () => {
    setBusy(true);
    setProblem(null);
    setSummary(null);
    setRun(null);
    setUndone(false);
    try {
      const picks = picked.map((item) => pickFor(item, choices[item.key]));
      const outcome: { results: Result[]; created: string[]; run?: SetupRun | null; review: SetupReview } = await api("/api/setup-import", {
        method: "POST",
        body: JSON.stringify({ picks }),
      });
      setResults(Object.fromEntries(outcome.results.map((r) => [r.key, r])));
      const brought = outcome.results.filter((r) => r.ok && r.did !== "unchanged").length;
      const failed = outcome.results.filter((r) => !r.ok).length;
      setSummary({ brought, created: outcome.created.length, failed });
      setRun(outcome.run ?? null);
      // what was typed has done its job; it is not kept on screen
      setChoices((current) => Object.fromEntries(Object.entries(current).map(([k, c]) => [k, { ...c, typed: undefined, copy: undefined }])));
      onReview(outcome.review);
      onImported?.({ brought, created: outcome.created.length });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t("bringYourSetup.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  };

  // the last import, from an earlier visit, while it can still be undone
  const earlier = !run && !summary && !compact ? review.lastRun : null;
  // OpenBot found, said above its items; otherwise, from a server that
  // reads transfer files, the one line that offers one
  const openbot = review.sources.some((s) => s.id === "openbot");
  const takesTransfer = review.transfer !== undefined;

  return (
    <div className="flex min-h-0 flex-col">
      {/* the first-run step names the tools in its own heading */}
      <div className={cn("mb-4 px-1 text-body leading-relaxed text-muted-foreground", compact && "hidden")}>
        {tr("bringYourSetup.foundIn", {
          sources: (
            <span>
              {review.sources.map((source, i) => (
                <span key={source.id}>
                  {i > 0 && (i === review.sources.length - 1 ? t("bringYourSetup.listAnd") : t("bringYourSetup.listComma"))}
                  {tr("bringYourSetup.sourceInFolder", {
                    source: <span className="text-foreground">{source.name}</span>,
                    folder: <span className="font-mono text-caption">{source.folder}</span>,
                  })}
                </span>
              ))}
            </span>
          ),
        })}
      </div>
      {earlier && (
        <div className="mb-4 px-1">
          <UndoImport run={earlier} onReview={onReview} onUndone={() => setResults({})} lead={t("bringYourSetup.lastImport", { when: when(earlier.at), count: earlier.items })} />
        </div>
      )}
      <div className="flex flex-col gap-5">
        {openbot && <OpenBotSource review={review} onReview={onReview} />}
        {groups.map((group) => {
          const keys = group.entries.map((e) => e.item.key);
          const on = keys.filter((k) => choices[k]?.on).length;
          return (
            <section key={group.id} aria-label={group.label}>
              <div className="mb-2 flex items-end justify-between gap-3 px-1">
                <h2 className="text-ui font-semibold text-foreground">
                  {group.label} <span className="font-normal text-muted-foreground">{group.entries.length}</span>
                </h2>
                {group.entries.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setAll(keys, on < keys.length)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-small text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {on < keys.length ? t("bringYourSetup.selectAll") : t("bringYourSetup.selectNone")}
                  </button>
                )}
              </div>
              <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
                {group.entries.map(({ item, source }) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    source={source}
                    choice={choices[item.key] ?? { on: false, to: item.suggested.to, botId: item.suggested.botId }}
                    result={results[item.key]}
                    ownerGone={choices[item.key] ? ownerMissing(item, choices[item.key], choices) : null}
                    onChange={(next) => set(item.key, next)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {review.sources.some((s) => s.skipped.length > 0) && (
          <details className="group px-1">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-small text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight size={12} className="transition-transform duration-150 group-open:rotate-90" />
              {t("bringYourSetup.leftOut", { n: review.sources.reduce((n, s) => n + s.skipped.length, 0) })}
            </summary>
            <div className="mt-1.5 flex flex-col gap-2.5 pl-4">
              {review.sources
                .filter((s) => s.skipped.length > 0)
                .map((source) => (
                  <div key={source.id}>
                    <div className="text-small font-medium text-foreground">{source.name}</div>
                    <ul className="mt-0.5 flex flex-col gap-1">
                      {source.skipped.map((skip) => (
                        <li key={`${skip.from}:${skip.why}`} className="text-small leading-relaxed text-muted-foreground">
                          <span className="break-all font-mono text-caption text-foreground/80">{skip.from}</span>: {skip.why}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          </details>
        )}
        {!openbot && takesTransfer && (
          <div className="px-1">
            <TransferChooser quiet transfer={review.transfer} onReview={onReview} />
          </div>
        )}
      </div>

      <div className={cn("flex flex-col gap-2", compact ? "mt-4" : "sticky bottom-0 -mx-1 mt-5 bg-background/90 px-1 pb-1 pt-3 backdrop-blur")}>
        {problem && <div className="text-small text-destructive">{problem}</div>}
        {summary && !undone && (
          <div className="text-body text-foreground" aria-live="polite">
            {[
              summary.brought ? t("bringYourSetup.summary.broughtOver", { count: summary.brought }) : t("bringYourSetup.summary.nothingNew"),
              summary.created ? t("bringYourSetup.summary.madeAgents", { count: summary.created }) : "",
              summary.failed ? t("bringYourSetup.summary.failed", { n: summary.failed }) : "",
            ]
              .filter(Boolean)
              .join(" ")}
          </div>
        )}
        {run && (
          <UndoImport
            key={run.id}
            run={run}
            onReview={onReview}
            onUndone={() => {
              setResults({});
              setUndone(true);
            }}
            lead={t("bringYourSetup.notWhatYouWanted")}
          />
        )}
        {needsKeys && !compact && (
          <div className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
            {t("bringYourSetup.someServersNeedKey")}
            <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: "apps" })}>
              {t("bringYourSetup.addKeys")}
            </Button>
          </div>
        )}
        {/* In the first-run step, once something came over and nothing else
            is ticked, the way on is the parent's Continue, not a dead button */}
        {!(compact && summary && picked.length === 0) && (
          <Button
            size={compact ? "lg" : "default"}
            variant={compact ? "default" : "brand"}
            disabled={busy || picked.length === 0}
            onClick={() => void bring()}
            className={cn(compact ? "w-full sm:w-auto sm:self-start" : "self-start")}
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> {t("bringYourSetup.bringingOver")}
              </>
            ) : picked.length === 0 ? (
              t("bringYourSetup.nothingSelected")
            ) : (
              t("bringYourSetup.bringOverItems", { count: picked.length })
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The Settings page. */
export function BringYourSetupPage() {
  const { review, where, error, reload, set } = useSetupReview();
  return (
    <div className="flex flex-col gap-5">
      {!error && <SetupPrivacyLine where={where} />}
      {review === null ? (
        <div className="flex items-center gap-2 py-6 text-body text-muted-foreground">
          <Loader2 size={15} className="animate-spin" /> {t("bringYourSetup.looking")}
        </div>
      ) : error ? (
        <div className="rounded-2xl border bg-card p-4 text-body text-destructive">{t("bringYourSetup.couldNotCheck", { error })}</div>
      ) : review.sources.length === 0 ? (
        <div className="rounded-2xl border bg-card p-4">
          <div className="text-ui font-medium text-foreground">{t("bringYourSetup.nothingFoundToBringOver")}</div>
          <div className="mt-1 text-body leading-relaxed text-muted-foreground">
            {where && !where.here ? t("bringYourSetup.checksOn", { computer: where.computer }) : t("bringYourSetup.checks")}
          </div>
          {review.transfer !== undefined && (
            <div className="mt-3">
              <TransferChooser quiet transfer={review.transfer} onReview={set} />
            </div>
          )}
          {review.lastRun && (
            <div className="mt-3">
              <UndoImport run={review.lastRun} onReview={set} lead={t("bringYourSetup.lastImport", { when: when(review.lastRun.at), count: review.lastRun.items })} />
            </div>
          )}
          <Button size="sm" variant="secondary" className="mt-3" onClick={reload}>
            {t("bringYourSetup.lookAgain")}
          </Button>
        </div>
      ) : (
        <SetupReviewList review={review} onReview={set} />
      )}
    </div>
  );
}
