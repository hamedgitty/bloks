// Settings, General: what you are called, how Bloks looks, and the one
// shortcut that reaches it from anywhere.
//
// The person's own page, so it holds only what is theirs: their name,
// the theme and the language (which follow them into every workspace),
// the accent, how
// wide a chat reads, and the system-wide hotkey. How agents behave has a
// page of its own (settings/BehaviourPage.tsx).
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "@/components/icons";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useTheme, type Theme } from "@/lib/theme";
import { useTranscriptWidth } from "@/lib/useTranscriptWidth";
import { useConversationsView } from "@/lib/conversationsView";
import { useWorkspaces } from "@/lib/workspaces";
import { setSameAccent } from "@/lib/accent";
import { thisComputer } from "@/lib/thisComputer";
import { cn } from "@/lib/cn";
import { AccentPicker } from "../AccentPicker";
import { SettingRow, SettingsGroup } from "../SettingsLayout";
import { YourName } from "./YourName";
import { LANGUAGES, isLanguage, t, type MessageKey } from "@/lib/i18n";
import { chooseLanguage, systemLanguage, useLanguageChoice } from "@/lib/language";

const THEME_OPTIONS: Array<{ value: Theme; label: MessageKey; icon: React.ReactNode }> = [
  { value: "light", label: "generalPage.themeLight", icon: <Sun size={14} /> },
  { value: "dark", label: "generalPage.themeDark", icon: <Moon size={14} /> },
  { value: "system", label: "generalPage.themeSystem", icon: <Monitor size={14} /> },
];

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
  const [problem, setProblem] = useState<MessageKey | null>(null);

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
      setProblem("generalPage.shortcutTaken");
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
      setProblem("generalPage.shortcutNeedsModifier");
      return;
    }
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    setCapturing(false);
    void save(parts.join("+"));
  };

  if (!window.bloks) return null;

  return (
    <SettingRow
      label={t("generalPage.quickAskShortcut")}
      info={t("generalPage.tabPicksADifferentAgent")}
      description={t("generalPage.quickAskDescription", { computer: thisComputer() })}
      error={problem && t(problem)}
      control={
        <div className="flex items-center gap-1.5">
          {accelerator && !capturing && (
            <button
              onClick={() => void save(null)}
              className="rounded-lg px-2 py-1 text-body text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("common.clear")}
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
              "min-w-[132px] rounded-lg border px-3 py-1.5 text-body font-medium tabular-nums transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.96]",
              capturing
                ? "border-brand bg-brand-soft text-foreground"
                : "border-input text-foreground hover:border-foreground/25",
            )}
          >
            {capturing ? t("generalPage.pressTheKeys") : (accelerator ?? t("generalPage.notSet"))}
          </button>
        </div>
      }
    />
  );
}

/**
 * The language the interface is read in. Each language is named in its
 * own words, so somebody who landed in one they cannot read can still
 * find theirs; "System" says which one it comes to.
 */
function LanguageRow() {
  const { choice } = useLanguageChoice();
  const system = LANGUAGES.find((l) => l.code === systemLanguage())?.name ?? "English";
  return (
    <SettingRow
      label={t("language.label")}
      description={t("language.description")}
      control={
        <select
          aria-label={t("language.label")}
          value={choice}
          onChange={(e) => void chooseLanguage(isLanguage(e.target.value) ? e.target.value : "system")}
          className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-body text-foreground outline-none transition-colors hover:border-foreground/25 focus-visible:border-brand"
        >
          <option value="system">{t("language.system", { language: system })}</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      }
    />
  );
}

export function GeneralPage() {
  const { theme, setTheme } = useTheme();
  const workspaces = useWorkspaces();
  const [width, setWidth] = useTranscriptWidth();
  const [conversations, setConversations] = useConversationsView();
  const shared = Boolean(window.bloks?.workspace && workspaces.available && workspaces.sameAccent);
  return (
    <>
      <SettingsGroup title={t("generalPage.you")}>
        <YourName />
      </SettingsGroup>
      <SettingsGroup title={t("generalPage.appearance")}>
        <SettingRow
          label={t("generalPage.theme")}
          description={t("generalPage.followsYouIntoEveryWorkspace")}
          control={
            <Segmented
              aria-label={t("generalPage.theme")}
              value={theme}
              onChange={setTheme}
              options={THEME_OPTIONS.map((o) => ({ value: o.value, label: <>{o.icon}{t(o.label)}</> }))}
            />
          }
        />
        <LanguageRow />
        <SettingRow
          label={t("generalPage.accent")}
          description={
            !window.bloks?.workspace
              ? t("generalPage.yourMessagesTheMainButtons")
              : shared
                ? t("generalPage.yourMessagesTheMainButtonsAnd")
                : t("generalPage.yourMessagesTheMainButtonsAndWhat")
          }
          control={<AccentPicker />}
        />
        {/* only where there are workspaces to share it between */}
        {window.bloks?.workspace && workspaces.available && window.bloks.prefsSameAccent && (
          <SettingRow
            label={t("generalPage.sameAccentInEveryWorkspace")}
            description={t("generalPage.offEachWorkspaceKeepsIts")}
            control={
              <Switch
                aria-label={t("generalPage.sameAccentInEveryWorkspace")}
                checked={Boolean(workspaces.sameAccent)}
                onCheckedChange={(on) => void setSameAccent(on)}
              />
            }
          />
        )}
        <SettingRow
          label={t("generalPage.transcriptWidth")}
          description={t("generalPage.howWideChatsReadOn")}
          control={
            <Segmented
              aria-label={t("generalPage.transcriptWidth")}
              value={width}
              onChange={setWidth}
              options={[
                { value: "narrow", label: t("generalPage.widthNarrow") },
                { value: "medium", label: t("generalPage.widthMedium") },
                { value: "wide", label: t("generalPage.widthWide") },
              ]}
            />
          }
        />
        <SettingRow
          label={t("generalPage.showConversationsInTheSidebar")}
          description={t("generalPage.listEachAgentsConversationsUnder")}
          control={<Switch aria-label={t("generalPage.showConversationsInTheSidebar")} checked={conversations} onCheckedChange={setConversations} />}
        />
        {/* the app says whether there is one: only on a Mac */}
        {window.bloks?.prefsNotch && workspaces.available && typeof workspaces.notch === "boolean" && (
          <SettingRow
            label={t("generalPage.showWorkingAgentsInThe")}
            description={t("generalPage.whoIsAtWorkAt")}
            control={
              <Switch
                aria-label={t("generalPage.showWorkingAgentsInThe")}
                checked={workspaces.notch}
                onCheckedChange={(on) => void window.bloks?.prefsNotch?.(on)}
              />
            }
          />
        )}
        {/* the app says whether there is one: only on Windows */}
        {window.bloks?.prefsTray && workspaces.available && typeof workspaces.tray === "boolean" && (
          <SettingRow
            label={t("generalPage.minimizeToTheSystemTray")}
            description={t("generalPage.theCloseButtonHidesThe")}
            control={
              <Switch
                aria-label={t("generalPage.minimizeToTheSystemTray")}
                checked={workspaces.tray}
                onCheckedChange={(on) => void window.bloks?.prefsTray?.(on)}
              />
            }
          />
        )}
      </SettingsGroup>
      {window.bloks && (
        <SettingsGroup title={t("generalPage.shortcut")}>
          <QuickAskShortcut />
        </SettingsGroup>
      )}
    </>
  );
}
