// Install and sign in, as buttons.
//
// Used where an engine is missing or signed out: the first-run check and
// Settings, Engines and keys. The server does the work
// (server/engine-setup.ts) and only for a window on this computer;
// anywhere else, and whenever a button cannot finish the job, the command
// is still here to copy, so there is always a next step and never a dead
// end.
import { useEffect, useRef, useState } from "react";
import { Check } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Copy } from "@/components/icons";
import { Download } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Info } from "@/components/icons";
import { LogIn } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { isHostedWindow } from "@/lib/waking";
import { api, useStore } from "@/state/store";
import { t, tr, type MessageKey } from "@/lib/i18n";

type SetupTable = Record<string, { install: string; signIn?: string }>;

/** GET /api/engines/setup. `runs` is false on Windows, where the app runs
 * no installer and every line is PowerShell's, to copy; `updates` are
 * those lines for updating, since the Update button cannot run either. */
interface SetupInfo {
  setup: SetupTable;
  runs: boolean;
  updates: Record<string, string>;
}

/** Whose plan a sign-in spends, for the engines that sign in with a
 * person's own subscription. */
const PLAN_OWNER: Record<string, { plan: string; maker: string; first?: MessageKey }> = {
  claudeAgent: { plan: "Claude", maker: "Anthropic" },
  // a machine with no browser signs Codex in with a code, which ChatGPT
  // only accepts once the person has turned it on
  codex: { plan: "ChatGPT", maker: "OpenAI", first: "engineSetup.deviceCodeFirst" },
  geminiCli: { plan: "Google AI", maker: "Google" },
};

/**
 * Said once, under Sign in, on a hosted machine. A person may sign in
 * there with their own plan: Anthropic allows it on a machine a platform
 * hosts, and OpenAI documents signing Codex in on a remote one. But a plan
 * is priced for one person's ordinary use, and agents working around the
 * clock on it are the person's own arrangement with its maker, not ours.
 * So it is said plainly, once, with the alternative, and never as a gate.
 */
function HostedPlanNote({ kind }: { kind: string }) {
  const owner = PLAN_OWNER[kind];
  if (!owner || !isHostedWindow()) return null;
  return (
    <div className="flex items-start gap-1.5 text-small leading-relaxed text-muted-foreground">
      <Info size={13} className="mt-[3px] shrink-0" aria-hidden />
      <span>
        {t("engineSetup.hostedPlan", { plan: owner.plan, maker: owner.maker })}
        {owner.first ? ` ${t(owner.first)}` : ""}
      </span>
    </div>
  );
}

let cached: Promise<SetupInfo | null> | null = null;

/** What this computer can set up, or null for a window that is not on it
 * (the phone, the web app, a remote Mac), where only copying makes sense. */
function loadSetup(): Promise<SetupInfo | null> {
  cached ??= fetch("/api/engines/setup")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.setup ? { setup: d.setup as SetupTable, runs: d.runs !== false, updates: (d.updates ?? {}) as Record<string, string> } : null))
    .catch(() => null);
  return cached;
}

/** This computer's setup, or null for a window that is not on it.
 * Undefined until it is known. */
