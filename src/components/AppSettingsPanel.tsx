// App-level settings, as a page of its own beside the sidebar: how Bloks
// looks and behaves, and everything shared by all agents. Per-agent
// settings live in SettingsPanel; contextual Box-token entry also stays in
// ComputerPanel.
//
// A page rather than a window because it outgrew one: a dozen areas in a
// 720px box meant scrolling inside a scroll. Pages are grouped the way
// people look for them (you, your agents, what they connect to, what they
// leave behind), and search finds the page a word lives on.
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Monitor from "lucide-react/dist/esm/icons/monitor.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import { api, useStore } from "@/state/store";
import { useTheme, type Theme } from "@/lib/theme";
import type { UpdateState } from "@/types/bridge";
import { drainingLine } from "./UpdateCard";
import { RecordPanel } from "./RecordPanel";
import { BackupsSection } from "./BackupsSection";
import { RulesPanel } from "./RulesPanel";
import { ApiKeyRow } from "./ApiKeys";
import { McpServersCard } from "./McpServers";
import { EnginesPanel } from "./EnginesPanel";
import { CloudSection } from "./CloudSection";
import { DevicesSection } from "./DevicesSection";
import { TelegramSection } from "./TelegramSection";
import { ChatSection } from "./ChatSection";
import { RemoteSection } from "./RemoteSection";
import { LocalVmSection } from "./LocalVmSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";
import { UseFromOtherApps } from "./UseFromOtherApps";
import { BoxSleep } from "./BoxSleep";
import { AgentDefaults } from "./AgentDefaults";
import { SettingRow, SettingsGroup, SettingsPageHeader } from "./SettingsLayout";
import { Segmented } from "@/components/ui/segmented";
import { useConversationsView } from "@/lib/conversationsView";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import CloudIcon from "lucide-react/dist/esm/icons/cloud.mjs";
import Cpu from "lucide-react/dist/esm/icons/cpu.mjs";
import History from "lucide-react/dist/esm/icons/history.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid.mjs";
import MessageCircle from "lucide-react/dist/esm/icons/message-circle.mjs";
import Mic from "lucide-react/dist/esm/icons/mic.mjs";
import SearchIcon from "lucide-react/dist/esm/icons/search.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import Smartphone from "lucide-react/dist/esm/icons/smartphone.mjs";
import UserIcon from "lucide-react/dist/esm/icons/user.mjs";
import UserPlus from "lucide-react/dist/esm/icons/user-plus.mjs";
import { useEscape } from "@/lib/useEscape";
import { APPROVAL_MODES, ApprovalsChooser, confirmWidening, useWorkspaceApprovals, type ApprovalMode } from "./ApprovalsChooser";

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
  { value: "light", label: "Light", icon: <Sun size={14} /> },
  { value: "dark", label: "Dark", icon: <Moon size={14} /> },
  { value: "system", label: "System", icon: <Monitor size={14} /> },
];

/**
 * How a long conversation is kept inside the model's window.
 *
 * The switch is off, and it says what it trades rather than only what it
 * gives. Both settings work; one pays in a pause and the other pays in
 * cache misses, and which is cheaper depends on the provider, so the
 * honest thing is to describe both and let the person choose.
 */
