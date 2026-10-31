// First-run setup, as a whole screen told in short beats, in the same
// language as making an agent: the stepper on top, the way on at the
// foot, each beat turning like a page.
//
//   1. engines: will this actually work on your machine
//   2. your agents: the work you do, and who that suggests
//   3. your name: what they call you, already filled in, once
//   4. approvals: how much they ask, shown rather than described
//   then, only when there is something to say: your setup from other
//   tools, your past conversations with them, and the Mac's own
//   permissions
//
// It ends on the team just made, and lands in the app with the first of
// them. The name is the one thing asked about you, and it is optional:
// it is asked again only when somebody else is about to see it
// (src/components/YourNameDialog). Everything is skippable: setup must
// never brick the app.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft } from "@/components/icons";
import { ArrowRight } from "@/components/icons";
import { Check } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Mic } from "@/components/icons";
import { Monitor } from "@/components/icons";
import { Plus } from "@/components/icons";
import { RefreshCw } from "@/components/icons";
import { BlockField, BloksLogo, BloksMark } from "./Brand";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { ProviderMark } from "./ProviderIcons";
import { api, useStore, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { setSetupDone, track } from "@/lib/analytics";
import { confirm } from "@/components/ui/confirm";
import { cn } from "@/lib/cn";
import { recommendedFor, WORK_TYPES } from "@/lib/recommend";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agentTemplates";
import { shapeForBot, type BlokColor, type BlokShape } from "@/lib/mascot";
import { ThisComputer, thisComputer } from "@/lib/thisComputer";
import { ApprovalsChooser, confirmWidening, type ApprovalMode } from "./ApprovalsChooser";
import { EngineSetupActions } from "./EngineSetup";
import { SetupPrivacyLine, SetupReviewList, useSetupReview } from "./BringYourSetup";
import { PastSessionsImport, PastSessionsPrivacyLine, usePastSessionPlaces } from "./PastSessions";
import { BeatHeading, BeatLabel, PreviewCard, Stepper, beat, settleEase } from "./Beats";
import { Input } from "@/components/ui/input";
import { firstName } from "@/lib/names";
import { readYourName, saveYourName } from "@/lib/yourName";
import { formatList, t, tr, useLanguage, type MessageKey } from "@/lib/i18n";

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

type Readiness = "checking" | "ready" | "signed-out" | "missing";

type StepId = "engines" | "agents" | "name" | "approvals" | "setup" | "history" | "permissions";

/** The numbers these steps have always reported as, so a funnel read
 * across this redesign still lines up. Work types and suggestions were
 * two steps and are one now; they report as the first of them. */
const STEP_NUMBER: Record<StepId, number> = { engines: 0, agents: 1, approvals: 2, permissions: 4, setup: 5, history: 6, name: 7 };

const isElectron = navigator.userAgent.includes("Electron");

// The engines worth naming on a first run, in the order somebody is most
// likely to already have one. Data rather than markup so the list can
// grow without the layout arguing about it.
const ENGINES: Array<{
  kind: string;
  name: string;
  command?: string;
  /** Connected by pasting a key in Settings, not by installing a CLI. */
  byKey?: boolean;
  /** What the card says once it is ready, and before. Keys, read where
   * the card draws. */
  have: MessageKey;
  want: MessageKey;
}> = [
  {
    kind: "claudeAgent",
    name: "Claude Code",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    have: "onboarding.engine.claudeAgent.have",
    want: "onboarding.engine.claudeAgent.want",
  },
  {
    kind: "codex",
    name: "Codex",
    command: "npm i -g --prefix ~/.local @openai/codex",
    have: "onboarding.engine.codex.have",
    want: "onboarding.engine.codex.want",
  },
  {
    kind: "cursor",
    name: "Cursor",
    command: "curl https://cursor.com/install -fsS | bash",
    have: "onboarding.engine.cursor.have",
    want: "onboarding.engine.cursor.want",
  },
  {
    kind: "pi",
    name: "Pi",
    command: "npm i -g --prefix ~/.local --ignore-scripts @earendil-works/pi-coding-agent pi-acp",
    have: "onboarding.engine.pi.have",
    want: "onboarding.engine.pi.want",
  },
  {
    kind: "antigravity",
    name: "Antigravity",
    command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    have: "onboarding.engine.antigravity.have",
    want: "onboarding.engine.antigravity.want",
  },
  {
    kind: "grokCli",
    name: "Grok CLI",
    command: "curl -fsSL https://x.ai/cli/install.sh | bash",
    have: "onboarding.engine.grokCli.have",
    want: "onboarding.engine.grokCli.want",
  },
  {
    kind: "cline",
    name: "Cline",
    command: "npm i -g --prefix ~/.local cline",
    have: "onboarding.engine.cline.have",
    want: "onboarding.engine.cline.want",
  },
  {
    kind: "devin",
    name: "Devin CLI",
    command: "curl -fsSL https://cli.devin.ai/install.sh | bash",
    have: "onboarding.engine.devin.have",
    want: "onboarding.engine.devin.want",
  },
  {
    kind: "kimi",
    name: "Kimi",
    byKey: true,
    have: "onboarding.engine.kimi.have",
    want: "onboarding.engine.kimi.want",
  },
];

/** Someone to stand in for "your agent" before there is one. */
const STAND_IN: { readonly name: string; color: BlokColor; shape: BlokShape } = {
  get name() {
    return t("onboarding.yourAgent");
  },
  color: "blue",
  shape: "star",
};

/**
 * The engines on this machine as the workspace sees them, asked again on
 * demand: what each one's state is, and whether any can reply at all.
 * Shared with a new workspace's welcome (src/components/WorkspaceWelcome),
 * which asks only when none can.
 */
export function useEngines() {
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const checkEngines = useCallback(() => {
    setChecking(true);
    return fetch("/api/instances")
      .then((r) => r.json())
      .then((d) => setInstances(d.instances ?? []))
      .catch(() => setInstances([]))
      .finally(() => setChecking(false));
  }, []);
  // signed out is not ready: it installs green and then fails the first
  // message, which is the setup problem this screen exists to catch
  const readiness = (kind: string): Readiness => {
    if (!instances) return "checking";
    const found = instances.find((i) => i.driverKind === kind);
    if (found?.snapshot.state !== "available") return "missing";
    return found.snapshot.authenticated === false ? "signed-out" : "ready";
  };
  // CLIs report themselves in their own words ("codex-cli 0.145.0",
  // "Grok CLI grok 1.0.4"), so only the number is taken from what they say
  const versionOf = (kind: string) => {
    const said = instances?.find((i) => i.driverKind === kind && i.snapshot.state === "available")?.snapshot.version;
    return said?.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
  };
  const ready = instances?.some((i) => i.snapshot.state === "available" && i.snapshot.authenticated !== false) ?? false;
  const readyEngine = ENGINES.find((e) => readiness(e.kind) === "ready");
  return { instances, checking, checkEngines, readiness, versionOf, ready, readyEngine };
}

/**
 * Adding recommended agents, each with its role already written. Two
 * pressed in quick succession can come back in either order; they are
 * kept in the order they were pressed, which is the order they were
 * wanted.
 */
export function useAgentHiring() {
  const [hiring, setHiring] = useState<string[]>([]);
  /** Who was added here, in the order they were, by template and by the
   * agent the server made. */
  const [hired, setHired] = useState<Array<{ template: string; bot: string }>>([]);
  const [hireNote, setHireNote] = useState<string | null>(null);
  const pressed = useRef<string[]>([]);
  const hire = (template: AgentTemplate) => {
    setHireNote(null);
    pressed.current = [...pressed.current.filter((id) => id !== template.id), template.id];
    setHiring((current) => [...current, template.id]);
    void api("/api/bots", {
      method: "POST",
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
      .then(({ bot }: { bot: Bot }) =>
        setHired((current) =>
          [...current, { template: template.id, bot: bot.id }].sort(
            (a, b) => pressed.current.indexOf(a.template) - pressed.current.indexOf(b.template),
          ),
        ),
      )
      .catch(() => setHireNote(t("onboarding.couldNotAdd", { name: template.name })))
      .finally(() => setHiring((current) => current.filter((id) => id !== template.id)));
  };
  return { hiring, hired, hireNote, hire };
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore();
  const [stage, setStage] = useState<StepId | "team">("engines");
  const { instances, checking, checkEngines, readiness, versionOf, ready, readyEngine } = useEngines();
  const { hiring, hired, hireNote, hire } = useAgentHiring();
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
  const [approvals, setApprovals] = useState<ApprovalMode>("ask");
  const [approvalsNote, setApprovalsNote] = useState<string | null>(null);
  const [savingApprovals, setSavingApprovals] = useState(false);
  /** What the person's other agent tools already know. The step that
   * offers it is only shown when there is something new to offer. */
  const setup = useSetupReview();
  const [brought, setBrought] = useState(false);
  // Once offered, the step stays: bringing things over empties what is
  // fresh, and the step should not vanish from under the person using it.
  const [offerSetup, setOfferSetup] = useState(false);
  const fresh = setup.review?.fresh ?? 0;
  useEffect(() => {
    if (fresh > 0) setOfferSetup(true);
  }, [fresh]);
  /** Whether Claude Code or Codex keep sessions on this Mac. Only that is
   * asked here: the sessions themselves are read when the step opens. */
  const places = usePastSessionPlaces();
  const offerHistory = Boolean(places?.claude || places?.codex);
  const [broughtHistory, setBroughtHistory] = useState(false);
  /** Asked only when this workspace has no name for its person yet: a
   * workspace made after one that had it was handed it by the app. Once
   * offered it stays, like the setup step, so saving it does not pull
   * the step from under the person. */
  const [offerName, setOfferName] = useState(false);
  const [name, setName] = useState("");
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  useEffect(() => {
    let alive = true;
    void readYourName().then(({ name: saved, suggested }) => {
      if (!alive || saved) return;
      setOfferName(true);
      setName((typed) => typed || suggested || "");
    });
    return () => {
      alive = false;
    };
  }, []);

  const language = useLanguage();
  const steps = useMemo(() => {
    const list: Array<{ id: StepId; label: string }> = [
      { id: "engines", label: t("onboarding.step.engines") },
      { id: "agents", label: t("onboarding.step.agents") },
      ...(offerName ? [{ id: "name" as const, label: t("common.yourName") }] : []),
      { id: "approvals", label: t("onboarding.step.approvals") },
    ];
    // Last of the agent steps, so the agents just added can be chosen as
    // where an imported memory goes.
    if (offerSetup) list.push({ id: "setup", label: t("onboarding.step.setup") });
    // after it, so the agents made by now can be where conversations go
    if (offerHistory) list.push({ id: "history", label: t("onboarding.step.history") });
    // only the desktop app can ask the Mac for these
    if (isElectron) list.push({ id: "permissions", label: t("onboarding.step.permissions") });
    return list;
  }, [offerSetup, offerHistory, offerName, language]);
  const at = stage === "team" ? steps.length : steps.findIndex((s) => s.id === stage);
  const next = () => setStage(steps[at + 1]?.id ?? "team");
  const back = () => {
    if (at > 0 && stage !== "team") setStage(steps[at - 1].id);
  };

  /** Kept when there is one; an empty field is a skip, not a refusal. */
  const chooseName = async () => {
    const clean = name.replace(/\s+/g, " ").trim();
    setNameNote(null);
    if (clean) {
      setSavingName(true);
      try {
        setName(await saveYourName(clean));
      } catch (e) {
        setSavingName(false);
        setNameNote(e instanceof Error ? e.message : String(e));
        return;
      }
      setSavingName(false);
    }
    next();
  };

  /** Where every agent starts, the ones just added included. */
  const chooseApprovals = async () => {
    setApprovalsNote(null);
    if (!(await confirmWidening("ask", approvals, t("onboarding.yourAgents")))) {
      setApprovalsNote(t("onboarding.approvalsNotConfirmed"));
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
    next();
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
    // Nothing is deleted, so it is not drawn as destructive, but Bloks
    // restarts, which is reason enough to ask
    const yes = await confirm({
      title: t("onboarding.startFreshTitle"),
      body: t("onboarding.startFreshBody"),
      confirmLabel: t("onboarding.startFresh"),
    });
    if (!yes) return;
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
      // the server's reason as it gave it, inside our own sentence
      setResetNote(t("onboarding.resetFailed", { reason: body?.error ?? t("onboarding.resetFailedReason") }));
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
    setResetNote(t("onboarding.resetRestart"));
  };

  // a new beat starts at its top
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    // Reaching the setup or history step would say another tool was found
    // here, and those screens promise nothing about the person leaves.
    if (stage !== "team" && stage !== "setup" && stage !== "history") track("setup_step", { step: STEP_NUMBER[stage] });
    if (stage === "engines") {
      void checkEngines();
      // the user may install a CLI in another window and come back
      const timer = setInterval(checkEngines, 5000);
      return () => clearInterval(timer);
    }
    if (stage === "permissions" && isElectron) {
      const poll = () => window.bloks?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      const timer = setInterval(poll, 2000);
      return () => clearInterval(timer);
    }
  }, [stage, checkEngines]);

  /**
   * Out of setup, by one of three doors: into the chat of someone just
   * made, into the agent picker, or straight into the app.
   *
   * The picker is for somebody who made nobody here. Choosing a role is
   * what teaches that agents have jobs, the one idea the rest of the
   * product rests on, so the last beat offers it before anything else.
   * Skipping goes straight in: Nova is seeded on the server and already
   * waiting, and someone who said "not now" meant it.
   */
  const finish = (then: { select: string } | "picker" | "app") => {
    track("setup_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
      screen: perms?.screen ?? "n/a",
    });
    setSetupDone();
    onDone();
    if (then === "picker") dispatch({ type: "toggleNewAgent", open: true, firstRun: true });
    else if (typeof then === "object") dispatch({ type: "select", id: then.select });
  };

  // The agents someone has, as the last beat shows them: the ones made
  // here first, in the order they were, then anyone already waiting.
  const team = useMemo(() => {
    const shown = state.bots.filter((b) => !b.hidden && !b.archivedAt);
    const order = new Map(hired.map((h, i) => [h.bot, i]));
    return [...shown].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  }, [state.bots, hired]);
  // who the approvals sample is about: the first one added, else whoever
  // is already here
  const firstHired = AGENT_TEMPLATES.find((role) => role.id === hired[0]?.template);
  const sampleAgent = firstHired ?? team[0] ?? STAND_IN;

  // A first boot seeds one agent that says hello, so "is anything here"
  // would greet every new install with "welcome back". What marks a real
  // workspace is that somebody has spoken in it, or built more than the
  // seed.
  const returning = stage === "engines" && prior && (prior.mine > 0 || prior.agents > 1 || prior.rooms > 0);

  return (
    <div
      // Opaque from the first frame: the app is already drawn underneath,
      // and a screen that fades in shows it through. Only the beat rises.
      className="fixed inset-0 z-50 flex flex-col bg-background"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        back();
      }}
    >
      <BlockField />

      {/* Top bar. In the desktop shell this screen covers the whole
          frameless window, so the leading control starts to the right of
          the traffic lights and the row is marked no-drag, or its buttons
          would sit in the window's drag strip and never take a click. */}
      <div
        className={cn("relative z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3", isElectron && "pl-24 pt-9")}
        style={isElectron ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
        <div className="justify-self-start">
          {at > 0 && stage !== "team" ? (
            <Button variant="ghost" onClick={back} aria-label={t("common.back")} className="max-sm:px-2">
              <ArrowLeft size={15} />
              <span className="max-sm:hidden">{t("common.back")}</span>
            </Button>
          ) : returning ? null : (
            <span className="flex h-8 items-center px-2">
              <BloksMark size={22} />
            </span>
          )}
        </div>
        {returning ? (
          <span />
        ) : (
          <Stepper
            steps={steps}
            step={stage === "team" ? steps[0].id : stage}
            complete={stage === "team"}
            // only back: going forward is always through the step's own
            // Continue, which is where its choice is saved
            isOpen={(i) => i < at}
            onGo={setStage}
            layoutId="onboarding-step"
          />
        )}
        <div className="justify-self-end">
          {stage !== "team" && !returning && (
            <Button variant="ghost" onClick={() => finish("app")} className="max-sm:px-2">
              <span className="max-sm:hidden">{t("common.skipForNow")}</span>
              <span className="sm:hidden">{t("onboarding.skip")}</span>
            </Button>
          )}
        </div>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {returning ? (
            <motion.div key="returning" {...beat}>
              <WelcomeBack
                prior={prior}
                resetting={resetting}
                resetNote={resetNote}
                onContinue={() => setPrior(null)}
                onStartFresh={() => void startFresh()}
              />
            </motion.div>
          ) : stage === "engines" ? (
            <motion.div key="engines" {...beat}>
              <EnginesBeat readiness={readiness} versionOf={versionOf} ready={ready} loaded={instances !== null} onChanged={() => void checkEngines()} />
            </motion.div>
          ) : stage === "agents" ? (
            <motion.div key="agents" {...beat}>
              <AgentsBeat work={work} setWork={setWork} hired={hired} hiring={hiring} onHire={hire} />
            </motion.div>
          ) : stage === "name" ? (
            <motion.div key="name" {...beat}>
              <NameBeat name={name} onChange={(value) => {
                setNameNote(null);
                setName(value);
              }} onSubmit={() => void chooseName()} agent={sampleAgent} />
            </motion.div>
          ) : stage === "approvals" ? (
            <motion.div key="approvals" {...beat}>
              <ApprovalsBeat
                value={approvals}
                onChange={(mode) => {
                  setApprovalsNote(null);
                  setApprovals(mode);
                }}
                agent={sampleAgent}
              />
            </motion.div>
          ) : stage === "setup" && setup.review ? (
            <motion.div key="setup" {...beat}>
              <Column>
                <BeatHeading
                  title={t("onboarding.bringYourSetup")}
                  says={(() => {
                    const sources = formatList(setup.review.sources.map((source) => source.name), { type: "unit", style: "short" });
                    return setup.where && !setup.where.here
                      ? t("onboarding.foundOn", { computer: setup.where.computer, sources })
                      : t("onboarding.found", { sources });
                  })()}
                />
                <SetupPrivacyLine where={setup.where} />
                <div className="mt-6">
                  <SetupReviewList
                    review={setup.review}
                    onReview={setup.set}
                    compact
                    onImported={({ brought: count }) => {
                      if (count) setBrought(true);
                    }}
                  />
                </div>
              </Column>
            </motion.div>
          ) : stage === "history" ? (
            <motion.div key="history" {...beat}>
              <Column>
                <BeatHeading
                  title={t("onboarding.bringYourPastConversations")}
                  says={t("onboarding.historySays", {
                    tools: formatList([places?.claude ? "Claude Code" : "", places?.codex ? "Codex" : ""].filter(Boolean)),
                  })}
                />
                <PastSessionsPrivacyLine />
                <div className="mt-6">
                  <PastSessionsImport
                    compact
                    onImported={(count) => {
                      if (count) setBroughtHistory(true);
                    }}
                  />
                </div>
              </Column>
            </motion.div>
          ) : stage === "permissions" ? (
            <motion.div key="permissions" {...beat}>
              <PermissionsBeat perms={perms} setPerms={setPerms} />
            </motion.div>
          ) : stage === "team" ? (
            <motion.div key="team" {...beat}>
              <TeamBeat team={team} hired={hired.map((h) => h.bot)} onFinish={finish} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* The way on, always in the same place: what this beat comes to on
          the left, the next step on the right. */}
      {!returning && stage !== "team" && (
        <div className="relative z-10 border-t bg-background/85 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-[1080px] items-center gap-2 px-5 py-3 sm:px-8">
            {stage === "engines" && (
              <>
                <span className="mr-auto flex min-w-0 items-center gap-2 text-body">
                  <ReadyDot state={!instances ? "checking" : ready ? "ready" : "missing"} />
                  <span className={cn("truncate", instances && !ready ? "text-warning" : "text-muted-foreground")}>
                    {!instances
                      ? t("onboarding.lookingForEngines")
                      : readyEngine
                        ? t("onboarding.nameIsReady", { name: readyEngine.name })
                        : t("onboarding.noEngineReadyYetAgents")}
                  </span>
                </span>
                <Button variant="ghost" size="lg" onClick={() => void checkEngines()} className="max-sm:px-3" aria-label={t("common.checkAgain")}>
                  <RefreshCw size={14} className={cn(checking && "animate-spin")} />
                  <span className="max-sm:hidden">{t("common.checkAgain")}</span>
                </Button>
                <Button size="lg" onClick={next}>
                  {ready || !instances ? t("common.continue") : t("onboarding.continueAnyway")}
                  <ArrowRight size={15} />
                </Button>
              </>
            )}
            {stage === "agents" && (
              <>
                <span className={cn("mr-auto flex min-w-0 items-center gap-2.5 text-body", hireNote ? "text-destructive" : "text-muted-foreground")}>
                  {hired.length > 0 && !hireNote && (
                    <span className="flex shrink-0 items-center">
                      {hired.map((h, i) => {
                        const role = AGENT_TEMPLATES.find((x) => x.id === h.template);
                        return role ? (
                          <motion.span
                            key={h.bot}
                            initial={{ scale: 0.6, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: "spring", duration: 0.3, bounce: 0.35 }}
                            className={cn("rounded-[8px] ring-2 ring-background", i > 0 && "-ml-1.5")}
                          >
                            <BlokAvatar color={role.color} shape={role.shape} expression="friendly" size={24} />
                          </motion.span>
                        ) : null;
                      })}
                    </span>
                  )}
                  <span className={cn("truncate", !hireNote && !hired.length && "max-sm:invisible")}>
                    {hireNote ??
                      (hired.length
                        ? t("onboarding.namesAdded", {
                            names: namesOf(hired.map((h) => AGENT_TEMPLATES.find((role) => role.id === h.template)?.name ?? t("common.anAgent"))),
                          })
                        : t("onboarding.addAnyThatFitYou"))}
                  </span>
                </span>
                <Button size="lg" onClick={next} disabled={hiring.length > 0}>
                  {t("common.continue")}
                  <ArrowRight size={15} />
                </Button>
              </>
            )}
            {stage === "name" && (
              <>
                <span className={cn("mr-auto min-w-0 truncate text-body", nameNote ? "text-destructive" : "text-muted-foreground max-sm:invisible")}>
                  {nameNote ?? t("onboarding.optionalChangeItAnyTime")}
                </span>
                <Button variant="ghost" size="lg" onClick={next} disabled={savingName}>
                  {t("onboarding.skipThis")}
                </Button>
                <Button size="lg" disabled={savingName} onClick={() => void chooseName()}>
                  {savingName && <Loader2 size={15} className="animate-spin" />}
                  {t("common.continue")}
                  <ArrowRight size={15} />
                </Button>
              </>
            )}
            {stage === "approvals" && (
              <>
                <span className={cn("mr-auto min-w-0 truncate text-body", approvalsNote ? "text-warning" : "text-muted-foreground max-sm:invisible")}>
                  {approvalsNote ?? t("onboarding.youCanChangeThisAny")}
                </span>
                <Button size="lg" disabled={savingApprovals} onClick={() => void chooseApprovals()}>
                  {savingApprovals && <Loader2 size={15} className="animate-spin" />}
                  {t("common.continue")}
                  <ArrowRight size={15} />
                </Button>
              </>
            )}
            {stage === "setup" && (
              <>
                <span className="mr-auto min-w-0 truncate text-body text-muted-foreground max-sm:invisible">
                  {t("onboarding.everythingHereIsInSettings")}
                </span>
                {brought ? (
                  <Button size="lg" onClick={next}>
                    {t("common.continue")}
                    <ArrowRight size={15} />
                  </Button>
                ) : (
                  <Button variant="ghost" size="lg" onClick={next}>
                    {t("onboarding.skipThis")}
                  </Button>
                )}
              </>
            )}
            {stage === "history" && (
              <>
                <span className="mr-auto min-w-0 truncate text-body text-muted-foreground max-sm:invisible">
                  {t("onboarding.thisIsInSettingsToo")}
                </span>
                {broughtHistory ? (
                  <Button size="lg" onClick={next}>
                    {t("common.continue")}
                    <ArrowRight size={15} />
                  </Button>
                ) : (
                  <Button variant="ghost" size="lg" onClick={next}>
                    {t("onboarding.skipThis")}
                  </Button>
                )}
              </>
            )}
            {stage === "permissions" && (
              <>
                <span className="mr-auto min-w-0 truncate text-body text-muted-foreground max-sm:invisible">
                  {t("onboarding.allOptionalNothingIsUsed")}
                </span>
                <Button size="lg" onClick={next}>
                  {t("common.continue")}
                  <ArrowRight size={15} />
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "A", "A and B", "A, B, and C", with the reader's own "and". */
export function namesOf(names: string[]): string {
  return formatList(names);
}

/** A single column, for the beats that have nothing to show beside them. */
export function Column({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[720px] px-5 pb-12 pt-4 sm:px-8 lg:pt-10">{children}</div>;
}

/** The small light that says where an engine stands. It lands, rather
 * than blinks, when the poll finds something has changed. */
export function ReadyDot({ state }: { state: Readiness }) {
  return (
    <span className="relative flex size-2 shrink-0">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={state}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.4, opacity: 0 }}
          transition={{ type: "spring", duration: 0.28, bounce: 0.4 }}
          className={cn(
            "absolute inset-0 rounded-full",
            state === "ready" ? "bg-success" : state === "signed-out" ? "bg-warning" : state === "checking" ? "animate-pulse bg-muted-foreground/40" : "bg-muted-foreground/40",
          )}
        />
      </AnimatePresence>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Somebody who already has a workspace here: a previous install, or a copy
// carried across from another Mac. Dropping them into it unannounced reads
// as "the app came with a stranger's data", and wiping it unasked is
// worse. So: say what is here, and let them choose.

function WelcomeBack({
  prior,
  resetting,
  resetNote,
  onContinue,
  onStartFresh,
}: {
  prior: { agents: number; rooms: number; messages: number };
  resetting: boolean;
  resetNote: string | null;
  onContinue: () => void;
  onStartFresh: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col items-center px-5 pb-12 pt-[12vh] text-center">
      <BloksLogo />
      <h1 className="mt-8 text-balance text-display font-semibold text-foreground">{t("onboarding.welcomeBack")}</h1>
      <p className="mt-2 text-pretty text-ui text-muted-foreground">
        {t("onboarding.priorWorkspace", {
          computer: ThisComputer(),
          contents: formatList([
            t("onboarding.prior.agents", { count: prior.agents }),
            ...(prior.rooms > 0 ? [t("onboarding.prior.rooms", { count: prior.rooms })] : []),
            t("onboarding.prior.messages", { count: prior.messages }),
          ]),
        })}
      </p>
      <div className="mt-8 flex w-full flex-col gap-2">
        <Button size="lg" onClick={onContinue} disabled={resetting}>
          {t("onboarding.continueWhereILeftOff")}
        </Button>
        <Button size="lg" variant="secondary" onClick={onStartFresh} disabled={resetting}>
          {resetting ? t("onboarding.startingFresh") : t("onboarding.startFresh")}
        </Button>
      </div>
      {resetNote ? (
        <p className="mt-4 text-small leading-relaxed text-warning">{resetNote}</p>
      ) : (
        <p className="mt-4 text-small leading-relaxed text-muted-foreground">
          {t("onboarding.startingFreshMovesTheOld")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat one: engines. A live panel rather than a checklist: each engine
// lights up as the poll finds it, so installing one in another window
// and coming back shows it arriving.

export function EnginesBeat({
  readiness,
  versionOf,
  ready,
  loaded,
  onChanged,
}: {
  readiness: (kind: string) => Readiness;
  versionOf: (kind: string) => string | null;
  ready: boolean;
  loaded: boolean;
  onChanged: () => void;
}) {
  // The large card is Claude Code, the engine Bloks is built around, as
  // long as it is here at all: signed out is one button from ready. Only
  // when it is missing and another engine is ready does that one take the
  // card, since that is what agents will actually run on.
  const preferred = ENGINES[0];
  const lead =
    readiness(preferred.kind) === "missing" ? (ENGINES.find((e) => readiness(e.kind) === "ready") ?? preferred) : preferred;
  const more = ENGINES.filter((e) => e !== lead);
  return (
    <Column>
      <BeatHeading
        title={t("onboarding.letsCheckYourEngines")}
        says={t("onboarding.enginesSays", { computer: thisComputer() })}
      />
      <EngineCard engine={lead} state={readiness(lead.kind)} version={versionOf(lead.kind)} onChanged={onChanged} large />

      <section className="mt-10">
        <BeatLabel aside={<span className="text-small text-muted-foreground">{t("onboarding.optional")}</span>}>{t("onboarding.moreEngines")}</BeatLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {more.map((engine, i) => (
            <motion.div
              key={engine.kind}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 6) * 0.03, duration: 0.22, ease: settleEase }}
            >
              <EngineCard engine={engine} state={readiness(engine.kind)} version={versionOf(engine.kind)} onChanged={onChanged} />
            </motion.div>
          ))}
        </div>
      </section>

      {loaded && !ready && (
        // a CLI is the best engine, not the only one: without any of them
        // there is still a way in
        <p className="mt-6 text-pretty text-body leading-relaxed text-muted-foreground">
          {t("onboarding.noneOfTheseContinueAnd")}
        </p>
      )}
    </Column>
  );
}

/** One engine: where it stands, and the button that gets it to ready. */
function EngineCard({
  engine,
  state,
  version,
  onChanged,
  large = false,
}: {
  engine: (typeof ENGINES)[number];
  state: Readiness;
  version: string | null;
  onChanged: () => void;
  large?: boolean;
}) {
  const lit = state === "ready";
  const detail =
    state === "checking"
      ? t("onboarding.lookingOnThisComputer")
      : state === "ready"
        ? t(engine.have)
        : state === "signed-out"
          ? t("onboarding.installedSignIn")
          : t(engine.want);
  return (
    <div
      className={cn(
        "h-full rounded-2xl border bg-card",
        large ? "rounded-3xl p-5 shadow-[0_12px_40px_-16px_var(--shadow-color)] sm:p-6" : "p-3.5",
      )}
    >
      <div className={cn("flex items-center", large ? "gap-4" : "gap-3")}>
        <span className={cn("relative flex shrink-0 items-center justify-center bg-muted", large ? "size-12 rounded-2xl sm:size-14" : "size-9 rounded-xl")}>
          {/* the mark comes up to full strength as the engine does */}
          <span className={cn("transition-opacity duration-300", lit ? "opacity-100" : "opacity-45")}>
            <EngineMark kind={engine.kind} size={large ? 28 : 18} />
          </span>
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 ring-2 ring-success/45 transition-opacity duration-300",
              large ? "rounded-2xl" : "rounded-xl",
              lit ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate font-semibold text-foreground", large ? "text-title tracking-tight" : "text-ui")}>{engine.name}</span>
            {version && <span className={cn("shrink-0 font-mono text-caption text-muted-foreground", large && "max-sm:hidden")}>{version}</span>}
          </div>
          <div className={cn("text-pretty leading-relaxed text-muted-foreground", large ? "mt-0.5 text-body" : "text-small")}>{detail}</div>
        </div>
        <StatusPill state={state} large={large} />
      </div>
      {(state === "missing" || state === "signed-out") && (
        <div className={cn(large && "sm:pl-[72px]")}>
          <EngineSetupActions
            kind={engine.kind}
            name={engine.name}
            installed={state === "signed-out"}
            signedOut={state === "signed-out"}
            fallback={engine.command}
            onChanged={onChanged}
          />
        </div>
      )}
    </div>
  );
}

/** Antigravity has no mark of its own in the set, and two capitals read
 * as a glitch, so it gets the one letter a tile like this would carry. */
function EngineMark({ kind, size }: { kind: string; size: number }) {
  if (kind === "antigravity") {
    return (
      <span className="flex items-center justify-center font-semibold text-foreground" style={{ width: size, height: size, fontSize: size * 0.62 }}>
        A
      </span>
    );
  }
  return <ProviderMark driverKind={kind} size={size} />;
}

function StatusPill({ state, large }: { state: Readiness; large?: boolean }) {
  const label =
    state === "ready"
      ? t("onboarding.status.ready")
      : state === "signed-out"
        ? t("onboarding.status.signIn")
        : state === "checking"
          ? t("onboarding.status.checking")
          : t("onboarding.status.notInstalled");
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={state}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: "spring", duration: 0.3, bounce: 0.35 }}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium",
          large ? "text-small" : "text-caption",
          state === "ready"
            ? "bg-success/10 text-success"
            : state === "signed-out"
              ? "bg-warning/10 text-warning"
              : "bg-muted text-muted-foreground",
          // a quiet row says nothing at all while it is merely optional
          !large && state === "missing" && "max-sm:hidden",
        )}
      >
        {state === "ready" && <Check size={11} strokeWidth={3} />}
        {state === "checking" && <Loader2 size={11} className="animate-spin" />}
        {label}
      </motion.span>
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Beat two: your agents. Naming the work is a far easier question than
// inventing an agent from nothing, and the answer is enough to propose
// three that are obviously useful rather than merely available. So the
// question and its answer sit on one page, and the answer changes as the
// question does.

export function AgentsBeat({
  work,
  setWork,
  hired,
  hiring,
  onHire,
  title = t("onboarding.agentsTitle"),
  says = t("onboarding.agentsSays"),
}: {
  work: string[];
  setWork: (update: (current: string[]) => string[]) => void;
  hired: Array<{ template: string; bot: string }>;
  hiring: string[];
  onHire: (template: AgentTemplate) => void;
  /** A new workspace asks about the work done there, not about you. */
  title?: string;
  says?: string;
}) {
  const suggested = recommendedFor(work, 3)
    .map((id) => AGENT_TEMPLATES.find((role) => role.id === id))
    .filter((role): role is AgentTemplate => Boolean(role));
  return (
    <div className="mx-auto w-full max-w-[1080px] px-5 pb-12 pt-4 sm:px-8 lg:pt-10">
      <div className="max-w-[720px]">
        <BeatHeading title={title} says={says} />
      </div>
      <div role="group" aria-label={t("onboarding.kindsOfWork")} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {WORK_TYPES.map((option) => {
          const on = work.includes(option.id);
          return (
            <button
              key={option.id}
              aria-pressed={on}
              onClick={() => setWork((current) => (on ? current.filter((id) => id !== option.id) : [...current, option.id]))}
              className={cn(
                "group relative flex min-w-0 flex-col rounded-xl border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.985]",
                on ? "border-brand bg-brand-soft" : "bg-card hover:border-foreground/20 hover:bg-accent/40",
              )}
            >
              <span className="pr-5 text-body font-medium text-foreground">{option.label}</span>
              <span className="line-clamp-2 text-small text-muted-foreground">{option.hint}</span>
              <span
                className={cn(
                  "absolute right-2.5 top-2.5 flex size-4 items-center justify-center rounded-full border transition-colors duration-150",
                  on ? "border-brand-ink bg-brand-ink text-brand-foreground" : "border-foreground/20",
                )}
              >
                {on && <Check size={10} strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>

      <section className="mt-10">
        <BeatLabel aside={<span className="text-small text-muted-foreground max-sm:hidden">{t("onboarding.eachComesWithItsRole")}</span>}>
          {work.length ? t("onboarding.suggestedForYou") : t("onboarding.aGoodPlaceToStart")}
        </BeatLabel>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {suggested.map((template) => {
              const added = hired.some((h) => h.template === template.id);
              const adding = hiring.includes(template.id);
              return (
                <motion.div
                  key={template.id}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.22, ease: settleEase }}
                >
                  <PreviewCard
                    compact
                    identity={{ color: template.color, shape: template.shape }}
                    name={template.name}
                    title={template.title}
                    greeting={template.greeting}
                    skills={template.skills}
                    creating={adding}
                    footer={
                      added ? (
                        <div className="flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-soft text-ui font-medium text-brand-ink">
                          <Check size={15} strokeWidth={2.5} />
                          {t("onboarding.added")}
                        </div>
                      ) : (
                        <Button variant="secondary" size="lg" className="w-full" disabled={adding} onClick={() => onHire(template)}>
                          {adding ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                          {adding ? t("onboarding.adding") : t("onboarding.addName", { name: template.name })}
                        </Button>
                      )
                    }
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your name: what your agents call you. Filled in already with the name
// this computer's account carries, so for most people it is one press of
// Continue; a wrong guess is selected, so typing replaces it. Shown as
// the first agent will say it, which is what the name is for.

function NameBeat({
  name,
  onChange,
  onSubmit,
  agent,
}: {
  name: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
  agent: { name: string; color: BlokColor; shape?: BlokShape };
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      field.current?.focus();
      field.current?.select();
    }, 120);
    return () => clearTimeout(timer);
  }, []);
  const first = firstName(name.replace(/\s+/g, " ").trim());
  return (
    <div className="mx-auto grid w-full max-w-[1080px] grid-cols-1 gap-8 px-5 pb-12 pt-4 sm:px-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14 lg:pt-10">
      <div className="min-w-0">
        <BeatHeading
          title={t("onboarding.whatShouldYourAgentsCall")}
          says={t("onboarding.theyUseItWhenThey")}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label className="flex max-w-[420px] flex-col gap-2">
            <span className="text-small font-medium text-muted-foreground">{t("common.yourName")}</span>
            <Input
              ref={field}
              value={name}
              maxLength={40}
              autoComplete="name"
              placeholder={t("common.yourName")}
              onChange={(e) => onChange(e.target.value)}
              className="h-11 rounded-[12px] text-lead"
            />
          </label>
        </form>
      </div>
      <aside aria-label={t("onboarding.howItWillRead")}>
        <div className="lg:sticky lg:top-6">
          <div className="overflow-hidden rounded-3xl border bg-card shadow-[0_12px_40px_-16px_var(--shadow-color)]">
            <div className="px-5 pb-5 pt-5">
              <div className="text-small font-medium text-muted-foreground">{t("onboarding.howItWillRead")}</div>
              <div className="mt-3 flex items-end gap-2">
                <BlokAvatar color={agent.color} shape={agent.shape ?? "star"} expression="friendly" size={22} />
                <div className="min-w-0 rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-body leading-relaxed text-foreground">
                  {first ? (
                    tr("onboarding.goodToMeetYouName", { name: <span className="font-semibold">{first}</span> })
                  ) : (
                    t("onboarding.goodToMeetYouTell")
                  )}
                </div>
              </div>
              <div className="mt-1 pl-[30px] text-caption text-muted-foreground">{agent.name}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat four: approvals. Asked once, up front, because the default decides
// how the first hour feels: a card for everything, or agents that get on
// with it. Every agent starts on the choice, so it is shown landing on a
// small task rather than described in the abstract.

type SampleStep = { id: string; asks: MessageKey; did: MessageKey; when: ApprovalMode[] };

/** One small job, and which of its steps stop to ask in each mode. The
 * words are keys, read where the sample draws. */
const SAMPLE: SampleStep[] = [
  { id: "read", asks: "onboarding.sample.readFiles", did: "onboarding.sample.readFiles", when: [] },
  { id: "edit", asks: "onboarding.sample.editNotes", did: "onboarding.sample.editedNotes", when: ["ask"] },
  { id: "run", asks: "onboarding.sample.runTests", did: "onboarding.sample.ranTests", when: ["ask", "edits"] },
];

const SAMPLE_SAYS: Record<ApprovalMode, MessageKey> = {
  ask: "onboarding.sample.says.ask",
  edits: "onboarding.sample.says.edits",
  auto: "onboarding.sample.says.auto",
  full: "onboarding.sample.says.full",
};

function ApprovalsBeat({
  value,
  onChange,
  agent,
}: {
  value: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  agent: { name: string; color: BlokColor; shape?: BlokShape };
}) {
  return (
    <div className="mx-auto grid w-full max-w-[1080px] grid-cols-1 gap-8 px-5 pb-12 pt-4 sm:px-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14 lg:pt-10">
      <div className="min-w-0">
        <BeatHeading title={t("onboarding.howMuchShouldYourAgents")} says={t("onboarding.whereEveryAgentStartsChange")} />
        <ApprovalsChooser value={value} onChange={onChange} />
      </div>
      <aside aria-label={t("onboarding.whatYouWouldSee")}>
        <div className="lg:sticky lg:top-6">
          <ApprovalSample mode={value} agent={agent} />
        </div>
      </aside>
    </div>
  );
}

/** The chosen mode, played out: the same small job, with the steps that
 * would stop for you drawn as the card you would get in the chat. */
function ApprovalSample({ mode, agent }: { mode: ApprovalMode; agent: { name: string; color: BlokColor; shape?: BlokShape } }) {
  return (
    <div className="overflow-hidden rounded-3xl border bg-card shadow-[0_12px_40px_-16px_var(--shadow-color)]">
      <div className="px-5 pb-5 pt-5">
        <div className="text-small font-medium text-muted-foreground">{t("onboarding.whatYouWouldSee")}</div>
        <div className="mt-3 flex items-end gap-2">
          <BlokAvatar color={agent.color} shape={agent.shape ?? "star"} expression="friendly" size={22} />
          <div className="min-w-0 rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-body leading-relaxed text-foreground">
            {t("onboarding.illTidyNotesMdAnd")}
          </div>
        </div>
        <div className="mt-1 pl-[30px] text-caption text-muted-foreground">{agent.name}</div>

        <ol className="mt-4 flex flex-col gap-2">
          <AnimatePresence initial={false} mode="popLayout">
            {SAMPLE.map((step) => {
              const asks = step.when.includes(mode);
              return (
                <motion.li
                  key={`${step.id}-${asks ? "asks" : "did"}`}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.2, ease: settleEase }}
                >
                  {asks ? (
                    // drawn like the approval card in the chat, without
                    // the buttons doing anything: this is a picture of it
                    <div className="rounded-2xl border bg-card p-3 shadow-[0_1px_3px_var(--shadow-color)]">
                      <div className="text-caption font-semibold uppercase tracking-[0.1em] text-warning">{t("onboarding.approval")}</div>
                      <div className="mt-0.5 text-ui font-semibold text-foreground">{t(step.asks)}</div>
                      <div aria-hidden className="mt-2 flex gap-1.5">
                        {[t("onboarding.sample.allow"), t("onboarding.sample.deny")].map((option, i) => (
                          <span key={option} className="flex flex-1 items-center gap-2 rounded-lg bg-muted/70 px-2 py-1 text-small text-foreground">
                            <span className="flex size-4 items-center justify-center rounded bg-background text-micro font-semibold text-muted-foreground">
                              {i === 0 ? "A" : "B"}
                            </span>
                            {option}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2.5 px-1 text-body text-muted-foreground">
                      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                        <Check size={10} strokeWidth={3} />
                      </span>
                      {t(step.did)}
                      {step.id === "run" && mode === "auto" && <span className="text-small text-muted-foreground/80">{t("onboarding.inTheSandbox")}</span>}
                    </div>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      </div>
      <div
        className={cn(
          "border-t px-5 py-3 text-small leading-relaxed transition-colors duration-150",
          mode === "full" ? "bg-warning/10 text-warning" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {t(SAMPLE_SAYS[mode])}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Mac's own permissions, in the desktop app only.

function PermissionsBeat({
  perms,
  setPerms,
}: {
  perms: { mic: string; screen: string } | null;
  setPerms: (perms: { mic: string; screen: string }) => void;
}) {
  return (
    <Column>
      <BeatHeading title={t("onboarding.twoPermissions")} says={t("onboarding.allOptionalNothingIsUsed")} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PermissionCard
          icon={<Mic size={20} />}
          title={t("onboarding.microphoneAndSpeech")}
          detail={t("onboarding.dictateMessagesTranscribedOnDevice")}
          status={perms?.mic}
          onEnable={() => window.bloks?.permRequestMic?.().then(() => window.bloks?.permStatus?.().then(setPerms))}
          onOpenSettings={() => window.bloks?.permOpenSettings?.("mic")}
        />
        <PermissionCard
          icon={<Monitor size={20} />}
          title={t("onboarding.screenPreview")}
          detail={t("onboarding.screenPreviewDetail", { computer: thisComputer() })}
          status={perms?.screen}
          onEnable={() =>
            navigator.mediaDevices
              .getDisplayMedia({ video: true })
              .then((stream) => stream.getTracks().forEach((track) => track.stop()))
              .catch(() => {})
              .then(() => window.bloks?.permStatus?.().then(setPerms))
          }
          onOpenSettings={() => window.bloks?.permOpenSettings?.("screen")}
        />
      </div>
    </Column>
  );
}

function PermissionCard({
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
  const granted = status === "granted";
  return (
    <div className="flex flex-col rounded-2xl border bg-card p-4">
      <span className={cn("flex size-10 items-center justify-center rounded-xl", granted ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
        {icon}
      </span>
      <div className="mt-3 text-ui font-medium text-foreground">{title}</div>
      <div className="mt-0.5 flex-1 text-pretty text-body leading-relaxed text-muted-foreground">{detail}</div>
      <div className="mt-4">
        {granted ? (
          <span className="inline-flex h-7 items-center gap-1.5 text-body font-medium text-success">
            <Check size={14} strokeWidth={2.5} />
            {t("onboarding.allowed")}
          </span>
        ) : status === "denied" || status === "restricted" ? (
          <Button variant="secondary" size="sm" onClick={onOpenSettings}>
            {t("onboarding.openSettings")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onEnable}>
            {t("onboarding.enable")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The end: the team, each face landing in turn, and the door into the app.

function TeamBeat({
  team,
  hired,
  onFinish,
}: {
  team: Bot[];
  hired: string[];
  onFinish: (then: { select: string } | "picker" | "app") => void;
}) {
  const shown = team.slice(0, 6);
  const made = hired.map((id) => team.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));
  const first = made[0];
  const nova = team[0];
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => go.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col items-center px-5 pb-12 pt-[14vh] text-center sm:px-8">
      <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-5">
        {shown.map((bot, i) => (
          <motion.div
            key={bot.id}
            initial={{ opacity: 0, y: 14, scale: 0.7 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", duration: 0.5, bounce: 0.4, delay: 0.08 + i * 0.09 }}
            className="flex w-[112px] flex-col items-center"
          >
            {/* glad to be here: a photo stays a photo, a face smiles. The
                faces share a baseline, whatever their size. */}
            <span className="flex h-[72px] items-end">
              {bot.avatarAt ? (
                <AgentAvatar bot={bot} size={i === 0 && first ? 72 : 60} />
              ) : (
                <BlokAvatar color={bot.color} shape={shapeForBot(bot)} expression="friendly" size={i === 0 && first ? 72 : 60} />
              )}
            </span>
            <div className="mt-2 line-clamp-2 w-full text-balance text-body font-medium text-foreground">{bot.name}</div>
            {bot.title && <div className="line-clamp-2 w-full text-small text-muted-foreground">{bot.title}</div>}
          </motion.div>
        ))}
        {team.length > shown.length && (
          <div className="flex h-[72px] items-end pb-5 text-body text-muted-foreground">+{team.length - shown.length}</div>
        )}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.26, ease: settleEase, delay: 0.12 + shown.length * 0.09 }}
        className="flex w-full flex-col items-center"
      >
        <h1 className="mt-10 text-balance text-display font-semibold text-foreground">
          {first ? t("onboarding.meetYourTeam") : nova ? t("onboarding.nameIsReady", { name: nova.name }) : t("onboarding.youreAllSet")}
        </h1>
        <p className="mt-2 max-w-[460px] text-pretty text-ui text-muted-foreground">
          {first
            ? made.length === 1
              ? t("onboarding.oneReady", { name: first.name })
              : t("onboarding.manyReady", { names: namesOf(made.map((b) => b.name)) })
            : nova
              ? t("onboarding.novaCanHelp", { name: nova.name })
              : t("onboarding.giveAnAgentAJob")}
        </p>
        <div className="mt-8 flex w-full max-w-[320px] flex-col gap-2">
          {first ? (
            <Button ref={go} size="lg" variant="brand" onClick={() => onFinish({ select: first.id })}>
              {t("onboarding.sayHiTo", { name: first.name })}
              <ArrowRight size={15} />
            </Button>
          ) : (
            <>
              <Button ref={go} size="lg" variant="brand" onClick={() => onFinish("picker")}>
                {t("onboarding.makeYourFirstAgent")}
                <ArrowRight size={15} />
              </Button>
              {nova && (
                <Button size="lg" variant="ghost" onClick={() => onFinish({ select: nova.id })}>
                  {t("onboarding.startWith", { name: nova.name })}
                </Button>
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