function useSetup(): SetupInfo | null | undefined {
  const [info, setInfo] = useState<SetupInfo | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadSetup().then((s) => alive && setInfo(s));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** Whether this window is on the computer Bloks runs on, where it can
 * install, update and choose which CLI runs. Null until it is known. */
export function useOnThisComputer(): boolean | null {
  const info = useSetup();
  return info === undefined ? null : Boolean(info);
}

/** On a computer where the app cannot run the update itself (Windows),
 * the line that does, to copy. Nothing for an engine that updates on its
 * own. */
function UpdateItYourself({ command }: { command: string | undefined }) {
  if (!command) return null;
  return (
    <div className="text-small leading-relaxed text-muted-foreground">
      {t("engineSetup.runThisInPowerShell")}
      <CopyCommand command={command} className="mt-1" />
    </div>
  );
}

/**
 * An engine that is installed but too old to run here. Not "missing",
 * since installing again beside it would leave the old one first on
 * PATH: it is updated where it is, by the same route the update note
 * uses (server/engine-updates.ts).
 */
export function EngineOutdatedActions({
  kind,
  name,
  onChanged,
}: {
  kind: string;
  name: string;
  onChanged: () => void;
}) {
  const info = useSetup();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (info === undefined) return null;
  if (!info) {
    return <div className="mt-1.5 text-small text-muted-foreground">{t("engineSetup.updateItOnTheComputer")}</div>;
  }
  if (!info.runs) {
    return (
      <div className="mt-2">
        <UpdateItYourself command={info.updates[kind]} />
      </div>
    );
  }
  const update = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/engines/${kind}/update`, { method: "POST" });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) setProblem(result.problem ?? t("engineSetup.didNotUpdate", { name }));
    } catch {
      setProblem(t("engineSetup.couldNotStartUpdate"));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div>
        <Button size="sm" variant="secondary" onClick={() => void update()} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {busy ? t("engineSetup.updating") : t("engineSetup.update", { name })}
        </Button>
      </div>
      {problem && (
        <div className="rounded-lg bg-warning/10 px-2.5 py-2 text-small leading-relaxed text-warning">
          {problem}
        </div>
      )}
    </div>
  );
}

/**
 * Which copy of an engine's CLI runs: the one on PATH, or one the person
 * points at (a second install, a build of their own). Only on the
 * computer Bloks runs on, since it chooses a program to start there; the
 * server checks the path is a file that can run before keeping it.
 */
export function EnginePathControl({
  kind,
  name,
  command,
  path,
  onChanged,
}: {
  kind: string;
  name: string;
  /** The name looked up on PATH, for saying what runs now. */
  command: string;
  path: string | null;
  onChanged: () => void;
}) {
  const local = useOnThisComputer();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!local) return null;

  const put = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/engines/${kind}/path`, { method: "PUT", body: JSON.stringify({ path: next }) });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const id = `engine-path-${kind}`;

  if (!editing) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-muted-foreground">
        {path ? (
          <>
            <span className="min-w-0 truncate" title={path}>
              {tr("engineSetup.runs", { path: <code className="font-mono text-foreground">{path}</code> })}
            </span>
            <button
              type="button"
              onClick={() => {
                setValue(path);
                setEditing(true);
              }}
              className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline"
            >
              {t("common.change")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void put(null)}
              className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline"
            >
              {busy ? t("engineSetup.saving") : t("engineSetup.useFromPath", { command })}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setValue("");
              setEditing(true);
            }}
            className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline"
          >
            {t("engineSetup.useDifferentCopy", { name })}
          </button>
        )}
        {error && <span className="basis-full text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <label htmlFor={id} className="text-small text-muted-foreground">
        {t("engineSetup.fullPath", { name })}
      </label>
      <div className="mt-1 flex gap-2">
        <Input
          id={id}
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void put(value.trim());
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder={`/usr/local/bin/${command}`}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1 font-mono text-small"
        />
        <Button variant="secondary" size="sm" className="h-8" disabled={busy || !value.trim()} onClick={() => void put(value.trim())}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : t("common.save")}
        </Button>
        <Button variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-small text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-accent active:scale-[0.99]",
        className,
      )}
      title={t("engineSetup.copyToClipboard")}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-small text-foreground">{command}</code>
      {copied ? <Check size={13} className="shrink-0 text-success" /> : <Copy size={13} className="shrink-0 text-muted-foreground" />}
    </button>
  );
}

/**
 * The next step for one engine: Install when it is missing, Sign in when
 * it is installed without a login. `onChanged` asks the caller to look
 * again, since only a fresh check can say whether it worked.
 */