function Compaction() {
  const { state, dispatch } = useStore();
  const on = state.config?.compaction?.micro ?? false;
  const [saving, setSaving] = useState(false);

  const set = (micro: boolean) => {
    setSaving(true);
    api("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { micro } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <SettingRow
      label="Summarise as you go"
      info="A long conversation has to be summarised to keep fitting. Off, that happens once when it fills up, which is a pause before your next message. On, one message is folded in after each turn instead, so it never pauses. The cost: folding rewrites what was already sent, so the provider cannot reuse its cache, which on some providers costs more than the pause it removes. Your own messages are never summarised either way."
      description="Fold the conversation a little after each turn instead of all at once when it fills up."
      control={<Switch aria-label="Summarise as you go" checked={on} disabled={saving} onCheckedChange={set} />}
    />
  );
}

/**
 * Whether a quiet Claude Code conversation is compacted before its cache
 * expires (GitHub 162). Off by default: it saves on the first message
 * after a long pause, and pays for that with detail the summary drops.
 */
function IdleCompaction() {
  const { state, dispatch } = useStore();
  const on = state.config?.compaction?.idle ?? false;
  const [saving, setSaving] = useState(false);

  const set = (idle: boolean) => {
    setSaving(true);
    api("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { idle } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <SettingRow
      label="Compact while idle"
      info="Claude Code keeps a conversation cached for an hour after its last request. The first message after that writes the whole conversation to the cache again, which for a long one is the most expensive message of the day. With this on, a Claude Code conversation over 100k tokens that has been quiet for 55 minutes is compacted first, while it is still cached, so the next message starts from about a third of the size. A compaction drops some detail, and a line in the chat says where it happened."
      description="Compact a long Claude Code conversation shortly before its cache expires."
      control={<Switch aria-label="Compact while idle" checked={on} disabled={saving} onCheckedChange={set} />}
    />
  );
}

const BEFORE_TURN_CEILINGS = [
  { value: "0", label: "Never" },
  { value: "100000", label: "100k" },
  { value: "200000", label: "200k" },
  { value: "400000", label: "400k" },
] as const;

/**
 * How big a Claude Code, Codex or Pi conversation may get before its
 * next message compacts it first (GitHub 222, 223). On by default, unlike
 * the two above: every tool call of a turn sends the whole conversation
 * again, so a long one can spend a five-hour limit in minutes, and that
 * costs far more than the detail a compaction drops.
 */
function BeforeTurnCompaction() {
  const { state, dispatch } = useStore();
  const ceiling = String(state.config?.compaction?.beforeTurn ?? 200_000);
  const [saving, setSaving] = useState(false);

  const set = (next: string) => {
    setSaving(true);
    api("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn: Number(next) } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <SettingRow
      label="Compact before a long turn"
      info="Claude Code, Codex and Pi keep a conversation in a session of their own, and every tool call in a turn sends that whole session to the model again. A turn with twenty tool calls on a long conversation can use millions of tokens. With this set, a session that has grown past this size, or past 60% of what the model will take, is compacted before your next message goes, by the engine's own compaction where it has one, or by starting a new session that is told a summary and the recent messages. A line in the chat says where it happened."
      description="Compact a long Claude Code, Codex or Pi conversation before the next message, from this size."
    >
      <div className="mt-3">
        <Segmented
          aria-label="Compact before a long turn"
          value={BEFORE_TURN_CEILINGS.some((o) => o.value === ceiling) ? ceiling : "200000"}
          onChange={(next) => !saving && set(next)}
          options={BEFORE_TURN_CEILINGS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
    </SettingRow>
  );
}

const SILENT_CALL_LIMITS = [
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "0", label: "Never" },
] as const;

/**
 * How long one tool call may sit without a word from the engine before
 * its turn is stopped (GitHub 146). The model thinking, or a command that
 * keeps reporting, is never cut short; only a call that has gone silent,
 * and never while an approval card is waiting on you.
 */
function SilentCallLimit() {
  const { state, dispatch } = useStore();
  const minutes = String(state.config?.turns?.stallMinutes ?? 15);
  const [saving, setSaving] = useState(false);

  const set = (next: string) => {
    setSaving(true);
    api("/api/config", { method: "PUT", body: JSON.stringify({ turns: { stallMinutes: Number(next) } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <SettingRow
      label="Stop a tool call that goes silent"
      info="Now and then a command waits on something that never answers: a cloud folder holding a read, a prompt nobody can see. The engine says nothing more and the agent stays on working. After this long with no word, Bloks ends the turn and tells you and the agent which call it was. Thinking, writing, and commands that keep reporting are never cut short, and time spent waiting on your approval does not count."
      description="End the turn when one call has made no progress for this long."
    >
      {/* five choices do not fit beside the label, so they sit under it */}
      <div className="mt-3">
        <Segmented
          aria-label="Stop a tool call that goes silent"
          value={SILENT_CALL_LIMITS.some((o) => o.value === minutes) ? minutes : "15"}
          onChange={(next) => !saving && set(next)}
          options={SILENT_CALL_LIMITS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
    </SettingRow>
  );
}

/**
 * Whether a finished session gets read back for something worth keeping.
 *
 * Off, like everything here that spends money nobody asked for. What it
 * finds is always staged rather than installed, and the card says so,
 * because "it writes its own instructions" is a sentence that should come
 * with the word "suggests" attached.
 */
function ProposeSkills() {
  const { state, dispatch } = useStore();
  const on = state.config?.skills?.propose ?? false;
  const [saving, setSaving] = useState(false);

  const set = (propose: boolean) => {
    setSaving(true);
    api("/api/config", { method: "PUT", body: JSON.stringify({ skills: { propose } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <SettingRow
      label="Suggest skills"
      info="Nothing is ever installed on its own. A suggestion waits in Skills with the words already written, and keeping it is one press. Reading a session back costs one cheap call, on your own key, for work you did not ask for, which is why this is off until you turn it on."
      description="After a conversation that worked something out, write the procedure down as a skill for you to keep or not."
      control={<Switch aria-label="Suggest skills" checked={on} disabled={saving} onCheckedChange={set} />}
    />
  );
}

/** Shared context every agent receives. Optional, never asked for up
 * front: it lives here for whenever you feel like writing it. */
/**
 * What version this is, and the way to the next one.
 *
 * The updater already runs on its own at launch; this card exists so a
 * person can ask instead of waiting, watch the download when there is
 * one, and restart into it the moment it is ready. In a plain browser
 * tab there is no updater and the card says only what it knows.
 */
function AboutCard() {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ state: "idle" });

  useEffect(() => {
    void window.bloks?.appVersion?.().then(setVersion);
    void window.bloks?.updateState?.().then(setUpdate);
    return window.bloks?.onUpdateState?.(setUpdate);
  }, []);

  const line =
    update.state === "checking"
      ? "Checking…"
      : update.state === "downloading"
        ? `Downloading ${update.version ?? "the update"}${update.percent ? ` (${update.percent}%)` : ""}…`
        : update.state === "current"
          ? "You are on the latest version."
          : update.state === "ready"
            ? update.draining
              ? drainingLine(update.draining)
              : `${update.version ?? "An update"} is downloaded and ready.`
            : update.state === "error"
              ? update.reason === "install"
                ? "The update downloaded but didn't install. Quit and reopen Bloks to try again."
                : update.reason === "server"
                  ? "GitHub didn't hand over the update just now. Try again in a few minutes."
                  : "The update check didn't reach the server. Bloks tries again in a few hours."
              : update.state === "dev"
                ? "Updates apply to the installed app, not a dev build."
                : null;

  return (
    <SettingsGroup title="Version">
      <SettingRow
        label={`Bloks ${version ?? ""}`}
        description={line ?? "Updates download on their own and install when you restart."}
        control={
          update.state === "ready" ? (
            <Button size="sm" disabled={Boolean(update.draining)} onClick={() => void window.bloks?.updateInstall?.()}>
              Restart to update
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={!window.bloks || update.state === "checking" || update.state === "downloading"}
              onClick={() => void window.bloks?.updateCheck?.().then(setUpdate)}
            >
              Check for updates
            </Button>
          )
        }
      />
      <SettingRow
        label="Something broken, or missing?"
        description="Opens a GitHub issue. For anything gnarly, paste the diagnostics below into it."
        control={
          <Button size="sm" variant="secondary" asChild>
            <a
              href={`https://github.com/hamedgitty/bloks/issues/new?body=${encodeURIComponent(`\n\n---\nBloks ${version ?? ""} on ${navigator.platform}`)}`}
              target="_blank"
              rel="noreferrer"
            >
              Send feedback
            </a>
          </Button>
        }
      />
      <Diagnostics />
    </SettingsGroup>
  );
}

/**
 * One button between "it doesn't work" and a useful bug report. The
 * server assembles the facts (versions, engine states, which
 * credentials exist as booleans, never values) and this copies them,
 * ready to paste into a GitHub issue.
 */
function Diagnostics() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      const report = await fetch("/api/diagnostics").then((r) => {
        if (!r.ok) throw new Error();
        return r.text();
      });
      await navigator.clipboard.writeText(report);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setFailed(true);
    }
  };
  return (
    <SettingRow
      label="Diagnostics"
      info="The report holds versions, engine connection states, which keys are set as yes or no, and agent counts. Never the keys themselves, and the finished text is scrubbed for anything credential-shaped besides."
      description={
        failed ? (
          <span className="text-destructive">Couldn't build the report. Is the server running?</span>
        ) : (
          "Copies a short report about this install, ready to paste into a bug report."
        )
      }
      control={
        <Button size="sm" variant="secondary" onClick={() => void copy()} className="min-w-[128px]">
          {copied ? (
            <>
              <Check size={14} /> Copied
            </>
          ) : (
            "Copy diagnostics"
          )}
        </Button>
      }
    />
  );
}

function AboutYou() {
  const { state, dispatch } = useStore();
  const saved = state.config?.profile?.about ?? "";
  const [value, setValue] = useState(saved);
  const [justSaved, setJustSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  // adopt the server value once it arrives, without stomping an edit
  useEffect(() => {
    if (hydrated.current || !state.config) return;
    hydrated.current = true;
    setValue(saved);
  }, [state.config, saved]);

  const save = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ profile: { about: next } }),
      })
        .then((status) => {
          dispatch({ type: "configStatus", config: status });
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 1600);
        })
        .catch(() => {});
    }, 600);
  };

  return (
    <SettingsGroup>
      <SettingRow
        label="What every agent knows about you"
        htmlFor="about-you"
        description={`Optional. Stays on ${thisComputer()}, and is never shared with people you invite into a room.`}
        control={
          <span
            className={cn(
              "flex items-center gap-1 text-[11.5px] text-success transition-opacity duration-200",
              justSaved ? "opacity-100" : "opacity-0",
            )}
            aria-live="polite"
          >
            <Check size={12} /> Saved
          </span>
        }
      >
        <Textarea
          id="about-you"
          value={value}
          onChange={(e) => save(e.target.value)}
          placeholder="I'm a founder building a local-first agent app. Keep replies short and skip the preamble."
          className="mt-3 min-h-[120px] resize-y text-[13px]"
        />
      </SettingRow>
    </SettingsGroup>
  );
}

