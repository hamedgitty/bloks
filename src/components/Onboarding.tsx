// First-run setup. Two screens, both answering "will this actually work
// on your machine", Bloks never asks who you are. Everything is
// skippable: setup must never brick the app. It ends by handing off to
// the agent picker, so the first thing you do is choose someone.
import { useCallback, useEffect, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Mic from "lucide-react/dist/esm/icons/mic.mjs";
import Monitor from "lucide-react/dist/esm/icons/monitor.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { BlockField, BloksLogo } from "./Brand";
import { BlokAvatar } from "./Avatar";
import { useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { setSetupDone, track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { recommendedFor, WORK_TYPES } from "@/lib/recommend";
import { AGENT_TEMPLATES } from "@/lib/agentTemplates";

type InstanceRow = {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    version?: string | null;
    authenticated?: boolean;
  };
};

const isElectron = navigator.userAgent.includes("Electron");

/** An install command you can take with you. */
function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="mt-2 flex w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-accent active:scale-[0.99]"
      title="Copy to clipboard"
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
        {command}
      </code>
      {copied ? (
        <Check size={13} className="shrink-0 text-success" />
      ) : (
        <Copy size={13} className="shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function EngineRow({
  ok,
  title,
  detail,
  command,
}: {
  ok: boolean;
  title: string;
  detail: string;
  command?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
        >
          {ok ? <Check size={13} /> : <AlertTriangle size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</div>
          {!ok && command && <CommandRow command={command} />}
        </div>
      </div>
    </div>
  );
}

function PermissionRow({
  icon,
  title,
  detail,
  status,
  onEnable,
  onOpenSettings,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  status?: string;
  onEnable: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <div>
          <div className="text-[13.5px] font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{detail}</div>
        </div>
      </div>
      {status === "granted" ? (
        <Check size={16} className="shrink-0 text-success" />
      ) : status === "denied" || status === "restricted" ? (
        <Button variant="secondary" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={onEnable}>
          Enable
        </Button>
      )}
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { dispatch } = useStore();
  const [step, setStep] = useState(0);
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [perms, setPerms] = useState<{ mic: string; screen: string } | null>(null);
  /** What was already here before this run, if anything. Null until the
   * workspace answers; a fresh install answers with zeroes. */
  const [prior, setPrior] = useState<{
    agents: number;
    rooms: number;
    messages: number;
    mine: number;
  } | null>(null);
  const [resetting, setResetting] = useState(false);
  /** What kind of work they said they do, and who that suggests. */
  const [work, setWork] = useState<string[]>([]);
  const [hiring, setHiring] = useState<string | null>(null);
  const [hired, setHired] = useState<string[]>([]);

  useEffect(() => {
    void fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setPrior(c.workspace ?? null))
      .catch(() => setPrior(null));
  }, []);

  /** Everything already here is worth keeping unless somebody says
   * otherwise, so this moves it aside rather than deleting it: the
   * folder is renamed with a timestamp and can be renamed back. */
  const startFresh = () => {
    if (
      !window.confirm(
        "Move your existing agents and conversations aside and start fresh?\n\nNothing is deleted: everything is kept in a timestamped folder next to it, and the app will reload.",
      )
    ) {
      return;
    }
    setResetting(true);
    void fetch("/api/workspace/reset", { method: "POST" })
      .then(() => {
        // the harness reseeds itself on the next boot; a reload is the
        // shortest honest way to land in that fresh workspace
        localStorage.removeItem("bloks-setup-done");
        location.reload();
      })
      .catch(() => setResetting(false));
  };

  const checkEngines = useCallback(() => {
    setChecking(true);
    return fetch("/api/instances")
      .then((r) => r.json())
      .then((d) => setInstances(d.instances ?? []))
      .catch(() => setInstances([]))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    track("setup_step", { step });
    if (step === 0) {
      void checkEngines();
      // the user may install a CLI in another window and come back
      const timer = setInterval(checkEngines, 5000);
      return () => clearInterval(timer);
    }
    if (step === 3 && isElectron) {
      const poll = () => window.bloks?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      const timer = setInterval(poll, 2000);
      return () => clearInterval(timer);
    }
  }, [step, checkEngines]);

  /** Creates one recommended agent, with the role already written. */
  const hire = (template: (typeof AGENT_TEMPLATES)[number]) => {
    setHiring(template.id);
    void fetch("/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: template.name,
        title: template.title,
        description: template.description,
        skills: template.skills,
        color: template.color,
        shape: template.shape,
        greeting: template.greeting,
        setup: template.setup,
      }),
    })
      .then(() => setHired((current) => [...current, template.id]))
      .catch(() => {})
      .finally(() => setHiring(null));
  };

  const finish = () => {
    track("setup_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
      screen: perms?.screen ?? "n/a",
    });
    setSetupDone();
    onDone();
    // Hand off to the agent picker rather than dropping the user into a
    // chat with a stranger. Choosing a role is what teaches that agents
    // have jobs, and it is the one idea the rest of the product rests on.
    // Skipping is fine: Nova is seeded on the server and already waiting.
    // Somebody who took a recommendation already has an agent with a job.
    // Opening the picker on top of that would read as though the choice
    // they just made had not counted.
    if (hired.length === 0) {
      dispatch({ type: "toggleNewAgent", open: true, firstRun: true });
    }
  };

  const byKind = (kind: string) => instances?.find((i) => i.driverKind === kind);

  // The engines worth naming on a first run, in the order somebody is
  // most likely to already have one. Data rather than markup so the list
  // can grow without the layout arguing about it; the panel scrolls once
  // it outgrows its height, which is the point of keeping them uniform.
  const ENGINES: Array<{
    kind: string;
    name: string;
    command?: string;
    /** Connected by pasting a key in Settings, not by installing a CLI. */
    byKey?: boolean;
    have: string;
    want: string;
  }> = [
    {
      kind: "claudeAgent",
      name: "Claude Code",
      command: "npm i -g @anthropic-ai/claude-code",
      have: "Installed and ready to power agents.",
      want: "Not found. Install it, then this turns green on its own.",
    },
    {
      kind: "codex",
      name: "Codex",
      command: "npm i -g @openai/codex",
      have: "Installed. Agents can run on Codex too.",
      want: "Optional. Adds a second engine your agents can use.",
    },
    {
      kind: "pi",
      name: "Pi",
      command: "npm i -g --ignore-scripts @earendil-works/pi-coding-agent && npm i -g pi-acp",
      have: "Installed. Agents can run on Pi too.",
      want: "Optional. Install Pi and pi-acp to add a tool-running engine.",
    },
    {
      kind: "antigravity",
      name: "Antigravity",
      command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      have: "Installed. Signs in with your Google account.",
      want: "Optional. Google's agent CLI, free with a Google account.",
    },
    {
      kind: "grokCli",
      name: "Grok CLI",
      command: "curl -fsSL https://x.ai/cli/install.sh | bash",
      have: "Installed. Binds to your grok.com subscription.",
      want: "Optional. Runs on an existing Grok subscription.",
    },
    {
      kind: "kimi",
      name: "Kimi",
      byKey: true,
      have: "Connected. Ready for agents to think with.",
      want: "Optional. Paste a Kimi key in Settings to switch it on.",
    },
  ];

  const ready = instances?.some((i) => i.snapshot.state === "available") ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      <BlockField />
      <div className="relative flex w-full max-w-[440px] animate-pop-in flex-col rounded-2xl border bg-popover p-6 shadow-2xl shadow-[--shadow-color] sm:p-8">
        {/* A first boot seeds one agent that says hello, so "is anything
            here" would greet every new install with "welcome back". What
            marks a real workspace is that somebody has spoken in it, or
            built more than the seed. */}
        {step === 0 && prior && (prior.mine > 0 || prior.agents > 1 || prior.rooms > 0) ? (
          // Somebody already has a workspace here: a previous install, or
          // a copy carried across from another Mac. Dropping them into it
          // unannounced reads as "the app came with stranger's data", and
          // wiping it unasked is worse. So: say what is here, and let them
          // choose.
          <div className="flex flex-col">
            <div className="flex justify-center">
              <BloksLogo />
            </div>
            <h1 className="mt-6 text-center text-[18px] font-semibold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="mt-1 text-center text-[13px] leading-relaxed text-muted-foreground">
              This Mac already has a Bloks workspace: {prior.agents}{" "}
              {prior.agents === 1 ? "agent" : "agents"}
              {prior.rooms > 0 && `, ${prior.rooms} ${prior.rooms === 1 ? "room" : "rooms"}`} and{" "}
              {prior.messages.toLocaleString()}{" "}
              {prior.messages === 1 ? "message" : "messages"}.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={() => setPrior(null)} disabled={resetting}>
                Continue where I left off
              </Button>
              <Button variant="secondary" onClick={startFresh} disabled={resetting}>
                {resetting ? "Setting up…" : "Start fresh"}
              </Button>
            </div>
            <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
              Starting fresh keeps the old workspace in a timestamped folder beside this one.
              Nothing is deleted.
            </p>
          </div>
        ) : step === 0 ? (
          <div className="flex flex-col">
            <div className="flex justify-center">
              <BloksLogo />
            </div>
            <h1 className="mt-6 text-center text-[18px] font-semibold tracking-tight text-foreground">
              Let's check your engines
            </h1>
            <p className="mt-1 text-center text-[13px] leading-relaxed text-muted-foreground">
              Agents run on the AI tools already installed on this Mac. Everything stays local.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {!instances ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
                  <Loader2 size={15} className="animate-spin" /> Looking…
                </div>
              ) : (
                <>
                  <div className="-mr-1 flex max-h-[264px] flex-col gap-2 overflow-y-auto pr-1">
                    {ENGINES.map((engine) => {
                      const found = byKind(engine.kind);
                      const ok = found?.snapshot.state === "available";
                      return (
                        <EngineRow
                          key={engine.kind}
                          ok={ok}
                          title={
                            engine.name +
                            (ok && found?.snapshot.version
                              ? ` · ${found.snapshot.version.split(" ")[0]}`
                              : "")
                          }
                          detail={ok ? engine.have : engine.want}
                          command={engine.command}
                        />
                      );
                    })}
                  </div>
                  {!ready && (
                    // a CLI is the best engine, not the only one: without
                    // either of them there is still a way in
                    <p className="px-1 pt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                      Neither one installed? Continue anyway and connect Gemini, Grok, Kimi, Llama or
                      OpenRouter from Settings. Those chat but cannot run commands.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={() => void checkEngines()}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
              >
                <RefreshCw size={12} className={cn(checking && "animate-spin")} />
                Check again
              </button>
              {instances && !ready && (
                <span className="text-[12px] text-warning">No engine yet, agents can't reply</span>
              )}
            </div>

            <Button
              size="lg"
              onClick={() => setStep(1)}
              className="mt-4 w-full"
            >
              {ready ? "Continue" : "Continue anyway"}
            </Button>
          </div>
        ) : null}

        {step === 1 && (
          // Naming the work is a far easier question than inventing an
          // agent from nothing, and the answer is enough to propose
          // three that are obviously useful rather than merely available.
          <div className="flex flex-col">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">
              What do you spend your time on?
            </h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Pick any that fit. This only decides who we suggest first; you can make
              any agent you like afterwards.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-1.5">
              {WORK_TYPES.map((option) => {
                const on = work.includes(option.id);
                return (
                  <button
                    key={option.id}
                    onClick={() =>
                      setWork((current) =>
                        on ? current.filter((id) => id !== option.id) : [...current, option.id],
                      )
                    }
                    className={cn(
                      "rounded-xl border px-2.5 py-2 text-left transition-colors duration-150",
                      on
                        ? "border-brand bg-brand-soft"
                        : "border-border hover:border-foreground/25",
                    )}
                  >
                    <div className="text-[12.5px] font-medium text-foreground">{option.label}</div>
                    <div className="text-[11px] text-muted-foreground">{option.hint}</div>
                  </button>
                );
              })}
            </div>
            <Button size="lg" className="mt-5 w-full" onClick={() => setStep(2)}>
              {work.length ? "Continue" : "Skip this"}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">
              Start with one of these
            </h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Each comes with a role already written. Hire one now, or skip and build
              your own from scratch.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {recommendedFor(work, 3).map((id) => {
                const template = AGENT_TEMPLATES.find((t) => t.id === id);
                if (!template) return null;
                const already = hired.includes(id);
                return (
                  <div
                    key={id}
                    className="flex items-center gap-3 rounded-xl border bg-card p-3"
                  >
                    <BlokAvatar
                      color={template.color}
                      shape={template.shape}
                      expression="friendly"
                      size={34}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-foreground">
                        {template.name}
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {template.title}
                      </div>
                    </div>
                    <Button
                      variant={already ? "ghost" : "secondary"}
                      size="sm"
                      disabled={already || hiring !== null}
                      onClick={() => hire(template)}
                    >
                      {already ? "Added" : hiring === id ? "Adding…" : "Add"}
                    </Button>
                  </div>
                );
              })}
            </div>
            <Button size="lg" className="mt-5 w-full" onClick={() => (isElectron ? setStep(3) : finish())}>
              {hired.length ? "Continue" : "Skip for now"}
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">Permissions</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Nothing here is required, and nothing is used until you ask for the feature that needs it.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <PermissionRow
                icon={<Mic size={17} />}
                title="Microphone & speech"
                detail="Voice dictation into the composer, transcribed on-device."
                status={perms?.mic}
                onEnable={() =>
                  window.bloks?.permRequestMic?.().then(() => window.bloks?.permStatus?.().then(setPerms))
                }
                onOpenSettings={() => window.bloks?.permOpenSettings?.("mic")}
              />
              <PermissionRow
                icon={<Monitor size={17} />}
                title="Screen preview"
                detail="Shows this Mac's screen in the Computer panel when an agent works locally."
                status={perms?.screen}
                onEnable={() =>
                  navigator.mediaDevices
                    .getDisplayMedia({ video: true })
                    .then((stream) => stream.getTracks().forEach((t) => t.stop()))
                    .catch(() => {})
                    .then(() => window.bloks?.permStatus?.().then(setPerms))
                }
                onOpenSettings={() => window.bloks?.permOpenSettings?.("screen")}
              />
            </div>
            <Button size="lg" onClick={finish} className="mt-5 w-full">
              Start using Bloks
            </Button>
            <button
              onClick={finish}
              className="mt-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
