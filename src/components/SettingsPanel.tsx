// One agent's settings, as a page of its own in the panel where its chat
// was. Who it is sits at the top, large and editable where it stands; the
// rest is one scroll in the order people reach for it (who it is, what it
// thinks with, how much it asks, what it can touch, what it remembers,
// how it reaches you, when it runs, and the doors out), with a list of
// those groups on the left that follows the scroll and jumps on a click.
// That list is a page column (SideColumn.tsx), sized by its edge and
// folded with ⌘B, and folded it is a strip of tabs along the top that
// follows the scroll the same way.
//
// One scroll rather than a page per group because an agent is one thing:
// seeing its engine a flick below its instructions is part of knowing it,
// and nothing here is so long that it needs hiding behind a tab.
import { PrivateReader } from "./members/PrivateReader";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Archive } from "@/components/icons";
import { BellDot } from "@/components/icons";
import { BookOpen } from "@/components/icons";
import { CalendarClock } from "@/components/icons";
import { Check } from "@/components/icons";
import { Cpu } from "@/components/icons";
import { Download } from "@/components/icons";
import { FingerprintPattern as Fingerprint } from "@/components/icons";
import { Library } from "@/components/icons";
import { MessageCircle } from "@/components/icons";
import { Mic } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Puzzle } from "@/components/icons";
import { RefreshCw } from "@/components/icons";
import { RotateCcw } from "@/components/icons";
import { SlidersHorizontal } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { TriangleAlert } from "@/components/icons";
import { User } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Bot, type Skill } from "@/state/store";
import { useMcpServers, type McpServerRow } from "./McpServers";
import { TeamSignInNotice } from "./TeamSignInNotice";
import { AgentAccessCard } from "./members/AgentAccessCard";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import {
  expressionForBot,
  shapeForBot,
  BLOK_COLORS,
  BLOK_COLOR_NAMES,
  BLOK_EXPRESSIONS,
  BLOK_SHAPES,
} from "@/lib/mascot";
import { CodexSpeedControl } from "./CodexSpeed";
import { ModelPicker } from "./ModelPicker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { VoiceCard } from "./Voice";
import { TelegramSection } from "./TelegramSection";
import { RoutinesSection } from "./RoutinesSection";
import { SettingRow, SettingsSelect } from "./SettingsLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/plural";
import { stamp } from "@/lib/when";
import { thisComputer } from "@/lib/thisComputer";
import { sameEngineBackup } from "@/lib/backupChoice";
import { computerOptions, offersThisComputer } from "@/lib/hosted";
import { useEscape } from "@/lib/useEscape";
import { EngineSuggestionCard, useEngineReport } from "./EngineReport";
import { APPROVAL_MODES, ApprovalsChooser, confirmWidening, RULES_AND_MODES, type ApprovalMode } from "./ApprovalsChooser";
import { DELIVERY_MODES, modeWords, type DeliveryMode } from "@/lib/deliveryModes";
import { BACKGROUND_WORK, backgroundWords, type BackgroundWork } from "@/lib/backgroundWork";
import { useColumnFolded, type SideColumnSize } from "@/lib/sideColumn";
import { effortChoice } from "@/lib/effort";
import { SideColumn, SideTabs } from "./SideColumn";

type Patch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "notifications"
    | "computer"
    | "color"
    | "shape"
    | "seniority"
    | "withoutComponents"
    | "effort"
    | "mascotExpression"
    | "composio"
    | "browser"
    | "backupSelection"
    | "engineHooks"
    | "recallBeforeTurn"
    | "delivery"
    | "backgroundWork"
  >
>;

type SectionId =
  | "identity"
  | "engine"
  | "behaviour"
  | "tools"
  | "memory"
  | "reach"
  | "notifications"
  | "schedules"
  | "export"
  | "danger";

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof User }> = [
  { id: "identity", label: "Identity", icon: User },
  { id: "engine", label: "Engine", icon: Cpu },
  { id: "behaviour", label: "Behaviour", icon: SlidersHorizontal },
  { id: "tools", label: "Tools", icon: Puzzle },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "reach", label: "Voice and Telegram", icon: Mic },
  { id: "notifications", label: "Notifications", icon: BellDot },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
  { id: "export", label: "Signature and export", icon: Fingerprint },
  { id: "danger", label: "Danger zone", icon: TriangleAlert },
];

const anchor = (id: SectionId) => `agent-settings-${id}`;

/** The list of groups beside the page, one size for every agent's. */
const AGENT_SETTINGS_COLUMN: SideColumnSize = { min: 200, max: 360, initial: 248, foldBelow: 150 };

// ---------------------------------------------------------------------------
// The page's own pieces: a section, a group of rows inside it.

function Section({
  id,
  title,
  says,
  children,
}: {
  id: SectionId;
  title: string;
  says?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={anchor(id)} aria-labelledby={`${anchor(id)}-title`} className="scroll-mt-6 pt-12 first:pt-0">
      <div className="mb-4 px-1">
        <h2
          id={`${anchor(id)}-title`}
          tabIndex={-1}
          className="text-title font-semibold tracking-tight text-foreground outline-none"
        >
          {title}
        </h2>
        {says && <p className="mt-1 text-pretty text-body leading-relaxed text-muted-foreground">{says}</p>}
      </div>
      {/* the cards borrowed from elsewhere each bring a top margin of
          their own; the stack's gap is the only spacing here */}
      <div className="flex flex-col gap-3 *:mt-0">{children}</div>
    </section>
  );
}

/** Rows that belong together, read as one list. */
function Group({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col divide-y overflow-hidden rounded-2xl border bg-card", className)}>{children}</div>
  );
}

