// App-level settings, as a centered overlay: appearance plus the
// credentials shared by all agents. Per-agent settings live in
// SettingsPanel; contextual Box-token entry also stays in ComputerPanel.
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Monitor from "lucide-react/dist/esm/icons/monitor.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import { api, useStore } from "@/state/store";
import { useTheme, type Theme } from "@/lib/theme";
import { RecordPanel } from "./RecordPanel";
import { RulesPanel } from "./RulesPanel";
import { ApiKeyRow } from "./ApiKeys";
import { McpServersCard } from "./McpServers";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EnginesPanel } from "./EnginesPanel";
import { CloudSection } from "./CloudSection";
import { DevicesSection } from "./DevicesSection";
import { LocalVmSection } from "./LocalVmSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

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
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Summarise as you go</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            A long conversation has to be summarised to keep fitting. Off, that happens once when it
            fills up, which is a pause before your next message. On, one message is folded in after
            each turn instead, so it never pauses and the conversation stays about a fifth full.
          </div>
        </div>
        <Switch aria-label="Summarise as you go" checked={on} disabled={saving} onCheckedChange={set} />
      </div>
      <div className="mt-2.5 rounded-xl bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        What it costs: folding after every turn rewrites what was already sent, which means the
        provider cannot reuse its cache of this conversation. On a provider that discounts cached
        input heavily, that can cost more than the pause it removes. Your own messages are never
        summarised either way.
      </div>
    </div>
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
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Suggest skills</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            After a conversation that worked something out, read it back and write the procedure
            down as a skill. Most conversations teach nothing and nothing is suggested for them.
          </div>
        </div>
        <Switch aria-label="Suggest skills" checked={on} disabled={saving} onCheckedChange={set} />
      </div>
      <div className="mt-2.5 rounded-xl bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        Nothing is ever installed on its own. A suggestion waits in Skills with the words already
        written, and keeping it is one press. Reading a session back costs one cheap call, on your
        own key, for work you did not ask for, which is why this is off until you turn it on.
      </div>
    </div>
  );
}

/** Shared context every agent receives. Optional, never asked for up
 * front: it lives here for whenever you feel like writing it. */
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
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-semibold text-foreground">About you</div>
        {justSaved && (
          <span className="flex items-center gap-1 text-[11.5px] text-success">
            <Check size={12} /> Saved
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Optional context every agent gets. Stays on this Mac.
      </div>
      <Textarea
        value={value}
        onChange={(e) => save(e.target.value)}
        placeholder="e.g. I'm a founder building a local-first agent app. Keep replies short and skip the preamble."
        className="mt-3 min-h-[88px] resize-none text-[13px]"
      />
    </div>
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

const SETTINGS_TABS = [
  ["general", "General"],
  ["engines", "Engines"],
  ["apps", "Apps"],
  ["localvm", "Local VM"],
  ["voices", "Voices"],
  ["devices", "Devices"],
  ["rules", "Rules"],
  ["record", "Record"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];


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
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">Quick ask</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        A shortcut that works anywhere on this Mac. It opens one line over whatever
        you are doing, sends it to an agent, and gets out of the way.
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => {
            setProblem(null);
            setCapturing(true);
          }}
          onKeyDown={capturing ? capture : undefined}
          className={cn(
            "min-w-[168px] rounded-xl border px-3 py-2 text-[13px] transition-colors",
            capturing
              ? "border-brand bg-brand-soft text-foreground"
              : "border-input text-foreground hover:border-foreground/25",
          )}
        >
          {capturing ? "Press the keys…" : (accelerator ?? "Not set")}
        </button>
        {accelerator && !capturing && (
          <button
            onClick={() => void save(null)}
            className="rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {problem && <div className="mt-2 text-[12px] text-destructive">{problem}</div>}
      <div className="mt-2 text-[11.5px] text-muted-foreground">
        Tab picks a different agent, Enter sends, Escape closes.
      </div>
    </div>
  );
}

export function AppSettingsPanel() {
  const { dispatch } = useStore();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <DialogContent className="flex h-[85vh] max-h-[640px] w-full max-w-[720px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center border-b px-5">
          <DialogTitle className="text-[14.5px]">Settings</DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/*
            The category rail, which stops being a rail on a narrow
            window. Below sm it is a scrolling row above the content,
            because 150px of nav out of 375px of window leaves body copy
            wrapping every two or three words. Kept as one list rather
            than two so the tabs cannot drift apart.
          */}
          <nav
            className={cn(
              "flex shrink-0 gap-0.5 overflow-x-auto border-b p-2",
              "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              "sm:w-[150px] sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r sm:p-2.5",
            )}
          >
            {SETTINGS_TABS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-150 sm:w-full sm:text-left",
                  tab === key
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-5">
            {tab === "general" && (
              <>
                <div className="mt-4 rounded-2xl border bg-card p-4">
                  <div className="text-[13.5px] font-semibold text-foreground">Appearance</div>
                  <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                    How Bloks looks on this Mac
                  </div>
                  <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setTheme(option.value)}
                        className={cn(
                          "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                          theme === option.value
                            ? "bg-background font-medium text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option.icon}
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <QuickAskShortcut />
                <Compaction />
                <ProposeSkills />
                <AboutYou />
              </>
            )}

            {tab === "engines" && <EnginesPanel />}

            {tab === "apps" && (
              <>
              <div className="mt-4 rounded-2xl border bg-card p-4">
                <div className="text-[13.5px] font-semibold text-foreground">Apps and computers</div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  Shared by all agents. Keys stay on this Mac.
                </div>
                <div className="mt-4 flex flex-col gap-4">
                  <ApiKeyRow section="composio" label="Composio Connect key" placeholder="ck_…" />
                  <ApiKeyRow
                    section="composioApi"
                    label="Composio API key (optional)"
                    placeholder="ak_…  unlocks the full app catalog"
                  />
                  <ApiKeyRow
                    section="box"
                    label="Box API key"
                    placeholder="Paste your Box API key"
                    info={{
                      text: "Gives agents an isolated remote Linux computer with a desktop and a terminal. Box is a paid service after its trial, so usage can incur charges.",
                      linkLabel: "Open the Box API key guide",
                      linkHref: "https://docs.ascii.dev/box/api-keys",
                    }}
                  />
                </div>
              </div>
              <McpServersCard />
              </>
            )}

            {tab === "localvm" && <LocalVmSection />}

            {tab === "rules" && <RulesPanel />}

            {tab === "record" && <RecordPanel />}

            {tab === "devices" && (
              <>
                <DevicesSection />
                <CloudSection />
              </>
            )}

            {tab === "voices" && (
              <div className="mt-4 rounded-2xl border bg-card p-4">
                <div className="text-[13.5px] font-semibold text-foreground">Voices</div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  Give agents a voice and take calls with them. Either key works.
                </div>
                <div className="mt-4 flex flex-col gap-4">
                  <ApiKeyRow section="elevenlabs" label="ElevenLabs API key" placeholder="sk_…" />
                  <ApiKeyRow section="openaiSpeech" label="OpenAI API key (speech)" placeholder="sk-…" />
                  <OpenAIKeyHint />
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