/** A key found elsewhere on this machine is an OFFER, never a default:
 * using it bills an account the user set up for something else. This
 * card asks plainly and remembers the answer either way. */
function OpenAIKeyHint() {
  const { state, dispatch } = useStore();
  const speech = state.config?.speech;
  const sourceName = (s: "env" | "codex") =>
    s === "codex" ? "your Codex sign-in" : "your environment";

  const setConsent = (on: boolean) =>
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ speech: { useDiscoveredOpenAI: on } }),
    })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {});

  if (speech?.openaiAvailable) {
    return (
      <div className="-mt-1 rounded-xl border border-warning/40 bg-warning/10 p-3">
        <div className="text-[12.5px] font-medium text-foreground">
          Found an OpenAI API key from {sourceName(speech.openaiAvailable)}
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          Bloks can use it for voices, which would bill that key's account per character
          spoken. Nothing is used until you say so.
        </div>
        <Button size="sm" className="mt-2" onClick={() => setConsent(true)}>
          Use that key for voices
        </Button>
      </div>
    );
  }
  if (speech?.openaiSource) {
    return (
      <div className="-mt-2 flex items-center gap-2 text-[11.5px] text-success">
        Using the API key from {sourceName(speech.openaiSource)} for voices.
        <button className="text-muted-foreground underline hover:text-foreground" onClick={() => setConsent(false)}>
          Stop using it
        </button>
      </div>
    );
  }
  return null;
}



