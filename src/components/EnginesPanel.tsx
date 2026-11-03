// Engines: every model provider Bloks can talk to, and how you sign in.
//
// The row tells you the truth about the auth up front. OpenRouter is a
// real browser sign-in; the rest are a pasted key, a CLI that already
// holds a login, or a server on this machine. Nothing here pretends to be
// a sign-in that is really a text field.
import { useState } from "react";
import { Check } from "@/components/icons";
import { ExternalLink } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Plus } from "@/components/icons";
import { api, useStore, type ProviderRow } from "@/state/store";
import { CustomEndpoints } from "./CustomEndpoints";
import { ProviderMark } from "./ProviderIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { CREDITS_ENGINE } from "@/lib/credits";
import { CodexSpeedControl } from "./CodexSpeed";
import { EngineReport } from "./EngineReport";
import { EnginePauses } from "./EnginePauses";
import { EngineAccounts } from "./EngineAccounts";
import { EngineOutdatedActions, EnginePathControl, EngineSetupActions, EngineUpdateNote } from "./EngineSetup";
import { TeamSignInNotice } from "./TeamSignInNotice";
import { t, type MessageKey } from "@/lib/i18n";

const AUTH_NOTE: Record<ProviderRow["auth"], MessageKey> = {
  oauth: "enginesPanel.auth.oauth",
  key: "enginesPanel.auth.key",
  cli: "enginesPanel.auth.cli",
  none: "enginesPanel.auth.none",
};

function KeyForm({ provider, onDone }: { provider: ProviderRow; onDone: () => void }) {
  const { dispatch } = useStore();
  const [key, setKey] = useState("");
  const mismatched = Boolean(provider.keyPrefix && key && !key.startsWith(provider.keyPrefix));

  const save = () => {
    if (!key.trim()) return;
    dispatch({ type: "connectProvider", kind: provider.kind, key: key.trim() });
    onDone();
  };

  return (
    <div className="mt-2.5">
      <div className="flex gap-2">
        <Input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") onDone();
          }}
          placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : t("enginesPanel.pasteYourKey")}
          autoComplete="off"
          className="h-8 text-body"
        />
        <Button variant="secondary" onClick={save} disabled={!key.trim()} className="w-[72px]">
          <Check size={13} />
          {t("common.save")}
        </Button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-small", mismatched ? "text-warning" : "text-muted-foreground")}>
          {mismatched ? t("enginesPanel.keysUsuallyStartWith", { prefix: provider.keyPrefix ?? "" }) : provider.keyHint}
        </span>
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-small text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          {t("enginesPanel.getOne")} <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}

function EngineRow({ provider }: { provider: ProviderRow }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  // an engine can be connected and still be down: no CLI on PATH, a key
  // the provider rejected, a local server that is not running
  const instance = state.instances.find((i) => i.driverKind === provider.kind);
  // after an install or a sign-in, only a fresh look can say it worked
  const refresh = () => {
    api("/api/providers")
      .then(({ providers }) => dispatch({ type: "providers", providers }))
      .catch(() => {});
    api("/api/instances")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {});
  };
  const down = instance && instance.snapshot.state !== "available";
  // Switched off starts no turns, however installed and signed in it is,
  // so it is said ahead of all of that (GitHub 421).
  const off = instance?.enabled === false;

  const switchTo = (on: boolean) => {
    if (!instance) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled: on }),
    })
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const signIn = () => {
    setSigningIn(true);
    setError(null);
    api(`/api/oauth/${provider.kind}/start`, { method: "POST" })
      .then(({ url }) => {
        // Electron hands this to the system browser; the callback lands
        // back on the harness, which broadcasts the new connection.
        window.open(url, "_blank", "noopener");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSigningIn(false));
  };

  const act = () => {
    if (provider.auth === "oauth") return signIn();
    if (provider.auth === "none") {
      return dispatch({ type: "connectProvider", kind: provider.kind });
    }
    setOpen((v) => !v);
  };

  return (
    <div className="border-t px-4 py-3 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ProviderMark driverKind={provider.kind} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium text-foreground">{provider.name}</div>
          <div
            className={cn(
              "truncate text-small",
              off
                ? "text-muted-foreground"
                : down || provider.needsSignIn
                  ? "text-warning"
                  : provider.connected
                    ? "text-success"
                    : "text-muted-foreground",
            )}
          >
            {/* installed without a login cannot answer, so it is not
                "Connected", however green that would look */}
            {off
              ? t("enginesPanel.switchedOff")
              : down
                ? (instance!.snapshot.reason ?? t("enginesPanel.unavailable"))
                : provider.needsSignIn
                  ? t("enginesPanel.installedNotSignedIn")
                  : provider.connected
                    ? t("common.connected")
                    : t(AUTH_NOTE[provider.auth])}
          </div>
        </div>

        {/* only once there is something to switch: an engine that is set
            up, or one switched off, which has to be able to come back */}
        {instance && (off || provider.connected) && (
          <Switch
            checked={!off}
            disabled={switching}
            aria-label={t("enginesPanel.useEngine", { name: provider.name })}
            onCheckedChange={switchTo}
          />
        )}

        {provider.auth === "cli" ? (
          <span className="shrink-0 text-small text-muted-foreground">
            {provider.connected || provider.outdated ? "" : t("enginesPanel.notFound")}
          </span>
        ) : provider.connected ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: "disconnectProvider", kind: provider.kind })}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            {t("common.disconnect")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={act} disabled={signingIn} className="shrink-0">
            {signingIn ? (
              <Loader2 size={13} className="animate-spin" />
            ) : provider.auth === "oauth" ? (
              t("enginesPanel.signIn")
            ) : provider.auth === "none" ? (
              t("enginesPanel.enable")
            ) : (
              <>
                <Plus size={13} />
                {t("enginesPanel.key")}
              </>
            )}
          </Button>
        )}
      </div>

      {open && !provider.connected && (
        <KeyForm provider={provider} onDone={() => setOpen(false)} />
      )}
      {/* an engine on the person's own key can have a monthly limit,
          set where its spending is shown (UsagePage) */}
      {provider.connected && (provider.auth === "key" || provider.auth === "oauth") && provider.kind !== CREDITS_ENGINE && (
        <button
          type="button"
          onClick={() => dispatch({ type: "openUsage", section: "limits" })}
          className="ml-10 mt-1 text-small text-muted-foreground underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline"
        >
          {t("enginesPanel.monthlySpendingLimit")}
        </button>
      )}
      {provider.auth === "cli" && provider.outdated && (
        <div className="pl-10">
          <EngineOutdatedActions kind={provider.kind} name={provider.name} onChanged={refresh} />
        </div>
      )}
      {provider.auth === "cli" && !provider.outdated && (!provider.connected || provider.needsSignIn) && (
        <div className="pl-10">
          <EngineSetupActions
            kind={provider.kind}
            name={provider.name}
            installed={provider.connected}
            signedOut={Boolean(provider.needsSignIn)}
            onChanged={refresh}
          />
        </div>
      )}
      {provider.auth === "cli" && !provider.outdated && (!provider.connected || provider.needsSignIn) && (
        <div className="mt-1.5 pl-10 text-small leading-relaxed text-muted-foreground">
          {/* Installed and installed-but-signed-out need different advice.
              Some CLIs sign in where we cannot see it, so the second is a
              hint rather than a verdict, and stays muted. */}
          {provider.connected
            ? t("enginesPanel.noSignInDetected", { hint: provider.signInHint ?? provider.keyHint })
            : provider.keyHint}
        </div>
      )}
      {provider.auth === "cli" && provider.connected && (
        <EngineUpdateNote kind={provider.kind} name={provider.name} className="ml-10 mt-2" />
      )}
      {provider.auth === "cli" && provider.command && (
        <div className="pl-10">
          <EnginePathControl
            kind={provider.kind}
            name={provider.name}
            command={provider.command}
            path={provider.path ?? null}
            onChanged={refresh}
          />
        </div>
      )}
      {provider.kind === "opencode" && state.config?.opencode !== undefined && (
        <OpenCodeIsolationControl onChanged={refresh} />
      )}
      {error && <div className="mt-1.5 pl-10 text-small text-destructive">{error}</div>}
    </div>
  );
}

