// Install and sign in, as buttons.
//
// Used where an engine is missing or signed out: the first-run check and
// Settings, Engines. The server does the work (server/engine-setup.ts) and
// only for a window on this computer; anywhere else, and whenever a button
// cannot finish the job, the command is still here to copy, so there is
// always a next step and never a dead end.
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import LogIn from "lucide-react/dist/esm/icons/log-in.mjs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { api, useStore } from "@/state/store";

type SetupTable = Record<string, { install: string; signIn?: string }>;

let cached: Promise<SetupTable | null> | null = null;

/** What this computer can set up, or null for a window that is not on it
 * (the phone, the web app, a remote Mac), where only copying makes sense. */
function loadSetup(): Promise<SetupTable | null> {
  cached ??= fetch("/api/engines/setup")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.setup as SetupTable) ?? null)
    .catch(() => null);
  return cached;
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
      title="Copy to clipboard"
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{command}</code>
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
  const [setup, setSetup] = useState<SetupTable | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [signingIn, setSigningIn] = useState<"opened" | "manual" | null>(null);

  useEffect(() => {
    let alive = true;
    void loadSetup().then((s) => alive && setSetup(s));
    return () => {
      alive = false;
    };
  }, []);

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

  const entry = setup?.[kind];
  const install = async () => {
    setBusy(true);
    setProblem(null);
    setLog("");
    try {
      const res = await fetch(`/api/engines/${kind}/install`, { method: "POST" });
      const result = await res.json();
      if (!result.ok) {
        setProblem(result.problem ?? `${name} did not install.`);
        setLog(result.log ?? "");
      }
    } catch {
      setProblem("Bloks could not start the installer.");
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

  if (setup === undefined) return null;

  if (!installed) {
    const command = entry?.install ?? fallback;
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {entry ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void install()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {busy ? "Installing…" : `Install ${name}`}
            </Button>
            {busy && <span className="text-[11.5px] text-muted-foreground">Can take a minute. No password needed.</span>}
          </div>
        ) : (
          command && <CopyCommand command={command} />
        )}
        {problem && (
          <div className="rounded-lg bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
            {problem}
            {log && (
              <button
                onClick={() => setShowLog((v) => !v)}
                className="mt-1 flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight size={11} className={cn("transition-transform duration-150", showLog && "rotate-90")} />
                {showLog ? "Hide" : "Show"} what the installer said
              </button>
            )}
            {showLog && (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[10.5px] text-muted-foreground">
                {log}
              </pre>
            )}
            {entry && (
              <div className="mt-1.5 text-muted-foreground">
                Or run it yourself in Terminal:
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
            Sign in to {name}
          </Button>
        </div>
        {signingIn === "opened" && (
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            Finish in the Terminal window that just opened. This turns green by itself once you are
            signed in.
          </div>
        )}
        {signingIn === "manual" && (
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            Run this in a terminal and follow its steps:
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
  const [local, setLocal] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadSetup().then((s) => alive && setLocal(Boolean(s)));
    return () => {
      alive = false;
    };
  }, []);

  if (!update) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/engines/${kind}/update`, { method: "POST" });
      const result = await res.json();
      if (!result.ok) {
        setNote(result.problem ?? `${name} did not update.`);
      } else if (!result.reloaded) {
        setNote(`Updated. The new models appear once the agents working with ${name} now have finished.`);
      }
      const [{ updates }, { instances }] = await Promise.all([api("/api/engines/updates"), api("/api/instances")]);
      if (updates) dispatch({ type: "engineUpdates", updates });
      if (instances) dispatch({ type: "instances", instances });
    } catch {
      setNote("Bloks could not start the update.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("rounded-lg bg-brand-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-foreground", className)}>
      <div>
        <span className="font-medium">
          {name} {update.latest} is out.
        </span>{" "}
        <span className="text-muted-foreground">
          You have {update.installed}, so newer models may be missing here.
        </span>
      </div>
      {local ? (
        <Button size="sm" variant="secondary" className="mt-1.5 h-6 px-2 text-[11.5px]" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {busy ? "Updating…" : `Update ${name}`}
        </Button>
      ) : (
        <div className="mt-1 text-muted-foreground">Update it on the computer Bloks runs on.</div>
      )}
      {note && <div className="mt-1 text-muted-foreground">{note}</div>}
    </div>
  );
}