/**
 * The system-wide hotkey, and the honest reporting around it.
 *
 * Off until somebody sets one: a global shortcut that arrives uninvited
 * will sooner or later collide with something they already use. And
 * because another app may already own the keys, registration answers
 * with what actually took rather than assuming it worked.
 */
function QuickAskShortcut() {
  const [accelerator, setAccelerator] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setAccelerator(c.shortcuts?.quickAsk ?? null))
      .catch(() => {});
  }, []);

  const save = async (next: string | null) => {
    setProblem(null);
    const took = (await window.bloks?.shortcutApply(next)) ?? null;
    if (next && !took) {
      setProblem("Another app already owns those keys. Try a different combination.");
      return;
    }
    setAccelerator(took);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shortcuts: { quickAsk: took } }),
    }).catch(() => {});
  };

  // Reading a chord off a keypress, in Electron's own spelling.
  const capture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    const key = e.key;
    if (key === "Escape") return setCapturing(false);
    // a modifier on its own is not a shortcut, it is half of one
    if (["Shift", "Control", "Alt", "Meta"].includes(key)) return;
    const parts: string[] = [];
    if (e.metaKey) parts.push("Command");
    if (e.ctrlKey) parts.push("Control");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (parts.length === 0) {
      setProblem("A global shortcut needs at least one modifier, or it would fire while you type.");
      return;
    }
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    setCapturing(false);
    void save(parts.join("+"));
  };

  if (!window.bloks) return null;

  return (
    <SettingRow
      label="Quick ask shortcut"
      info="Tab picks a different agent, Enter sends, Escape closes."
      description={
        problem ? (
          <span className="text-destructive">{problem}</span>
        ) : (
          `Ask any agent from anywhere on ${thisComputer()}. It opens one line over whatever you are doing.`
        )
      }
      control={
        <div className="flex items-center gap-1.5">
          {accelerator && !capturing && (
            <button
              onClick={() => void save(null)}
              className="rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => {
              setProblem(null);
              setCapturing(true);
            }}
            onKeyDown={capturing ? capture : undefined}
            onBlur={() => setCapturing(false)}
            className={cn(
              "min-w-[132px] rounded-lg border px-3 py-1.5 text-[12.5px] font-medium tabular-nums transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.96]",
              capturing
                ? "border-brand bg-brand-soft text-foreground"
                : "border-input text-foreground hover:border-foreground/25",
            )}
          >
            {capturing ? "Press the keys…" : (accelerator ?? "Not set")}
          </button>
        </div>
      }
    />
  );
}

