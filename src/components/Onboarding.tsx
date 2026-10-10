// First-run setup. Two screens, both answering "will this actually work
// on your machine", Bloks never asks who you are. Everything is
// skippable: setup must never brick the app. It ends by handing off to
// the agent picker, so the first thing you do is choose someone.
import { useCallback, useEffect, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
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
import { ThisComputer, thisComputer } from "@/lib/thisComputer";
import { ApprovalsChooser, confirmWidening, type ApprovalMode } from "./ApprovalsChooser";
import { EngineSetupActions } from "./EngineSetup";
import { SetupPrivacyLine, SetupReviewList, useSetupReview } from "./BringYourSetup";

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

/** One engine: ready, installed but signed out, or missing, each with
 * the button that gets it to ready. */
function EngineRow({
  kind,
  name,
  state,
  title,
  detail,
  command,
  onChanged,
}: {
  kind: string;
  name: string;
  state: "ready" | "signed-out" | "missing";
  title: string;
  detail: string;
  command?: string;
  onChanged: () => void;
}) {
  const ok = state === "ready";
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
          {!ok && (
            <EngineSetupActions
              kind={kind}
              name={name}
              installed={state === "signed-out"}
              signedOut={state === "signed-out"}
              fallback={command}
              onChanged={onChanged}
            />
          )}
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
  const [approvals, setApprovals] = useState<ApprovalMode>("ask");
  const [approvalsNote, setApprovalsNote] = useState<string | null>(null);
  const [savingApprovals, setSavingApprovals] = useState(false);
  /** What the person's other agent tools already know. The step that
   * offers it is only shown when there is something new to offer. */
  const setup = useSetupReview();
  const [broughtAgents, setBroughtAgents] = useState(0);
  const [brought, setBrought] = useState(false);
  const offerSetup = (setup.review?.fresh ?? 0) > 0;
  const afterSetup = () => (isElectron ? setStep(4) : finish());

  /** Where every agent starts, the one already here included. */
  const chooseApprovals = async () => {
    setApprovalsNote(null);
    if (!(await confirmWidening("ask", approvals, "your agents"))) {
      setApprovalsNote("Not confirmed. Pick again, or continue with Ask first.");
      setApprovals("ask");
      return;
    }
    setSavingApprovals(true);
    await fetch("/api/approvals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: approvals, applyToAll: true }),
    }).catch(() => {});
    setSavingApprovals(false);
    track("setup_approvals", { mode: approvals });
    setStep(3);
  };

  useEffect(() => {
    void fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setPrior(c.workspace ?? null))
      .catch(() => setPrior(null));
  }, []);

  /** Everything already here is worth keeping unless somebody says
   * otherwise, so this moves it aside rather than deleting it: the
   * folder is renamed with a timestamp and can be renamed back.
   *
   * The server ends itself once the folder is moved, because it still
   * holds the old workspace in memory. The desktop app relaunches to
   * start a fresh one; in a browser, the page waits for the server to
   * come back (a supervisor restarts it) and then loads the new one. */
  const [resetNote, setResetNote] = useState<string | null>(null);
  const startFresh = async () => {
    if (
      !window.confirm(
        "Start fresh?\n\nYour agents, rooms and conversations are moved into a timestamped folder beside this one, and nothing is deleted. Your keys, engines and Bloks Cloud stay set up. Bloks restarts to finish.",
      )
    ) {
      return;
    }
    setResetting(true);
    setResetNote(null);
    const before = await fetch("/api/health")
      .then((r) => r.json())
      .then((h) => h?.pid ?? null)
      .catch(() => null);
    const res = await fetch("/api/workspace/reset", { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setResetting(false);
      setResetNote(`That didn't work: ${body?.error ?? "Bloks could not move the workspace aside"}. Nothing was changed.`);
      return;
    }
    // what this browser remembered about the old workspace goes with it
    for (const key of [
      "bloks-setup-done",
      "bloks-selected",
      "bloks-folded-sections",
      "bloks-intro-plugins",
      "bloks-project",
      "bloks-room-lens",
    ]) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* private mode */
      }
    }
    if (window.bloks?.relaunch) {
      await window.bloks.relaunch();
      return;
    }
    for (let waited = 0; waited < 30_000; waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      const pid = await fetch("/api/health")
        .then((r) => (r.ok ? r.json() : null))
        .then((h) => h?.pid ?? null)
        .catch(() => null);
      if (pid && pid !== before) {
        location.reload();
        return;
      }
    }
    setResetNote("Your old workspace is moved aside. Restart Bloks to open the fresh one.");
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
    // Reaching the setup step would say another tool was found here, and
    // that screen promises nothing about the person's setup leaves.
    if (step !== 5) track("setup_step", { step });
    if (step === 0) {
      void checkEngines();
      // the user may install a CLI in another window and come back
      const timer = setInterval(checkEngines, 5000);
      return () => clearInterval(timer);
    }
    if (step === 4 && isElectron) {
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
    // Somebody who took a recommendation, or brought an agent over from
    // another tool, already has an agent with a job. Opening the picker on
    // top of that would read as though the choice they just made had not
    // counted.
    if (hired.length === 0 && broughtAgents === 0) {
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
      command: "curl -fsSL https://claude.ai/install.sh | bash",
      have: "Installed and ready to power agents.",
      want: "Not installed yet. Install it here; it turns green on its own.",
    },
    {
      kind: "codex",
      name: "Codex",
      command: "npm i -g --prefix ~/.local @openai/codex",
      have: "Installed. Agents can run on Codex too.",
      want: "Optional. Adds a second engine your agents can use.",
    },
    {
      kind: "pi",
      name: "Pi",
      command: "npm i -g --prefix ~/.local --ignore-scripts @earendil-works/pi-coding-agent pi-acp",
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

  // signed out is not ready: it installs green and then fails the first
  // message, which is the setup problem this screen exists to catch
  const ready =
    instances?.some((i) => i.snapshot.state === "available" && i.snapshot.authenticated !== false) ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      <BlockField />
      <div
        className={cn(
          "relative flex w-full animate-pop-in flex-col rounded-2xl border bg-popover p-6 shadow-2xl shadow-(color:--shadow-color) sm:p-8",
          // the review needs room for a preview and a destination on one line
          step === 5 ? "max-h-full max-w-[560px] overflow-y-auto" : "max-w-[440px]",
        )}
      >
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
              {ThisComputer()} already has a Bloks workspace: {prior.agents}{" "}
              {prior.agents === 1 ? "agent" : "agents"}
              {prior.rooms > 0 && `, ${prior.rooms} ${prior.rooms === 1 ? "room" : "rooms"}`} and{" "}
              {prior.messages.toLocaleString()}{" "}
              {prior.messages === 1 ? "message" : "messages"}.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={() => setPrior(null)} disabled={resetting}>
                Continue where I left off
              </Button>
              <Button variant="secondary" onClick={() => void startFresh()} disabled={resetting}>
                {resetting ? "Starting fresh…" : "Start fresh"}
              </Button>
            </div>
            {resetNote ? (
              <p className="mt-3 text-center text-[12px] leading-relaxed text-warning">{resetNote}</p>
            ) : (
              <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                Starting fresh keeps the old workspace in a timestamped folder beside this one.
                Nothing is deleted, and your keys and engines stay set up.
              </p>
            )}
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
              Agents run on the AI tools already installed on {thisComputer()}. Everything stays local.
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
                      const installed = found?.snapshot.state === "available";
                      const state = !installed ? "missing" : found?.snapshot.authenticated === false ? "signed-out" : "ready";
                      return (
                        <EngineRow
                          key={engine.kind}
                          kind={engine.kind}
                          name={engine.name}
                          state={state}
                          title={
                            engine.name +
                            (installed && found?.snapshot.version
                              ? ` · ${found.snapshot.version.split(" ")[0]}`
                              : "")
                          }
                          detail={
                            state === "ready"
                              ? engine.have
                              : state === "signed-out"
                                ? "Installed, but not signed in yet, so it cannot answer. One step left."
                                : engine.want
                          }
                          command={engine.command}
                          onChanged={() => void checkEngines()}
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
                <span className="text-[12px] text-warning">No engine ready yet, agents can't reply</span>
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
          // Asked once, up front, because the default decides how the
          // first hour feels: a card for everything, or agents that get on
          // with it. Every agent made from here starts on the choice.
          <div className="flex flex-col">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">
              How much should your agents ask?
            </h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              You can change this any time in Settings, and for any one agent in its own
              settings.
            </p>
            <div className="mt-4">
              <ApprovalsChooser value={approvals} onChange={setApprovals} compact />
            </div>
            {approvalsNote && <div className="mt-2 text-[12px] text-warning">{approvalsNote}</div>}
            <Button size="lg" className="mt-5 w-full" disabled={savingApprovals} onClick={() => void chooseApprovals()}>
              Continue
            </Button>
          </div>
        )}

        {step === 3 && (
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
            <Button size="lg" className="mt-5 w-full" onClick={() => (offerSetup ? setStep(5) : afterSetup())}>
              {hired.length ? "Continue" : "Skip for now"}
            </Button>
          </div>
        )}

        {step === 5 && setup.review && (
          // Optional, and only here when another agent tool left something
          // worth bringing. Last of the agent steps so the agents just
          // hired can be chosen as a destination.
          <div className="flex min-h-0 flex-col">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">Bring your setup</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Found in {setup.review.sources.map((s) => s.name).join(", ")}. Tick what to bring over. You can
              do this later from Settings too.
            </p>
            <SetupPrivacyLine className="mt-4" />
            <div className="mt-4 min-h-0">
              <SetupReviewList
                review={setup.review}
                onReview={setup.set}
                compact
                onImported={({ brought: count, created }) => {
                  if (count) setBrought(true);
                  setBroughtAgents((n) => n + created);
                }}
              />
            </div>
            {brought ? (
              <Button size="lg" onClick={afterSetup} className="mt-3 w-full">
                Continue
              </Button>
            ) : (
              <button
                onClick={afterSetup}
                className="mt-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Skip for now
              </button>
            )}
          </div>
        )}

        {step === 4 && (
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
                detail={`Shows ${thisComputer()}'s screen in the Computer panel when an agent works locally.`}
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
