// A member's own apps and keys (server/personal.ts): what their agents use
// when they talk to them privately in this workspace, and nowhere else.
//
// Two groups. Apps: their own Composio key, which signs them in to Gmail,
// Calendar and the rest as themselves, and the apps behind it, each
// connected or not. Keys: secrets by name, which their private turns have
// in their environment. Nothing typed here is ever shown back, not even to
// them: a key by its last four characters, a secret by its name.
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { SettingRow, SettingsGroup, SettingsPageHeader } from "@/components/SettingsLayout";
import { memberApi, type MemberConnections, type MemberWorkspace } from "@/lib/memberMode";
import { formatDate, t } from "@/lib/i18n";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-16 pt-10 sm:px-8">{children}</div>
    </main>
  );
}

/** An app's letter, the same as the owner's grid falls back to: the icons
 * route there is the owner's, and a member reaches none of theirs. */
function Letter({ label }: { label: string }) {
  return (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-small font-semibold text-muted-foreground">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ConnectionsPage({ workspace }: { workspace: MemberWorkspace }) {
  const owner = workspace.owner.name;
  const [own, setOwn] = useState<MemberConnections | null>(null);
  const [states, setStates] = useState<Record<string, { connected: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await memberApi.connections();
      setOwn(next);
      setError(null);
      if (next.apps.connected) {
        const apps = await memberApi.apps().catch((e: Error) => {
          setError(e.message);
          return null;
        });
        setStates(apps?.services ?? null);
      } else setStates(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = async () => {
    if (!key.trim() || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await memberApi.setAppsKey(key.trim());
      setKey("");
      toast.success(t("memberConnections.keySaved"));
      await load();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(false);
    }
  };

  const dropKey = async () => {
    const yes = await confirm({
      title: t("memberConnections.removeKeyTitle"),
      body: t("memberConnections.removeKeyBody"),
      confirmLabel: t("memberConnections.remove"),
      destructive: true,
    });
    if (!yes) return;
    try {
      await memberApi.dropAppsKey();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const connect = async (slug: string, label: string) => {
    setBusyApp(slug);
    try {
      const { url } = await memberApi.connectApp(slug);
      window.open(url, "_blank", "noopener");
      toast(t("memberConnections.finishSigningIn", { app: label }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyApp(null);
    }
  };

  const disconnect = async (slug: string, label: string) => {
    const yes = await confirm({
      title: t("memberConnections.disconnectTitle", { app: label }),
      body: t("memberConnections.disconnectBody", { app: label }),
      confirmLabel: t("memberConnections.disconnect"),
      destructive: true,
    });
    if (!yes) return;
    setBusyApp(slug);
    try {
      await memberApi.disconnectApp(slug);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyApp(null);
    }
  };

  const saveSecret = async () => {
    const clean = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
    if (!clean || !value.trim() || savingSecret) return;
    setSavingSecret(true);
    setSecretError(null);
    try {
      setOwn(await memberApi.saveSecret(clean, value));
      setName("");
      setValue("");
      toast.success(t("memberConnections.secretSaved", { name: clean }));
    } catch (e) {
      setSecretError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSecret(false);
    }
  };

  const forgetSecret = async (secret: string) => {
    const yes = await confirm({
      title: t("memberConnections.forgetTitle", { name: secret }),
      body: t("memberConnections.forgetBody"),
      confirmLabel: t("memberConnections.forget"),
      destructive: true,
    });
    if (!yes) return;
    try {
      setOwn(await memberApi.forgetSecret(secret));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page>
      <SettingsPageHeader title={t("memberConnections.title")} description={t("memberConnections.description", { owner })} />
      {error && (
        <p role="alert" className="-mt-4 mb-6 px-1 text-pretty text-small text-destructive">
          {error}
        </p>
      )}
      {!own ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : (
        <>
          <SettingsGroup
            title={t("memberConnections.apps")}
            action={
              own.apps.connected ? (
                <Button size="sm" variant="ghost" onClick={() => void load()} aria-label={t("common.checkAgain")}>
                  <RefreshCw size={13} />
                  {t("common.checkAgain")}
                </Button>
              ) : undefined
            }
          >
            {own.apps.connected ? (
              <SettingRow
                label={t("memberConnections.yourKey")}
                description={t("memberConnections.keyEnds", { ending: own.apps.ending ?? "" })}
                control={
                  <Button size="sm" variant="ghost" onClick={() => void dropKey()}>
                    {t("memberConnections.remove")}
                  </Button>
                }
              />
            ) : (
              <SettingRow label={t("memberConnections.yourKey")} description={t("memberConnections.keyHow")} htmlFor="member-apps-key" error={keyError}>
                <form
                  className="mt-3 flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveKey();
                  }}
                >
                  <Input
                    id="member-apps-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setKeyError(null);
                    }}
                    placeholder="ck_…"
                    className="min-w-0 flex-1 basis-[220px]"
                  />
                  <Button type="submit" disabled={!key.trim() || savingKey}>
                    {savingKey && <Loader2 size={14} className="animate-spin" />}
                    {t("common.save")}
                  </Button>
                </form>
              </SettingRow>
            )}
            {own.apps.connected &&
              (own.apps.list ?? []).map((app) => {
                const on = states?.[app.slug]?.connected === true;
                return (
                  <SettingRow
                    key={app.slug}
                    label={
                      <span className="flex items-center gap-2.5">
                        <Letter label={app.label} />
                        {app.label}
                      </span>
                    }
                    description={on ? t("memberConnections.connectedAsYou") : app.blurb}
                    control={
                      busyApp === app.slug ? (
                        <Loader2 size={15} className="animate-spin text-muted-foreground" aria-label={t("memberConnections.working")} />
                      ) : on ? (
                        <span className="flex items-center gap-1">
                          <span className="flex items-center gap-1 text-small text-muted-foreground">
                            <Check size={13} />
                            {t("memberConnections.connected")}
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => void disconnect(app.slug, app.label)}>
                            {t("memberConnections.disconnect")}
                          </Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => void connect(app.slug, app.label)} disabled={states === null}>
                          {t("memberConnections.connect")}
                        </Button>
                      )
                    }
                  />
                );
              })}
          </SettingsGroup>

          <SettingsGroup title={t("memberConnections.keys")} footnote={t("memberConnections.keysFootnote")}>
            <SettingRow label={t("memberConnections.addKey")} description={t("memberConnections.addKeyHow")} error={secretError}>
              <form
                className="mt-3 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveSecret();
                }}
              >
                <Input
                  aria-label={t("memberConnections.keyName")}
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  maxLength={60}
                  onChange={(e) => {
                    setName(e.target.value);
                    setSecretError(null);
                  }}
                  placeholder="TRANSISTOR_API_KEY"
                  className="min-w-0 flex-1 basis-[180px] font-mono"
                />
                <Input
                  aria-label={t("memberConnections.keyValue")}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setSecretError(null);
                  }}
                  placeholder={t("memberConnections.value")}
                  className="min-w-0 flex-1 basis-[180px]"
                />
                <Button type="submit" disabled={!name.trim() || !value.trim() || savingSecret}>
                  {savingSecret && <Loader2 size={14} className="animate-spin" />}
                  {t("common.add")}
                </Button>
              </form>
            </SettingRow>
            {own.secrets.length ? (
              own.secrets.map((secret) => (
                <SettingRow
                  key={secret.name}
                  label={<span className="font-mono text-body">{secret.name}</span>}
                  description={t("memberConnections.savedOn", { date: formatDate(secret.savedAt, { dateStyle: "medium" }) })}
                  control={
                    <Button size="icon-sm" variant="ghost" aria-label={t("memberConnections.forgetNamed", { name: secret.name })} onClick={() => void forgetSecret(secret.name)}>
                      <Trash2 size={14} />
                    </Button>
                  }
                />
              ))
            ) : (
              <p className="px-5 py-4 text-pretty text-body text-muted-foreground">{t("memberConnections.noKeys")}</p>
            )}
          </SettingsGroup>
          <p className="px-1 text-pretty text-small text-muted-foreground">{t("memberConnections.whereKept", { owner })}</p>
        </>
      )}
    </Page>
  );
}