interface SettingsPage {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  description: string;
  /** Words people search for that the label does not say. */
  keywords: string;
}

/** Every page, grouped the way people look for them. Opened by id from
 * anywhere in the app: `toggleAppSettings` with a `page`. */
export const SETTINGS_PAGES: Array<{ group: string; pages: SettingsPage[] }> = [
  {
    group: "You",
    pages: [
      {
        id: "general",
        label: "General",
        icon: SlidersHorizontal,
        description: `How Bloks looks and behaves on ${thisComputer()}.`,
        keywords: "theme dark light appearance sidebar conversations threads shortcut quick ask hotkey summarise compaction compact idle cache long turn tokens quota skills suggest",
      },
      {
        id: "about-you",
        label: "About you",
        icon: UserIcon,
        description: "Context every agent gets, so you do not have to repeat yourself.",
        keywords: "profile context personal instructions",
      },
    ],
  },
  {
    group: "Agents",
    pages: [
      {
        id: "engines",
        label: "Engines",
        icon: Cpu,
        description: "The AI tools and API keys your agents think with.",
        keywords: "models providers claude codex gemini grok openai api key cli sign in",
      },
      {
        id: "new-agents",
        label: "New agents",
        icon: UserPlus,
        description: "Where every new agent starts, whoever hires it.",
        keywords: "defaults folder hire approvals model effort",
      },
      {
        id: "rules",
        label: "Rules and approvals",
        icon: ShieldCheck,
        description: "How much agents do before asking you, and what they may never do.",
        keywords: "deny allow permissions safety approval gate full access auto ask conservative",
      },
      {
        id: "voices",
        label: "Voices",
        icon: Mic,
        description: "Give agents a voice and take calls with them.",
        keywords: "speech elevenlabs openai tts call audio",
      },
    ],
  },
  {
    group: "Connections",
    pages: [
      {
        id: "apps",
        label: "Apps and keys",
        icon: LayoutGrid,
        description: `Accounts and tools shared by every agent. Keys stay on ${thisComputer()}.`,
        keywords: "composio slack gmail connectors mcp servers box key claude desktop",
      },
      {
        id: "devices",
        label: "Phone and devices",
        icon: Smartphone,
        description: `Reach ${thisComputer()} from your phone and other devices.`,
        keywords: "iphone pairing remote relay qr",
      },
      {
        id: "chat",
        label: "Chat and email",
        icon: MessageCircle,
        description: "Talk to your agents from Telegram, Slack, Discord or email.",
        keywords: "telegram slack discord email mail",
      },
      {
        id: "cloud",
        label: "Bloks Cloud",
        icon: CloudIcon,
        description: "Your agents on the go, and the relay that carries them.",
        keywords: "subscription licence relay cloud",
      },
      {
        id: "computers",
        label: "Computers",
        icon: Monitor,
        description: `A private computer agents can work on, on ${thisComputer()} or in the cloud.`,
        keywords: "vm virtual machine local box sandbox desktop",
      },
    ],
  },
  {
    group: "Data",
    pages: [
      {
        id: "record",
        label: "Record",
        icon: History,
        description: "Everything that happened, signed and in order.",
        keywords: "ledger audit history log",
      },
      {
        id: "backups",
        label: "Backups",
        icon: Archive,
        description: "Copies of your whole workspace, made every day or when you ask, and putting one back.",
        keywords: "backup restore archive copy export move new computer undo history passphrase encrypt seal daily automatic",
      },
      {
        id: "about",
        label: "About and updates",
        icon: Info,
        description: "Your version, updates, and a way to tell us what broke.",
        keywords: "version update feedback diagnostics bug",
      },
    ],
  },
];

