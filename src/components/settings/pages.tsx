// The smaller Settings pages, each a group or two: what agents know about
// you, their voices, when they ask, the keys every agent shares, and the
// computer they work on. The bigger ones have files of their own beside
// this one.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { thisComputer } from "@/lib/thisComputer";
import { ApiKeyRow } from "../ApiKeys";
import { APPROVAL_MODES, ApprovalsChooser, confirmWidening, useWorkspaceApprovals, type ApprovalMode } from "../ApprovalsChooser";
import { BoxSleep } from "../BoxSleep";
import { LocalVmSection } from "../LocalVmSection";
import { RulesPanel } from "../RulesPanel";
import { SavedSecrets } from "../SavedSecrets";
import { UseFromOtherApps } from "../UseFromOtherApps";
import { SavedMark, SettingRow, SettingsGroup, SettingsSelect } from "../SettingsLayout";
import { t, type MessageKey } from "@/lib/i18n";
import type { HearingChoice } from "@/lib/hearing";
import { missingText, useEars } from "@/lib/hearingWords";

export function AboutYouPage() {
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
        label={t("pages.whatEveryAgentKnowsAbout")}
        htmlFor="about-you"
        description={t("pages.aboutYouDescription", { computer: thisComputer() })}
        control={<SavedMark on={justSaved} />}
      >
        <Textarea
          id="about-you"
          value={value}
          onChange={(e) => save(e.target.value)}
          placeholder={t("pages.imAFounderBuildingA")}
          className="mt-3 min-h-[120px] resize-y text-body"
        />
        {/* the same field Memory's About you edits, beside the notes your
            agents suggested; one value, either place */}
        <button
          type="button"
          onClick={() => dispatch({ type: "openMemory", target: "you" })}
          className="mt-2.5 rounded text-body text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("pages.seeWhatAgentsHaveLearned")}
        </button>
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


  const setConsent = (on: boolean) =>
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ speech: { useDiscoveredOpenAI: on } }),
    })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch(() => {});

  if (speech?.openaiAvailable) {
    return (
      <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3">
        <div className="text-body font-medium text-foreground">
          {speech.openaiAvailable === "codex" ? t("pages.foundKeyCodex") : t("pages.foundKeyEnv")}
        </div>
        <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">
          {t("pages.bloksCanUseItFor")}
        </div>
        <Button size="sm" variant="brand" className="mt-2" onClick={() => setConsent(true)}>
          {t("pages.useThatKeyForVoices")}
        </Button>
      </div>
    );
  }
  if (speech?.openaiSource) {
    return (
      <div className="mt-2 flex items-center gap-2 text-small text-success">
        {speech.openaiSource === "codex" ? t("pages.usingKeyCodex") : t("pages.usingKeyEnv")}
        <button type="button" className="rounded text-muted-foreground underline hover:text-foreground" onClick={() => setConsent(false)}>
          {t("pages.stopUsingIt")}
        </button>
      </div>
    );
  }
  return null;
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
    if (!(await confirmWidening(mode, next, t("pages.who.newAgents")))) {
      setNote(t("pages.nothingChanged"));
      return;
    }
    await save(next, false);
  };
  const applyToAll = async () => {
    setNote(null);
    if (!(await confirmWidening("ask", mode, t("pages.who.everyAgent")))) {
      setNote(t("pages.nothingChanged"));
      return;
    }
    await save(mode, true);
    setNote(t("pages.everyAgentOn", { mode: label }));
  };

  return (
    <SettingsGroup title={t("pages.howMuchAgentsAsk")} footnote={t("pages.eachAgentCanChangeThis")}>
      <div className="p-4">
        <ApprovalsChooser value={mode} onChange={(next) => void choose(next)} />
        <div className="mt-3 flex items-center gap-3 text-body text-muted-foreground">
          <span className="min-w-0 flex-1 text-pretty">
            {note ??
              (elsewhere > 0
                ? t("pages.approvals.elsewhere", { mode: label, elsewhere, count: total })
                : t("pages.approvals.allOn", { mode: label }))}
          </span>
          {elsewhere > 0 && (
            <Button size="sm" variant="secondary" onClick={() => void applyToAll()}>
              {t("pages.moveAllTo", { mode: label })}
            </Button>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}

/** Voices, with the Mac's own named only where there is a Mac. */
export function VoicesPage() {
  const { state } = useStore();
  const mac = state.config?.speech?.system !== false && !state.config?.hosted?.on;
  const grok = state.config?.speech?.xaiSource === "grok";
  return (
    <>
      <SettingsGroup
        title={t("pages.keys")}
        footnote={mac ? t("pages.anyOneKeyWorksThe") : t("pages.anyOneKeyWorksMac")}
      >
        <ApiKeyRow section="elevenlabs" label={t("pages.elevenlabsApiKey")} placeholder="sk_…" />
        <ApiKeyRow section="openaiSpeech" label={t("pages.openaiApiKey")} description={t("pages.usedForSpeechOnly")} placeholder="sk-…">
          <OpenAIKeyHint />
        </ApiKeyRow>
        <ApiKeyRow
          section="fishSpeech"
          label={t("pages.fishAudioApiKey")}
          description={t("pages.yourOwnClonedVoicesAnd")}
          placeholder={t("pages.pasteYourKey")}
          info={{
            text: t("pages.fishInfo"),
            linkLabel: t("pages.fishLink"),
            linkHref: "https://fish.audio",
          }}
        />
        <ApiKeyRow
          section="xaiSpeech"
          label={t("pages.xaiApiKey")}
          description={grok ? t("pages.optionalVoicesUseYourGrok") : t("pages.groksVoicesAGrokKey")}
          placeholder="xai-…"
        />
      </SettingsGroup>
      <HearingGroup />
      <SettingsGroup title={t("pages.onYourOwnMachine")} footnote={t("pages.repliesReadAloudGoOnly")}>
        <LocalServerRow
          field="chatterboxUrl"
          rowId="chatterbox-server"
          label={t("pages.chatterboxServer")}
          unset={t("pages.aChatterboxServerYouRun")}
          placeholder="http://localhost:4123"
          removeLabel={t("pages.removeTheChatterboxServer")}
        />
      </SettingsGroup>
    </>
  );
}

/** Who is hearing now, said in the row that chooses it. */
const HEARING_NOW: Record<"whisper" | "elevenlabs" | "openai" | "mac", MessageKey> = {
  whisper: "pages.hearingNow.whisper",
  elevenlabs: "pages.hearingNow.elevenlabs",
  openai: "pages.hearingNow.openai",
  mac: "pages.hearingNow.mac",
};

/**
 * Who turns what you say into text, for calls, meeting notes and voice
 * messages (server/speech.ts hearer). Automatic takes a Whisper server
 * of your own first, then ElevenLabs, then OpenAI, and the Mac's own
 * recognizer in the Mac app when none is set up. The Mac is offered only
 * where it can hear: this window, in the app on a Mac.
 */
function HearingGroup() {
  const { state, dispatch } = useStore();
  const { ears, macApp } = useEars();
  const choice = state.config?.speech?.hearing?.choice ?? "auto";
  const [error, setError] = useState<string | null>(null);

  const choose = (next: string) => {
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ speech: { hearing: next } }) })
      .then((status) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message));
  };

  const options: Array<[HearingChoice, string]> = [
    ["auto", t("pages.hearing.auto")],
    ["whisper", t("pages.hearing.whisper")],
    // product names, the same in every language
    ["elevenlabs", "ElevenLabs"],
    ["openai", "OpenAI"],
    ...(macApp || choice === "mac" ? [["mac", t("pages.hearing.mac")] as [HearingChoice, string]] : []),
  ];
  const now = ears.kind === "none" ? missingText(ears.missing) : t(HEARING_NOW[ears.kind === "server" ? ears.by : "mac"]);

  return (
    <SettingsGroup title={t("pages.hearingTitle")} footnote={t("pages.hearingFootnote")}>
      <SettingRow
        label={t("pages.whoHearsYou")}
        htmlFor="hearing-choice"
        description={now}
        error={error}
        control={
          <SettingsSelect id="hearing-choice" value={choice} onChange={(e) => choose(e.target.value)} disabled={!state.config}>
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <LocalServerRow
        field="whisperUrl"
        rowId="whisper-server"
        label={t("pages.whisperServer")}
        unset={t("pages.aWhisperServerYouRun")}
        placeholder="http://localhost:8000"
        removeLabel={t("pages.removeTheWhisperServer")}
      />
    </SettingsGroup>
  );
}