function OpenCodeIsolationControl({ onChanged }: { onChanged: () => void }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isolated = state.config?.opencode?.isolated === true;

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ opencode: { isolated: next } }),
      });
      dispatch({ type: "configStatus", config: result });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2.5 pl-10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-small font-medium text-foreground">{t("enginesPanel.opencodeIsolated")}</div>
          <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">
            {t("enginesPanel.opencodeIsolatedNote")}
          </div>
        </div>
        <Switch
          checked={isolated}
          disabled={saving}
          aria-label={t("enginesPanel.opencodeIsolated")}
          onCheckedChange={(on) => void toggle(on)}
        />
      </div>
      {error && <div className="mt-1.5 text-small text-destructive">{error}</div>}
    </div>
  );
}

function Group({ title, note, rows }: { title: string; note: string; rows: ProviderRow[] }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="border-t bg-muted/30 px-4 py-2">
        <div className="text-small font-medium text-muted-foreground">
          {title}
        </div>
        <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">{note}</div>
      </div>
      {rows.map((provider) => (
        <EngineRow key={provider.kind} provider={provider} />
      ))}
    </>
  );
}

export function EnginesPanel() {
  const { state } = useStore();
  const providers = state.providers;
  if (!providers.length) return null;

  // counted the way the rows read: installed without a login is not
  // ready, and neither is one switched off
  const off = (p: ProviderRow) => state.instances.find((i) => i.driverKind === p.kind)?.enabled === false;
  const connected = providers.filter((p) => p.connected && !p.needsSignIn && !off(p)).length;
  // Twelve flat rows is a list you scan past. The split is the one that
  // actually changes what an agent can do.
  const agents = providers.filter((p) => p.agentic);
  const chat = providers.filter((p) => !p.agentic);

  return (
    <>
      <TeamSignInNotice className="mt-4" />
      <div className="mb-9 overflow-hidden rounded-2xl border bg-card last:mb-0">
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-ui font-semibold text-foreground">{t("enginesPanel.yourEngines")}</div>
            <div className="text-small text-muted-foreground">{t("enginesPanel.connectedCount", { count: connected })}</div>
          </div>
          <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
            {t("enginesPanel.whatYourAgentsRunOn")}
          </div>
        </div>
        <Group
          title={t("common.agents")}
          note={t("enginesPanel.canRunCommandsAndWork")}
          rows={agents}
        />
        <Group
          title={t("enginesPanel.chatModels")}
          note={t("enginesPanel.chatOnlyCannotActOn")}
          rows={chat}
        />
      </div>
      <EngineAccounts />
      <EnginePauses />
      <CodexSpeedControl className="mt-4" />
      <EngineReport />
      <CustomEndpoints />
    </>
  );
}