const ALL_PAGES = SETTINGS_PAGES.flatMap((g) => g.pages);

function GeneralPage() {
  const { theme, setTheme } = useTheme();
  const [conversations, setConversations] = useConversationsView();
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingRow
          label="Theme"
          control={
            <Segmented
              aria-label="Theme"
              value={theme}
              onChange={setTheme}
              options={THEME_OPTIONS.map((o) => ({ value: o.value, label: <>{o.icon}{o.label}</> }))}
            />
          }
        />
        <SettingRow
          label="Show conversations in the sidebar"
          description="List each agent's conversations under it, each with its own unread dot and state."
          control={
            <Switch
              aria-label="Show conversations in the sidebar"
              checked={conversations}
              onCheckedChange={setConversations}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Working with agents">
        <QuickAskShortcut />
        <ProposeSkills />
        <Compaction />
        <IdleCompaction />
        <BeforeTurnCompaction />
        <SilentCallLimit />
      </SettingsGroup>
    </>
  );
}

/**
 * The one approvals choice for the workspace. Picking a mode makes it
 * where every new agent starts, at once; agents already working keep
 * theirs until you move them, because a mode changing under an agent
 * mid-task is not something to do by accident.
 */
function WorkspaceApprovals() {
  const { state, save } = useWorkspaceApprovals();
  const [note, setNote] = useState<string | null>(null);
  if (!state) return null;
  const mode = state.mode;
  const total = Object.values(state.agents).reduce((a, b) => a + b, 0);
  const elsewhere = total - (state.agents[mode] ?? 0);
  const label = APPROVAL_MODES.find((m) => m.id === mode)?.label ?? mode;

  const choose = async (next: ApprovalMode) => {
    setNote(null);
    if (next === mode) return;
    if (!(await confirmWidening(mode, next, "new agents"))) {
      setNote("Not confirmed, so nothing changed.");
      return;
    }
    await save(next, false);
  };
  const applyToAll = async () => {
    setNote(null);
    if (!(await confirmWidening("ask", mode, "every agent"))) {
      setNote("Not confirmed, so nothing changed.");
      return;
    }
    await save(mode, true);
    setNote(`Every agent is on ${label} now.`);
  };

  return (
    <SettingsGroup title="How much agents ask">
      <div className="p-4">
        <ApprovalsChooser value={mode} onChange={(next) => void choose(next)} />
        <div className="mt-3 flex items-center gap-3 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 text-pretty">
            {note ??
              (elsewhere > 0
                ? `New agents start on ${label}. ${elsewhere} of your ${total} agent${total === 1 ? " is" : "s are"} on something else.`
                : `New agents start on ${label}, and so is every agent you have.`)}
          </span>
          {elsewhere > 0 && (
            <Button size="sm" variant="secondary" onClick={() => void applyToAll()}>
              Move all to {label}
            </Button>
          )}
        </div>
        <div className="mt-2 text-[12px] text-muted-foreground">
          Each agent can still be set differently in its own settings. Shared rooms always ask, whatever is set here.
        </div>
      </div>
    </SettingsGroup>
  );
}