/** A short aside under a row: what a setting does not cover. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2.5 rounded-xl bg-muted/60 px-3 py-2 text-pretty text-small leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

function Saved({ shown }: { shown: boolean }) {
  return (
    <span
      aria-live="polite"
      className={cn(
        "flex items-center gap-1 text-small text-success transition-opacity duration-200",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      <Check size={12} /> Saved
    </span>
  );
}

// ---------------------------------------------------------------------------

export function AgentSettingsPage({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SectionId>("identity");
  const suggestion = useEngineReport()?.suggestions.find((s) => s.botId === bot.id);
  const patch = (p: Patch) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const close = () => dispatch({ type: "toggleSettings", open: false });
  // the levels this agent's engine and model have, and the one it runs at
  const effort = effortChoice(state.instances, bot.modelSelection, bot.effort);

  // Escape goes back to the chat, unless something open on top takes it
  useEscape(close);

  // The group being read is the last one whose heading has passed a line
  // a third of the way down; at the very bottom it is the last group,
  // however short, or the danger zone could never be the one lit.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top;
      const line = top + root.clientHeight * 0.3;
      let current: SectionId = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const el = document.getElementById(anchor(section.id));
        if (el && el.getBoundingClientRect().top <= line) current = section.id;
      }
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        current = SECTIONS[SECTIONS.length - 1].id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /** To a group, and the keyboard with it: the heading takes focus, so
   * Tab carries on from where the eye went. */
  const jump = (id: SectionId) => {
    const el = document.getElementById(anchor(id));
    if (!el) return;
    setActive(id);
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    document.getElementById(`${anchor(id)}-title`)?.focus({ preventScroll: true });
  };

  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection?.instanceId);
  const modelName =
    instance?.models.options.find((o) => o.id === bot.modelSelection?.model)?.label ??
    (bot.modelSelection?.model || instance?.models.default || "Engine default");
  const mode = bot.approvals ?? "ask";
  const seniority = bot.seniority ?? 1;
  const skillCount = (bot.skills?.length ?? 0) + (bot.skillIds?.length ?? 0);
  const folded = useColumnFolded("agent-settings", AGENT_SETTINGS_COLUMN);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background md:flex-row">
      <SideColumn
        id="agent-settings"
        size={AGENT_SETTINGS_COLUMN}
        as="nav"
        label={`${bot.name}'s settings`}
        className="border-b bg-sidebar/60 md:border-b-0"
      >
        {/* No back button of its own, as in Settings: the title bar's Back
            and Esc go back to the chat, and so does the chat button by the
            name. On a phone the pill sits in the corner, so the row leaves
            it room. */}
        <div className="titlebar-drag flex h-[52px] shrink-0 items-center gap-2.5 px-4 max-md:pl-16">
          <AgentAvatar bot={bot} size={22} />
          <span className="min-w-0 truncate text-ui font-semibold text-foreground">{bot.name || "Unnamed"}</span>
          <span className="shrink-0 text-body text-muted-foreground">Settings</span>
        </div>
        <div className="flex gap-0.5 overflow-x-auto px-2 pb-2 [scrollbar-width:none] md:flex-1 md:flex-col md:overflow-y-auto md:pb-4 md:pt-1 [&::-webkit-scrollbar]:hidden">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const on = section.id === active;
            return (
              <button
                key={section.id}
                onClick={() => jump(section.id)}
                aria-current={on ? "location" : undefined}
                className={cn(
                  "relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-body outline-none transition-colors duration-150",
                  on ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                  section.id === "danger" && "md:mt-3",
                )}
              >
                {/* the lit row slides to the group being read rather than
                    blinking there, so the eye follows the scroll's pace */}
                {on && (
                  <motion.span
                    layoutId="agent-settings-nav"
                    transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                    className="absolute inset-0 z-0 rounded-lg bg-background shadow-[0_0_0_0.5px_var(--border)]"
                  />
                )}
                {/* above the highlight wherever it is mid-slide, so a row
                    it passes over never loses its words */}
                <Icon
                  size={16}
                  className={cn(
                    "relative z-[1]",
                    section.id === "danger" ? "text-destructive" : on ? "text-foreground" : "text-muted-foreground",
                  )}
                />
                <span className="relative z-[1]">{section.label}</span>
              </button>
            );
          })}
        </div>
      </SideColumn>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {folded && (
          <SideTabs
            column="agent-settings"
            label={`${bot.name}'s settings`}
            currentKind="location"
            groups={[{ id: "sections", name: "Groups", tabs: SECTIONS.map((s) => ({ id: s.id, label: s.label, tone: s.id === "danger" ? "danger" : "default" })) }]}
            current={active}
            onPick={(id) => jump(id as SectionId)}
          />
        )}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-5 pb-24 pt-8 md:px-10 md:pt-10">
            <Hero
              bot={bot}
              patch={patch}
              facts={[
                { label: modelName, to: "engine" },
                { label: APPROVAL_MODES.find((m) => m.id === mode)?.label ?? "Ask first", to: "behaviour" },
                { label: seniority >= 4 ? "Lead" : seniority === 3 ? "Mid" : "Junior", to: "identity" },
                ...(skillCount ? [{ label: plural(skillCount, "skill"), to: "tools" as const }] : []),
              ]}
              onJump={jump}
              onChat={close}
            />

            <div className="mt-12">
              <Section id="identity" title="Identity">
                <LookCard bot={bot} patch={patch} />
                <Group>
                  <SettingRow
                    label="Instructions"
                    htmlFor="agent-instructions"
                    description="It reads these before every reply."
                  >
                    <Textarea
                      id="agent-instructions"
                      className="mt-3 min-h-[132px] resize-y text-ui leading-relaxed"
                      placeholder="What this agent is for, how it should behave"
                      value={bot.description}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Seniority"
                    description="In a room, the most senior agent leads, unless the room crowns another."
                  >
                    <Segmented
                      aria-label="Seniority"
                      className="mt-3 max-w-[360px]"
                      value={seniority >= 4 ? "5" : seniority === 3 ? "3" : "1"}
                      onChange={(level) => patch({ seniority: Number(level) })}
                      options={[
                        { value: "1", label: "Junior" },
                        { value: "3", label: "Mid" },
                        { value: "5", label: "Lead" },
                      ]}
                    />
                  </SettingRow>
                </Group>
              </Section>

              <Section id="engine" title="Engine">
                <Group>
                  <SettingRow
                    label="Model"
                    description="Changes apply from the next message."
                    control={
                      <div className="rounded-lg border bg-background">
                        <ModelPicker bot={bot} />
                      </div>
                    }
                  >
                    <TeamSignInNotice bot={bot} className="mt-3" />
                  </SettingRow>
                  <SettingRow label="Reasoning effort" description={effort.note ?? "How hard it thinks, where the model supports it."}>
                    {effort.levels.length > 0 && (
                      <Segmented
                        aria-label="Reasoning effort"
                        className="mt-3 max-w-[480px]"
                        value={effort.value}
                        // null, not left out: a patch without the key would
                        // leave the saved level where it was
                        onChange={(next) => patch({ effort: next ?? null })}
                        options={effort.options}
                      />
                    )}
                  </SettingRow>
                  <SettingRow
                    label="Backup engine"
                    description="Takes over if the main model hits a limit or fails, then hands back when it can."
                    control={
                      <div className="rounded-lg border bg-background">
                        <ModelPicker
                          bot={bot}
                          value={bot.backupSelection ?? null}
                          onPick={(selection) => patch({ backupSelection: selection })}
                          noneLabel="No backup"
                          exclude={bot.modelSelection}
                        />
                      </div>
                    }
                  >
                    {/* every model on an engine is out when the engine is, so a
                        backup on the same one cannot cover that, and the server
                        will not try it (backupFor) */}
                    {sameEngineBackup(bot.modelSelection, bot.backupSelection) && (
                      <Note>
                        Same engine as the main model, so it cannot cover usage limits, credit or sign-in problems. Pick
                        another engine for that.
                      </Note>
                    )}
                  </SettingRow>
                  {instance?.driverKind === "claudeAgent" && (
                    // Claude Code runs the hooks your plugins and settings install,
                    // and a plugin's session-start text lands in the agent's own
                    // context. Some agents are better off without any of it.
                    <SettingRow
                      label="Plugin hooks"
                      description="Let Claude Code run your plugin and settings hooks for this agent."
                      control={
                        <Switch
                          checked={bot.engineHooks !== false}
                          onCheckedChange={(on: boolean) => patch({ engineHooks: on })}
                          aria-label="Plugin hooks"
                        />
                      }
                    />
                  )}
                </Group>
                <CodexSpeedControl bot={bot} />
                {suggestion && <EngineSuggestionCard s={suggestion} compact />}
              </Section>

              <Section id="behaviour" title="Behaviour and approvals">
                <AgentAccessCard botId={bot.id} />
                <ApprovalsCard bot={bot} />
                <Group>
                  <DeliveryRow bot={bot} patch={patch} />
                  <BackgroundWorkRow bot={bot} patch={patch} />
                </Group>
                <WorkingFolderCard bot={bot} />
                <AnswersCard bot={bot} patch={patch} />
              </Section>

              <Section id="tools" title="Tools">
                <Group>
                  <ConnectedAppsRow bot={bot} patch={patch} />
                  <BrowserRow bot={bot} patch={patch} />
                  <ComputerRow bot={bot} patch={patch} />
                </Group>
                <McpAttachCard bot={bot} />
                <SkillsCard bot={bot} />
              </Section>

              <Section id="memory" title="Memory">
                <MemorySummary bot={bot} />
                <Group>
                  <RecallRow bot={bot} patch={patch} />
                </Group>
              </Section>

              <Section id="reach" title="Voice and Telegram">
                <VoiceCard bot={bot} />
                <TelegramSection key={bot.id} botId={bot.id} />
              </Section>

              <Section id="notifications" title="Notifications">
                <Group>
                  <SettingRow
                    label="Notify me when it replies"
                    control={
                      <Switch
                        checked={bot.notifications}
                        onCheckedChange={(notifications) => patch({ notifications })}
                        aria-label="Notifications"
                      />
                    }
                  >
                    {/* The rule, stated. A person deciding whether to leave this
                        on deserves to know what it does and does not cover,
                        rather than discovering the shape of it over a week. */}
                    <Note>
                      Approvals always notify you. In a room, agents only notify you when they name you. Nothing
                      notifies you about the chat on your screen.
                    </Note>
                  </SettingRow>
                </Group>
              </Section>

              <Section id="schedules" title="Schedules">
                <RoutinesSection targetId={bot.id} targetKind="agent" targetName={bot.name} bare />
              </Section>

              <Section id="export" title="Signature and export">
                <Group>
                  <SignatureRow bot={bot} />
                  <ExportRow bot={bot} />
                </Group>
              </Section>

              {/* members' private conversations, only while the owner may read them */}
              <PrivateReader botId={bot.id} botName={bot.name} />
              <Section id="danger" title="Danger zone">
                <DangerZone bot={bot} />
              </Section>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// The top of the page: the face, the name and the line, edited in place.