export function EngineSetupActions({
  kind,
  name,
  installed,
  signedOut,
  fallback,
  onChanged,
}: {
  kind: string;
  name: string;
  installed: boolean;
  signedOut: boolean;
  /** The command to show when the app cannot run it itself. */
  fallback?: string;
  onChanged: () => void;
}) {
  const info = useSetup();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [signingIn, setSigningIn] = useState<"opened" | "manual" | null>(null);

  // Signing in finishes in another window, so look again every few
  // seconds for a while rather than asking for a click to say it is done.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (signingIn !== "opened") return;
    const timer = setInterval(() => changed.current(), 4000);
    const stop = setTimeout(() => clearInterval(timer), 5 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [signingIn]);

  const entry = info?.setup[kind];
  const install = async () => {
    setBusy(true);
    setProblem(null);
    setLog("");
    try {
      const res = await fetch(`/api/engines/${kind}/install`, { method: "POST" });
      const result = await res.json();
      if (!result.ok) {
        setProblem(result.problem ?? t("engineSetup.didNotInstall", { name }));
        setLog(result.log ?? "");
      }
    } catch {
      setProblem(t("engineSetup.couldNotStartInstaller"));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const signIn = async () => {
    try {
      const res = await fetch(`/api/engines/${kind}/signin`, { method: "POST" });
      const result = await res.json();
      setSigningIn(result.opened ? "opened" : "manual");
    } catch {
      setSigningIn("manual");
    }
  };

  if (info === undefined) return null;

  if (!installed) {
    const command = entry?.install ?? fallback;
    // Windows: the line its maker gives for PowerShell, since a button
    // here could only fail (server/engine-setup.ts)
    if (info && !info.runs) {
      return command ? (
        <div className="mt-2 text-small leading-relaxed text-muted-foreground">
          {t("engineSetup.runThisInPowerShell")}
          <CopyCommand command={command} className="mt-1" />
        </div>
      ) : null;
    }
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {entry ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void install()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {busy ? t("engineSetup.installing") : t("engineSetup.install", { name })}
            </Button>
            {busy && <span className="text-small text-muted-foreground">{t("engineSetup.canTakeAMinute")}</span>}
          </div>
        ) : (
          command && <CopyCommand command={command} />
        )}
        {problem && (
          <div className="rounded-lg bg-warning/10 px-2.5 py-2 text-small leading-relaxed text-warning">
            {problem}
            {log && (
              <button
                onClick={() => setShowLog((v) => !v)}
                className="mt-1 flex items-center gap-1 text-small text-muted-foreground hover:text-foreground"
              >
                <ChevronRight size={11} className={cn("transition-transform duration-150", showLog && "rotate-90")} />
                {showLog ? t("engineSetup.hideDetails") : t("engineSetup.showDetails")}
              </button>
            )}
            {showLog && (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-caption text-muted-foreground">
                {log}
              </pre>
            )}
            {entry && (
              <div className="mt-1.5 text-muted-foreground">
                {t("engineSetup.orRunItYourself")}
                <CopyCommand command={entry.install} className="mt-1" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (signedOut && entry?.signIn) {
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        <div>
          <Button size="sm" variant="secondary" onClick={() => void signIn()}>
            <LogIn size={13} />
            {t("engineSetup.signInTo", { name })}
          </Button>
        </div>
        <HostedPlanNote kind={kind} />
        {signingIn === "opened" && (
          <div className="text-small leading-relaxed text-muted-foreground">
            {t("engineSetup.finishInTheTerminalWindow")}
          </div>
        )}
        {signingIn === "manual" && (
          <div className="text-small leading-relaxed text-muted-foreground">
            {t("engineSetup.runThisInTerminal")}
            <CopyCommand command={entry.signIn} className="mt-1" />
          </div>
        )}
      </div>
    );
  }
  return null;
}

/**
 * A newer release of an engine than the one installed, and a way to get
 * it. Said where models are chosen, because a missing new model is the
 * symptom people notice, and an old CLI is nearly always the cause.
 * Updating runs on the computer Bloks is on, so other windows say where
 * to do it instead of offering a button that cannot work from there.
 */
export function EngineUpdateNote({ kind, name, className }: { kind: string; name: string; className?: string }) {
  const { state, dispatch } = useStore();
  const update = state.engineUpdates[kind];
  const info = useSetup();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!update) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/engines/${kind}/update`, { method: "POST" });
      const result = await res.json();
      if (!result.ok) {
        setNote(result.problem ?? t("engineSetup.didNotUpdate", { name }));
      } else if (!result.reloaded) {
        setNote(t("engineSetup.updatedWhenFinished", { name }));
      }
      const [{ updates }, { instances }] = await Promise.all([api("/api/engines/updates"), api("/api/instances")]);
      if (updates) dispatch({ type: "engineUpdates", updates });
      if (instances) dispatch({ type: "instances", instances });
    } catch {
      setNote(t("engineSetup.couldNotStartUpdate"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("rounded-lg bg-brand-soft px-2.5 py-2 text-small leading-relaxed text-foreground", className)}>
      <div>
        <span className="font-medium">
          {t("engineSetup.isOut", { name, version: String(update.latest) })}
        </span>{" "}
        <span className="text-muted-foreground">
          {t("engineSetup.youHave", { version: String(update.installed) })}
        </span>
      </div>
      {info && !info.runs ? (
        <div className="mt-1.5">
          <UpdateItYourself command={info.updates[kind]} />
        </div>
      ) : info ? (
        <Button size="sm" variant="secondary" className="mt-1.5 h-6 px-2 text-small" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {busy ? t("engineSetup.updating") : t("engineSetup.update", { name })}
        </Button>
      ) : (
        <div className="mt-1 text-muted-foreground">{t("engineSetup.updateItOnTheComputer")}</div>
      )}
      {note && <div className="mt-1 text-muted-foreground">{note}</div>}
    </div>
  );
}