function PageBody({ id }: { id: string }) {
  switch (id) {
    case "general":
      return <GeneralPage />;
    case "about-you":
      return <AboutYou />;
    case "engines":
      return <EnginesPanel />;
    case "new-agents":
      return <AgentDefaults />;
    case "rules":
      return (
        <>
          <WorkspaceApprovals />
          <RulesPanel />
        </>
      );
    case "voices":
      return (
        <SettingsGroup title="Keys">
          <div className="flex flex-col gap-4 p-4">
            <ApiKeyRow section="elevenlabs" label="ElevenLabs API key" placeholder="sk_…" />
            <ApiKeyRow section="openaiSpeech" label="OpenAI API key (speech)" placeholder="sk-…" />
            <OpenAIKeyHint />
            <div className="text-[12px] text-muted-foreground">Either key works. The Mac's own voices need none.</div>
          </div>
        </SettingsGroup>
      );
    case "apps":
      return (
        <>
          <SettingsGroup title="Keys">
            <div className="flex flex-col gap-4 p-4">
              <ApiKeyRow
                section="composio"
                label="Composio Connect key"
                placeholder="ck_…"
                info={{
                  text: "Composio issues two different keys. This is the Connect key (starts with ck_), the one that links accounts like Slack and Gmail. The key is checked with Composio when you save it.",
                  linkLabel: "Get a Connect key at composio.dev",
                  linkHref: "https://composio.dev",
                }}
              />
              <ApiKeyRow
                section="composioApi"
                label="Composio API key (optional)"
                placeholder="ak_…  unlocks the full app catalog"
                info={{
                  text: "The other Composio key: a project API key (starts with ak_), separate from the Connect key above. Only used to browse the full app catalog; connections work without it.",
                }}
              />
              <ApiKeyRow
                section="box"
                label="Boat API key"
                placeholder="Paste your Boat API key"
                info={{
                  text: "Gives agents an isolated remote Linux computer with a desktop and a terminal. Boat (formerly Box) is a paid service after its trial, so usage can incur charges.",
                  linkLabel: "Open the Boat API key guide",
                  linkHref: "https://docs.boat.dev/api-keys",
                }}
              />
              <BoxSleep />
            </div>
          </SettingsGroup>
          <McpServersCard />
          <UseFromOtherApps />
        </>
      );
    case "devices":
      return (
        <>
          <RemoteSection />
          <DevicesSection />
        </>
      );
    case "chat":
      return (
        <>
          <TelegramSection />
          <ChatSection />
        </>
      );
    case "cloud":
      return <CloudSection />;
    case "computers":
      return <LocalVmSection />;
    case "record":
      return <RecordPanel />;
    case "backups":
      return <BackupsSection />;
    case "about":
      return <AboutCard />;
    default:
      return null;
  }
}