/**
 * Where a server of the person's own listens, on this computer or the
 * local network: a Chatterbox server that speaks, or a Whisper server
 * that hears. Not a key, so it is shown back once saved; the server
 * checks the address is local before keeping it, and says why when it
 * is not.
 */
function LocalServerRow({
  field,
  rowId,
  label,
  unset,
  placeholder,
  removeLabel,
}: {
  field: "chatterboxUrl" | "whisperUrl";
  rowId: string;
  label: string;
  unset: string;
  placeholder: string;
  removeLabel: string;
}) {
  const { state, dispatch } = useStore();
  const speech = state.config?.speech;
  const saved = (field === "chatterboxUrl" ? speech?.chatterboxUrl : speech?.hearing?.whisperUrl) ?? "";
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(state.config) && (!saved || editing);
  const inputId = `${rowId}-url`;

  const put = (url: string) => {
    setBusy(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ speech: { [field]: url } }) })
      .then((status) => {
        dispatch({ type: "configStatus", config: status });
        setEditing(false);
        setValue("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div data-setting-row={rowId} className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-[220px]">
          <label htmlFor={inputId} className="text-ui font-medium text-foreground">
            {label}
          </label>
          <div className="mt-0.5 text-pretty text-body text-muted-foreground">
            {saved ? <code className="font-mono text-small text-foreground">{saved}</code> : unset}
          </div>
        </div>
        {saved && (
          <div className="-mr-2 flex shrink-0 items-center gap-0.5">
            <span aria-live="polite" className="mr-2 inline-flex items-center gap-1.5 text-small font-medium text-success">
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {t("common.saved")}
            </span>
            {!editing && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setValue(saved); setEditing(true); }}>
                {t("common.change")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => put("")}
              aria-label={removeLabel}
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              {t("common.remove")}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="mt-3 flex gap-2">
          <Input
            id={inputId}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) put(value.trim());
              if (e.key === "Escape" && editing) {
                e.preventDefault();
                setEditing(false);
              }
            }}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            className="h-8 min-w-0 flex-1 font-mono text-body"
          />
          <Button variant={value.trim() ? "brand" : "secondary"} onClick={() => put(value.trim())} disabled={busy || !value.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : t("common.save")}
          </Button>
          {editing && (
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-small text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function RulesPage() {
  return (
    <>
      <WorkspaceApprovals />
      <RulesPanel />
    </>
  );
}

/** The keys every agent shares, and the way in from other AI apps. A
 * cloud computer's key lives with Computers, beside the computer itself. */
export function AppsPage() {
  return (
    <>
      <SettingsGroup title="Composio" footnote={t("pages.keysStayOnThisComputer")}>
        <ApiKeyRow
          section="composio"
          label={t("pages.composioConnectKey")}
          description={t("pages.linksAccountsLikeSlackAnd")}
          placeholder="ck_…"
          info={{
            text: t("pages.composioConnectInfo", { prefix: "ck_" }),
            linkLabel: t("pages.composioConnectLink"),
            linkHref: "https://composio.dev",
          }}
        />
        <ApiKeyRow
          section="composioApi"
          label={t("pages.composioApiKey")}
          description={t("pages.optionalLetsYouBrowseThe")}
          placeholder="ak_…"
          info={{
            text: t("pages.composioApiInfo", { prefix: "ak_" }),
          }}
        />
      </SettingsGroup>
      <SavedSecrets />
      {/* MCP servers are managed in Plugins now, beside apps and skills */}
      <UseFromOtherApps />
    </>
  );
}

/** Computers: the Local VM and a cloud computer on a Mac; on a hosted
 * workspace, what the agents' computer is instead, since the machine
 * itself is it. */
export function ComputersPage() {
  const { state } = useStore();
  if (state.config?.hosted?.on) {
    return (
      <SettingsGroup title={t("pages.thisMachine")}>
        <SettingRow
          label={t("pages.browserAndVirtualDesktop")}
          description={
            state.config.hosted.desktop
              ? t("pages.agentsWorkInThisMachines")
              : t("pages.agentsWorkInThisMachinesBrowser")
          }
        />
        <SettingRow label={t("pages.cloudComputerAndLocalVm")} description={t("pages.notOfferedHereThisMachine")} />
      </SettingsGroup>
    );
  }
  return (
    <>
      <LocalVmSection />
      <SettingsGroup title={t("pages.cloudComputer")} footnote={t("pages.boatIsPaidAfterIts")}>
        <ApiKeyRow
          section="box"
          label={t("pages.boatApiKey")}
          description={t("pages.aPrivateLinuxComputerIn")}
          placeholder={t("pages.pasteYourBoatApiKey")}
          info={{
            text: t("pages.boatInfo"),
            linkLabel: t("pages.boatLink"),
            linkHref: "https://docs.boat.dev/api-keys",
          }}
        />
        <BoxSleep />
      </SettingsGroup>
    </>
  );
}