function Hero({
  bot,
  patch,
  facts,
  onJump,
  onChat,
}: {
  bot: Bot;
  patch: (p: Patch) => void;
  facts: Array<{ label: string; to: SectionId }>;
  onJump: (id: SectionId) => void;
  onChat: () => void;
}) {
  const look = `${bot.color}-${shapeForBot(bot)}-${expressionForBot(bot)}-${bot.avatarAt ?? 0}`;
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
      <button
        onClick={() => onJump("identity")}
        aria-label="Change the look"
        title="Change the look"
        className="group relative shrink-0 self-start rounded-[26px] outline-none transition-transform duration-150 ease-out active:scale-[0.97]"
      >
        {/* a new look lands with a small settle, not a cut */}
        <motion.span
          key={look}
          initial={{ scale: 0.9, opacity: 0.5 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", duration: 0.4, bounce: 0.35 }}
          className="block"
        >
          <AgentAvatar bot={bot} size={96} className="shadow-[0_6px_24px_-8px_var(--shadow-color)]" />
        </motion.span>
        <span className="absolute -bottom-1 -right-1 flex size-7 items-center justify-center rounded-full border bg-popover text-muted-foreground shadow-sm transition-[color,scale] duration-150 ease-out group-hover:scale-105 group-hover:text-foreground">
          <Pencil size={13} />
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* The name and the line are the page's heading and its first
                field at once: shown as a heading, a field the moment it is
                touched, so renaming never means finding a form. */}
            <input
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Name your agent"
              aria-label="Name"
              spellCheck={false}
              className="-mx-2 block w-[calc(100%+1rem)] min-w-0 truncate rounded-lg bg-transparent px-2 py-0.5 text-display font-semibold text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground/60 hover:bg-accent/50 focus:bg-accent/60"
            />
            <input
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="What this agent does, in a line"
              aria-label="Title"
              className="-mx-2 mt-0.5 block w-[calc(100%+1rem)] min-w-0 truncate rounded-lg bg-transparent px-2 py-1 text-lead text-muted-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground/60 hover:bg-accent/50 focus:bg-accent/60 focus:text-foreground"
            />
          </div>
          <Button variant="secondary" onClick={onChat} className="mt-1.5 shrink-0" title={`Back to the chat with ${bot.name}`}>
            <MessageCircle size={15} />
            <span className="max-sm:hidden">Open chat</span>
          </Button>
        </div>
        {/* the few things worth knowing at a glance, each a way to the
            group that changes it */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <button
              key={`${fact.to}-${fact.label}`}
              onClick={() => onJump(fact.to)}
              className="flex h-7 max-w-[220px] items-center rounded-full border bg-card px-3 text-small text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.97]"
            >
              <span className="truncate">{fact.label}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Identity

/** The face, one control panel at a time beside it. A photo replaces the
 * pixel identity everywhere it is shown; the identity underneath survives,
 * so removing the photo brings the same face back rather than a reroll. */
function LookCard({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const [tab, setTab] = useState<"shape" | "color" | "face">("shape");
  const activeExpression = expressionForBot(bot);
  const activeShape = shapeForBot(bot);
  const shuffle = () =>
    patch({
      color: BLOK_COLOR_NAMES[Math.floor(Math.random() * BLOK_COLOR_NAMES.length)],
      shape: BLOK_SHAPES[Math.floor(Math.random() * BLOK_SHAPES.length)],
    });

  /** Center-crop to a square, shrink to 512, and ship as JPEG. Done
   * here so the server never has to buffer somebody's 12MB original. */
  const uploadAvatar = (file: File) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 512, 512);
      const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      api(`/api/bots/${bot.id}/avatar`, {
        method: "PUT",
        body: JSON.stringify({ data, mime: "image/jpeg" }),
      }).catch(() => {});
    };
    image.src = url;
  };

  const tile =
    "flex items-center justify-center rounded-xl outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-accent active:scale-[0.94]";

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      {/* Side by side when there is room. On a phone the controls would
          get about 150px beside the face, which is not enough for a row of
          shapes, so the face goes above them and they get the width. */}
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
        <div className="flex shrink-0 flex-col items-center gap-3 sm:w-[132px]">
          <div className="flex size-[120px] items-center justify-center rounded-[28px] bg-muted/60">
            <motion.span
              key={`${bot.color}-${activeShape}-${activeExpression}-${bot.avatarAt ?? 0}`}
              initial={{ scale: 0.86 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", duration: 0.38, bounce: 0.4 }}
              className="block"
            >
              <AgentAvatar bot={bot} size={88} />
            </motion.span>
          </div>
          <div className="flex flex-wrap justify-center gap-1">
            <Button variant="ghost" size="sm" onClick={shuffle} title="Random color and shape">
              <RefreshCw size={13} />
              Shuffle
            </Button>
            <label className="flex h-7 cursor-pointer items-center rounded-md px-2.5 text-body font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground has-[:focus-visible]:bg-accent">
              {bot.avatarAt ? "Change photo" : "Use a photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadAvatar(file);
                  e.target.value = "";
                }}
              />
            </label>
            {bot.avatarAt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  api(`/api/bots/${bot.id}/avatar`, { method: "DELETE" }).catch(() => {});
                }}
              >
                Remove photo
              </Button>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-2">
            <Segmented
              aria-label="What to change"
              size="sm"
              className="w-[240px] max-w-full"
              value={tab}
              onChange={setTab}
              options={[
                { value: "shape", label: "Shape" },
                { value: "color", label: "Color" },
                { value: "face", label: "Face" },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              title="Back to the green star"
              onClick={() => patch({ color: "green", shape: "star", mascotExpression: null })}
            >
              <RotateCcw size={13} />
              Reset
            </Button>
          </div>

          {bot.avatarAt && (
            <p className="mb-3 text-pretty text-small leading-relaxed text-muted-foreground">
              The photo replaces this face. Remove it to bring the face back.
            </p>
          )}

          {tab === "shape" && (
            <div role="radiogroup" aria-label="Shape" className="flex flex-wrap gap-1.5">
              {BLOK_SHAPES.map((shape) => (
                <button
                  key={shape}
                  role="radio"
                  aria-checked={activeShape === shape}
                  onClick={() => patch({ shape })}
                  className={cn(tile, "size-[52px]", activeShape === shape && "bg-accent shadow-[inset_0_0_0_1.5px_var(--foreground)]")}
                  title={shape}
                  aria-label={`Use ${shape} shape`}
                >
                  <BlokAvatar color={bot.color} shape={shape} expression="deadpan" size={34} />
                </button>
              ))}
            </div>
          )}

          {tab === "color" && (
            <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-3 p-1">
              {BLOK_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  role="radio"
                  aria-checked={bot.color === color}
                  onClick={() => patch({ color })}
                  className={cn(
                    "size-10 justify-self-center rounded-full outline-none transition-[scale,box-shadow] duration-150 ease-out hover:scale-110 active:scale-95",
                    bot.color === color && "shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--foreground)]",
                  )}
                  style={{ backgroundColor: BLOK_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} color`}
                />
              ))}
            </div>
          )}

          {tab === "face" && (
            <div role="radiogroup" aria-label="Face" className="flex flex-wrap gap-1.5">
              {BLOK_EXPRESSIONS.map((expression) => (
                <button
                  key={expression}
                  role="radio"
                  aria-checked={activeExpression === expression}
                  onClick={() => patch({ mascotExpression: expression })}
                  className={cn(
                    tile,
                    "size-[52px]",
                    activeExpression === expression && "bg-accent shadow-[inset_0_0_0_1.5px_var(--foreground)]",
                  )}
                  title={expression}
                  aria-label={`Use ${expression} expression`}
                >
                  <BlokAvatar color={bot.color} shape={activeShape} expression={expression} size={36} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Behaviour

/**
 * How much this agent may do without asking: the same four modes, worded
 * the same way, as onboarding and Settings, Rules and approvals, all of
 * them visible at once so two can be compared without switching to each.
 */
function ApprovalsCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const mode = bot.approvals ?? "ask";
  const [refused, setRefused] = useState(false);

  /**
   * Widening the leash asks who is there; narrowing it never does.
   *
   * Auto is the one setting on this page that somebody else could change
   * while a laptop sits unlocked, and it is the one whose effect is
   * invisible afterwards. A Mac with no sensor is not blocked: this
   * proves who is present when it can, and stays out of the way when it
   * cannot.
   */
  const choose = async (next: ApprovalMode) => {
    if (next === mode) return;
    setRefused(false);
    if (!(await confirmWidening(mode, next, bot.name))) {
      setRefused(true);
      return;
    }
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvals: next } });
  };

  return (
    <Group>
      <SettingRow
        label="How much it asks"
        info={RULES_AND_MODES}
        description="Giving it more freedom asks you to confirm it is you."
      >
        <div className="mt-3">
          <ApprovalsChooser value={mode} onChange={(next) => void choose(next)} compact />
        </div>
        {refused && <div className="mt-2 text-small text-warning">Not confirmed. Nothing changed.</div>}
      </SettingRow>
    </Group>
  );
}

/** The folder this agent's new tasks run in. Server-validated: a typo'd
 * path is refused with the reason rather than silently kept. */
function WorkingFolderCard({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(bot.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = (next: string | null) => {
    setError(null);
    api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: next }) })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
        if (next === null) setValue("");
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <Group>
      <SettingRow
        label="Working folder"
        htmlFor="agent-folder"
        info="Pick a project folder, or leave it empty to use its own workspace. A reply already under way finishes where it started. Rehearsals, and conversations brought over from another app, keep their own folder."
        description="Where its conversations run. A change applies to each one from its next message, in a new session there that is told the conversation so far."
        control={<Saved shown={saved} />}
      >
        <div className="mt-3 flex gap-2">
          <Input
            id="agent-folder"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(value.trim() || null)}
            placeholder="Its own workspace"
            spellCheck={false}
            className="h-8 font-mono text-small"
          />
          <BrowseFolderButton
            onPick={(path) => {
              setValue(path);
              save(path);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={value.trim() === (bot.cwd ?? "")}
            onClick={() => save(value.trim() || null)}
          >
            Save
          </Button>
        </div>
        {error && <div className="mt-1.5 text-small text-destructive">{error}</div>}
      </SettingRow>
    </Group>
  );
}

const COMPONENTS: Array<[string, string]> = [
  ["chart", "Charts"],
  ["table", "Tables"],
  ["decision", "Decisions"],
  ["steps", "Step lists"],
  ["quote", "Quotes"],
  ["refused", "Refusals"],
];

/**
 * What this agent may answer with instead of prose.
 *
 * By exclusion, so switching one off for one agent leaves everybody else
 * alone. All on by default: the point of the gallery is that an answer
 * that is really a table arrives as a table, and making somebody opt into
 * that one shape at a time would mean nobody ever sees it.
 *
 * The first switch is the whole of interface answers (server/genui.ts).
 * The shapes under it hold either way: off, a chart is not taught as
 * interface or as the older gallery card.
 */
/**
 * What happens to what you send while this agent is in the middle of
 * something (server/delivery.ts). Its own choice, or the workspace's,
 * which Settings, Behaviour sets for every agent that has not chosen.
 */
function DeliveryRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const { state } = useStore();
  const workspace = state.config?.delivery?.mode ?? "auto";
  const own = bot.delivery ?? null;
  const shown = modeWords(own ?? workspace);
  return (
    <SettingRow
      label="Messages while it works"
      description={own ? shown.says : `Same as your other agents: ${shown.label}. ${shown.says}`}
    >
      <div className="mt-3 max-w-[460px]">
        <Segmented<"default" | DeliveryMode>
          aria-label="Messages while it works"
          size="sm"
          value={own ?? "default"}
          onChange={(next) => patch({ delivery: next === "default" ? null : next })}
          options={[
            { value: "default", label: "Default", title: "Follow Settings, Behaviour" },
            ...DELIVERY_MODES.map((m) => ({ value: m.value, label: m.label })),
          ]}
        />
      </div>
    </SettingRow>
  );
}

/**
 * What happens to the subagents and commands this agent starts in the
 * background once its reply is done (server/background-work.ts). Its own
 * choice, or the workspace's, which Settings, Behaviour sets for every
 * agent that has not chosen.
 */
function BackgroundWorkRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const { state } = useStore();
  const workspace = backgroundWords(state.config?.turns?.backgroundWork);
  const own = bot.backgroundWork ?? null;
  const shown = backgroundWords(own ?? workspace.value);
  return (
    <SettingRow
      label="Background work it starts"
      description={own ? shown.says : `Same as your other agents: ${workspace.label}. ${workspace.says}`}
      control={
        <SettingsSelect
          aria-label="Background work it starts"
          value={own ?? "default"}
          onChange={(e) => patch({ backgroundWork: e.target.value === "default" ? null : (e.target.value as BackgroundWork) })}
          className="w-[240px]"
        >
          <option value="default">Use the workspace setting</option>
          {BACKGROUND_WORK.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SettingsSelect>
      }
    />
  );
}

function AnswersCard({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const without = bot.withoutComponents ?? [];
  const interactive = !without.includes("openui");
  return (
    <Group>
      <SettingRow
        label="Interactive answers"
        description="Cards, tables, charts and buttons right in the chat, instead of long paragraphs."
        control={
          <Switch
            checked={interactive}
            onCheckedChange={(next) =>
              patch({ withoutComponents: next ? without.filter((k) => k !== "openui") : [...without, "openui"] })
            }
          />
        }
      />
      <SettingRow
        label="Answers"
        description="Turn one off and it answers in plain text instead."
      >
        <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {COMPONENTS.map(([kind, label]) => {
            const on = !without.includes(kind);
            return (
              <label key={kind} className="flex items-center justify-between gap-3">
                <span className="text-body text-foreground">{label}</span>
                <Switch
                  checked={on}
                  onCheckedChange={(next) =>
                    patch({ withoutComponents: next ? without.filter((k) => k !== kind) : [...without, kind] })
                  }
                />
              </label>
            );
          })}
        </div>
      </SettingRow>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Tools

/** The per-agent connector grant. The Composio key is shared by the
 * whole workspace; whether THIS agent may use it is decided here. */
function ConnectedAppsRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const { state } = useStore();
  const configured = state.config?.composio?.configured ?? false;
  const allowed = bot.composio !== false;
  return (
    <SettingRow
      label="Connected apps"
      description={
        configured
          ? allowed
            ? "It can use your connected apps: Slack, Gmail and the rest."
            : "Blocked from your connected apps."
          : "Add a Composio key in Settings, Apps and keys."
      }
      control={
        <Switch
          checked={allowed}
          disabled={!configured && allowed === false}
          onCheckedChange={(on) => patch({ composio: on })}
          aria-label="Connected apps"
        />
      }
    />
  );
}

/**
 * A browser of the agent's own.
 *
 * Deliberately its own grant rather than part of the computer one: an
 * agent that should compare prices does not also need the desktop, and
 * handing over the narrower tool is the whole point of having two.
 */
function BrowserRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const on = bot.browser === true;
  const [sources, setSources] = useState<string[]>([]);
  const [sites, setSites] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    api("/api/browser/cookie-sources")
      .then((r) => setSources(r.sources ?? []))
      .catch(() => setSources([]));
  }, [on]);

  const borrow = (browser: string) => {
    const wanted = sites
      .split(/[\s,]+/)
      .map((site) => site.trim())
      .filter(Boolean);
    if (!wanted.length || importing) return;
    setImporting(true);
    setResult(null);
    api(`/api/bots/${bot.id}/browser/cookies`, {
      method: "POST",
      body: JSON.stringify({ browser, sites: wanted }),
    })
      .then((r) => setResult(r.imported ? `Signed in for ${wanted.join(", ")}.` : (r.note ?? "Nothing found for those sites.")))
      .catch((e) => setResult(e.message))
      .finally(() => setImporting(false));
  };

  return (
    <SettingRow
      label="Its own browser"
      description={
        on
          ? "A browser of its own, signed in separately from yours."
          : "For web tasks like comparing prices or filling in forms."
      }
      control={<Switch checked={on} onCheckedChange={(next) => patch({ browser: next })} aria-label="Its own browser" />}
    >
      {/* Sign-ins are borrowed per site rather than wholesale: an agent
          that checks a delivery has no business holding the bank. */}
      {on && sources.length > 0 && (
        <div className="mt-3 rounded-xl bg-muted/50 p-3">
          <div className="text-body font-medium text-foreground">Borrow a sign-in</div>
          <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">
            Only sign-ins for the sites you name are copied. Your keychain may ask first.
          </div>
          <Input
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            placeholder="amazon.com, ebay.com"
            aria-label="Sites to borrow a sign-in for"
            className="mt-2 h-8 bg-background text-body"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {sources.map((browser) => (
              <Button
                key={browser}
                size="sm"
                variant="outline"
                className="bg-background"
                disabled={importing || !sites.trim()}
                onClick={() => borrow(browser)}
              >
                {importing ? "Borrowing…" : `From ${browser}`}
              </Button>
            ))}
            {result && <span className="text-small text-muted-foreground">{result}</span>}
          </div>
        </div>
      )}
    </SettingRow>
  );
}

/** Four homes for an agent's hands. A 2x2 grid on a phone, because four
 * options in one row is where segmented controls stop being readable. */
function ComputerRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const { state, dispatch } = useStore();
  // A hosted workspace offers only this machine and off (server/hosted.ts),
  // and the server says which; the Computer panel reads the same list.
  const hosted = Boolean(state.config?.hosted?.on);
  const options = computerOptions(state.config?.hosted?.computers);
  // Off a Mac there is no "this computer" for Automatic to fall back on,
  // so it falls back on nothing, and choosing starts at the Local VM.
  const ownScreen = offersThisComputer(state.config?.hosted?.computers);
  return (
    <SettingRow
      label="Computer"
      description={
        hosted
          ? "This machine's browser and virtual desktop, or none."
          : bot.computer
            ? "Where it gets a desktop and a terminal."
            : ownScreen
              ? "Uses your cloud box if you have one, otherwise this computer."
              : "Uses your cloud box if you have one, otherwise none."
      }
      control={
        <label className="flex items-center gap-2 text-body text-muted-foreground">
          Automatic
          <Switch
            checked={!bot.computer}
            onCheckedChange={(on) => patch({ computer: on ? null : ownScreen || hosted ? "local" : "sandbox" })}
            aria-label="Choose the computer automatically"
          />
        </label>
      }
    >
      {/* Auto's fallback should never be a surprise: with no box
          configured it means "this Mac", or nothing at all off a Mac, and
          the person deciding deserves to know that at the moment they
          decide it. */}
      {!hosted && !bot.computer && !state.config?.box?.configured && (
        <Note>
          {ownScreen
            ? "No cloud box is set up, so Automatic uses this computer."
            : "No cloud box is set up, so Automatic gives it no computer. Turn Automatic off and choose Local VM for a free Linux desktop here."}{" "}
          <button
            className="font-medium text-foreground underline-offset-2 hover:underline"
            onClick={() => dispatch({ type: "toggleComputer", open: true })}
          >
            Set one up
          </button>
        </Note>
      )}
      {bot.computer && (
        <div
          role="radiogroup"
          aria-label="Computer"
          className={cn("mt-3 grid grid-cols-2 gap-1 rounded-[10px] bg-muted p-0.5", options.length > 2 && "sm:grid-cols-4")}
        >
          {options.map(([mode, label]) => (
            <button
              key={mode}
              role="radio"
              aria-checked={bot.computer === mode}
              onClick={() => patch({ computer: mode })}
              className={cn(
                "rounded-lg py-1.5 text-body font-medium outline-none transition-colors duration-150",
                bot.computer === mode
                  ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </SettingRow>
  );
}

function McpAttachCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { servers } = useMcpServers();
  if (!servers?.length) return null;
  const attached = bot.mcpServers ?? [];

  return (
    <Group>
      <SettingRow label="MCP servers" description="Servers this agent can use." />
      {servers.map((server: McpServerRow) => {
        const on = attached.includes(server.id);
        return (
          <SettingRow
            key={server.id}
            label={<span className="truncate font-normal">{server.name}</span>}
            description={<span className="block truncate">{server.transport === "http" ? server.target : `runs ${server.target}`}</span>}
            control={
              <Switch
                checked={on}
                aria-label={server.name}
                onCheckedChange={(next) =>
                  dispatch({
                    type: "updateBot",
                    botId: bot.id,
                    patch: {
                      mcpServers: next ? [...attached, server.id] : attached.filter((id) => id !== server.id),
                    },
                  })
                }
              />
            }
          />
        );
      })}
    </Group>
  );
}

/**
 * Skills, both kinds, in one place: the library's shared instruction sets
 * this agent carries, and the lines written for it alone. Either changes
 * what reaches the model on the very next turn.
 */
function SkillsCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [library, setLibrary] = useState<Skill[] | null>(null);
  const [draft, setDraft] = useState("");
  const attached = bot.skillIds ?? [];
  const written = bot.skills ?? [];

  useEffect(() => {
    api("/api/skills")
      .then((r) => setLibrary(r.skills ?? []))
      .catch(() => setLibrary([]));
  }, []);

  const toggle = (id: string) =>
    dispatch({
      type: "updateBot",
      botId: bot.id,
      patch: { skillIds: attached.includes(id) ? attached.filter((s) => s !== id) : [...attached, id] },
    });
  const setWritten = (next: string[]) => dispatch({ type: "updateBot", botId: bot.id, patch: { skills: next } });
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    setWritten([...written, value]);
    setDraft("");
  };

  return (
    <Group>
      <SettingRow
        label={
          <>
            <Library size={15} className="text-muted-foreground" />
            From the library
            <span className="font-normal tabular-nums text-muted-foreground">{attached.length}</span>
          </>
        }
        control={
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "openCustomize", tab: "skills" })}>
            Manage
          </Button>
        }
      >
        <div className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {library === null ? (
            <div className="py-2 text-body text-muted-foreground">Loading…</div>
          ) : library.length === 0 ? (
            <div className="py-2 text-body text-muted-foreground">No skills installed yet.</div>
          ) : (
            library.map((skill) => {
              const on = attached.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(skill.id)}
                  className={cn(
                    "flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150",
                    on ? "bg-brand-soft" : "hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded transition-colors duration-150",
                      on ? "bg-brand-ink text-brand-foreground" : "border",
                    )}
                  >
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-body font-medium", on ? "text-brand-ink" : "text-foreground")}>
                      {skill.name}
                    </span>
                    {skill.description && (
                      <span className="mt-px block truncate text-small text-muted-foreground">{skill.description}</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </SettingRow>
      <SettingRow
        label={
          <>
            Written for {bot.name || "this agent"}
            <span className="font-normal tabular-nums text-muted-foreground">{written.length}</span>
          </>
        }
      >
        {written.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {written.map((skill, i) => (
              <div key={`${i}-${skill.slice(0, 12)}`} className="group flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2">
                <span className="min-w-0 flex-1 text-body leading-relaxed text-foreground">{skill}</span>
                <button
                  onClick={() => setWritten(written.filter((_, j) => j !== i))}
                  className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  title="Remove skill"
                  aria-label="Remove skill"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a skill: when to use it, and what to return"
            aria-label="New skill"
            className="h-8 text-body"
          />
          <Button variant="secondary" size="icon" onClick={add} disabled={!draft.trim()} title="Add" aria-label="Add skill">
            <Plus size={14} />
          </Button>
        </div>
      </SettingRow>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Memory

/** The most MEMORY.md lines that reach the agent each turn (the server's
 * MEMORY_MAX_LINES); past it, only the top is read. */
const MEMORY_LINES = 200;

/**
 * What the agent remembers, as a glance: how full its notebook is, how
 * many topic files sit beside it, and when it last changed. Reading and
 * correcting it happens in Memory itself, which keeps every change and
 * its undo; an editor here would be a second, weaker copy of that.
 */
function MemorySummary({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [info, setInfo] = useState<{ lines: number; truncated: boolean; topics: number } | null>(null);
  const [last, setLast] = useState<{ at: number; by: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api(`/api/bots/${bot.id}/memory`)
        .then((r) => {
          if (!alive) return;
          const text: string = r.text ?? "";
          setInfo({
            lines: text.trim() ? text.replace(/\n+$/, "").split("\n").length : 0,
            truncated: Boolean(r.truncated),
            topics: (r.topics ?? []).length,
          });
        })
        .catch((e: Error) => alive && setError(e.message));
      api(`/api/bots/${bot.id}/memory/journal`)
        .then((r) => alive && setLast(r.entries?.[0] ? { at: r.entries[0].at, by: r.entries[0].by } : null))
        .catch(() => {});
    };
    load();
    // an agent writes its notes as it works; keep the glance current
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bot.id]);

  const share = info ? Math.min(1, info.lines / MEMORY_LINES) : 0;
  const who = last?.by === "you" ? "you" : last?.by === "undo" ? "an undo" : last?.by === "tidy" ? "the nightly tidy" : bot.name || "the agent";

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-heading font-semibold tabular-nums text-foreground">
              {info ? info.lines : "…"}
            </span>
            <span className="text-body text-muted-foreground">of {MEMORY_LINES} lines</span>
          </div>
          <div
            role="meter"
            aria-label="Memory used"
            aria-valuemin={0}
            aria-valuemax={MEMORY_LINES}
            aria-valuenow={info?.lines ?? 0}
            className="mt-2.5 h-1.5 w-full max-w-[360px] overflow-hidden rounded-full bg-muted"
          >
            <motion.div
              className={cn("h-full rounded-full", info?.truncated ? "bg-warning" : "bg-brand")}
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(share * 100, info?.lines ? 2 : 0)}%` }}
              transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-body text-muted-foreground">
            {info && <span>{info.topics ? plural(info.topics, "topic file") : "No topic files"}</span>}
            <span>{last ? `Last changed ${stamp(last.at)} by ${who}` : info?.lines ? "No changes recorded yet" : "Nothing remembered yet"}</span>
          </div>
          {info?.truncated && (
            <div className="mt-2 text-small text-warning">
              Too long: only the first {MEMORY_LINES} lines are read.
            </div>
          )}
          {error && <div className="mt-2 text-small text-destructive">{error}</div>}
        </div>
        <Button
          variant="outline"
          className="shrink-0 self-start sm:self-center"
          onClick={() => dispatch({ type: "openMemory", target: bot.id })}
        >
          <BookOpen size={14} />
          Open memory
        </Button>
      </div>
    </div>
  );
}

/**
 * Whether this agent is reminded of its other conversations before your
 * turn. On by default; the workspace switch in Settings, Behaviour, turns
 * it off for every agent, and then this one says so instead of pretending.
 */
function RecallRow({ bot, patch }: { bot: Bot; patch: (p: Patch) => void }) {
  const { state } = useStore();
  const everywhere = state.config?.recall?.beforeTurn !== false;
  return (
    <SettingRow
      label="Bring up other conversations"
      description={
        everywhere
          ? `Gives ${bot.name || "it"} up to three close matches from its other chats and notes, shown under your message.`
          : "Off for every agent in Settings, Behaviour."
      }
      control={
        <Switch
          checked={everywhere && bot.recallBeforeTurn !== false}
          disabled={!everywhere}
          onCheckedChange={(on: boolean) => patch({ recallBeforeTurn: on })}
          aria-label="Bring up other conversations"
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Signature and export

/**
 * Who this agent is, as something checkable.
 *
 * Shown rather than managed: there is no button to make a key, rotate one
 * or turn signing off, because every one of those is a way to end up with
 * a record that says less than it appears to. The agent has a key, the
 * record carries what it signed, and this is where a person can see the
 * public half of it.
 */
function SignatureRow({ bot }: { bot: Bot }) {
  const [full, setFull] = useState(false);
  const print = bot.fingerprint ?? "";
  if (!print) return null;
  // both ends, never just the front: a prefix is cheap to imitate
  const short = `${print.slice(0, 8)}…${print.slice(-4)}`;
  return (
    <SettingRow
      label="Signature"
      description={`${bot.name} signs what it does, so you can check it later. Its private key never leaves ${thisComputer()}.`}
    >
      <button
        onClick={() => setFull((v) => !v)}
        title={full ? "Show less" : "Show all"}
        className="mt-3 w-full rounded-xl bg-muted/60 px-3 py-2 text-left font-mono text-small leading-relaxed text-foreground transition-colors duration-150 hover:bg-muted"
      >
        {full ? <span className="break-all">{print}</span> : short}
      </button>
    </SettingRow>
  );
}

/** An agent as a file. What leaves is the agent: who it is, the skills it
 * carries and what it has learned. Its conversations stay here, because
 * they belong to this workspace rather than to the agent. */
function ExportRow({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}/export`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "export failed");
      // the filename the server chose, so what lands on disk is what the
      // server says it is rather than something guessed here
      const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = named?.[1] ?? "agent.bloks-agent.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      label={`Take ${bot.name || "it"} with you`}
      description="One file with its role, look, skills and memory. Open it in Bloks on another machine."
      control={
        <Button variant="secondary" size="sm" disabled={busy} onClick={save}>
          <Download size={13} />
          {busy ? "Saving" : "Export"}
        </Button>
      }
    >
      {error && <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">{error}</div>}
      <Note>
        Conversations and keys stay here.
      </Note>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Danger zone

/**
 * The two ways out, the gentle one first. Archiving is the everyday one
 * and comes back from Archived agents in the sidebar; deleting is for
 * good, and its confirm names what goes. The key is the part worth
 * naming: every entry this agent signed verifies against that fingerprint
 * and no other, so a new key is not the same agent, it is a different
 * one wearing the name.
 */
function DangerZone({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [asking, setAsking] = useState<"archive" | "delete" | null>(null);
  const name = bot.name || "this agent";

  const go = () => {
    const forget = asking === "delete";
    setAsking(null);
    // leave the page first: the agent it shows is about to be gone
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "deleteBot", botId: bot.id, ...(forget ? { forget: true } : {}) });
    // an archive comes back, so it says so right where it happened
    if (!forget) {
      toast.success(`Archived ${name}`, {
        id: `archive-${bot.id}`,
        action: {
          label: "Undo",
          onClick: () => {
            dispatch({ type: "restoreBot", botId: bot.id });
            dispatch({ type: "select", id: bot.id });
          },
        },
      });
    }
  };

  return (
    <>
      <Group className="border-destructive/25">
        <SettingRow
          label={`Archive ${name}`}
          description="Stops it and hides it. Everything is kept. Restore it from Archived agents in the sidebar."
          control={
            <Button variant="outline" onClick={() => setAsking("archive")}>
              <Archive size={14} />
              Archive
            </Button>
          }
        />
        <SettingRow
          label={`Delete ${name} for good`}
          description="Deletes its conversations and signing key. This cannot be undone."
          control={
            <Button variant="destructive" onClick={() => setAsking("delete")}>
              <Trash2 size={14} />
              Delete
            </Button>
          }
        />
      </Group>

      <Dialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent showCloseButton={false} className="max-w-[420px]">
          <div className="flex items-start gap-3.5">
            <AgentAvatar bot={bot} size={40} />
            <div className="min-w-0">
              <DialogTitle>{asking === "delete" ? `Delete ${name} for good?` : `Archive ${name}?`}</DialogTitle>
              <DialogDescription>
                {asking === "delete"
                  ? "Deletes its conversations and signing key. Past signed records stay readable. This cannot be undone."
                  : "It stops and leaves the list. Everything is kept, and you can restore it from Archived agents."}
              </DialogDescription>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" autoFocus onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              variant={asking === "delete" ? "destructive" : "default"}
              className={asking === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={go}
            >
              {asking === "delete" ? "Delete for good" : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