export function AppSettingsPanel() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pageId = ALL_PAGES.some((p) => p.id === state.settingsPage) ? state.settingsPage : "general";
  const page = ALL_PAGES.find((p) => p.id === pageId)!;
  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const go = (id: string) => dispatch({ type: "toggleAppSettings", open: true, page: id });

  // a new page starts at its top, not wherever the last one was left
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [pageId]);

  // Escape leaves, unless something opened on top of the page takes it first
  useEscape(close);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (p: SettingsPage) =>
    words.every((w) => `${p.label} ${p.description} ${p.keywords}`.toLowerCase().includes(w));
  const groups = SETTINGS_PAGES.map((g) => ({ ...g, pages: g.pages.filter(matches) })).filter((g) => g.pages.length);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background md:flex-row">
      <nav
        aria-label="Settings"
        className="flex shrink-0 flex-col border-b bg-sidebar/60 md:w-[248px] md:border-b-0 md:border-r"
      >
        <div className="flex items-center gap-1.5 px-3 pb-2 pt-3.5">
          <button
            onClick={close}
            aria-label="Back to your agents"
            title="Back (Esc)"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96]"
          >
            <ArrowLeft size={17} />
          </button>
          <span className="text-[15px] font-semibold text-foreground">Settings</span>
        </div>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-[7px] transition-colors duration-150 focus-within:bg-accent">
            <SearchIcon size={15} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                } else if (e.key === "Enter" && groups[0]) {
                  go(groups[0].pages[0].id);
                  setQuery("");
                }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex gap-0.5 overflow-x-auto px-2 pb-2 [scrollbar-width:none] md:flex-1 md:flex-col md:overflow-y-auto md:pb-4 [&::-webkit-scrollbar]:hidden">
          {groups.map((g) => (
            <div key={g.group} className="flex shrink-0 gap-0.5 md:flex-col">
              <div className="hidden px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground md:block">
                {g.group}
              </div>
              {g.pages.map((p) => {
                const Icon = p.icon;
                const on = p.id === pageId;
                return (
                  <button
                    key={p.id}
                    onClick={() => go(p.id)}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-[background-color,color] duration-150",
                      on
                        ? "bg-background font-medium text-foreground shadow-[0_0_0_0.5px_var(--border)]"
                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                  >
                    <Icon size={16} className={on ? "text-foreground" : "text-muted-foreground"} />
                    {p.label}
                  </button>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <div className="px-3 py-6 text-[12.5px] text-muted-foreground">Nothing matches “{query.trim()}”.</div>
          )}
        </div>
      </nav>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pb-16 pt-8 md:px-10">
          <SettingsPageHeader title={page.label} description={page.description} />
          <div className="[&>div:first-child]:mt-0">
            <PageBody id={pageId} />
          </div>
        </div>
      </div>
    </main>
  );
}
