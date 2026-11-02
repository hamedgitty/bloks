// Accounts: more than one sign-in for Claude Code or Codex, and which one
// the workspace uses now (server/engine-accounts.ts, GitHub 465).
//
// The engine's own sign-in is always the first account. Each one added
// is signed in with the engine's own login, in Terminal, into a folder of
// its own; this card never sees a credential, only whether the engine
// says it is signed in. When the account in use reaches its plan limit,
// the next turn starts on the next one that can take it, on the same
// model, and stays there. Choosing one here moves the workspace to it.
//
// A server too old to know accounts answers with an error, and then this
// card is not shown at all.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, Plus, RefreshCw } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { stamp } from "@/lib/when";
import { t } from "@/lib/i18n";
import { ProviderMark } from "./ProviderIcons";
import { CopyCommand } from "./EngineSetup";

interface AccountRow {
  id: string;
  /** Null for the engine's own sign-in. */
  label: string | null;
  main: boolean;
  inUse: boolean;
  signedIn: boolean | null;
  email?: string;
  blocked: { why: "rest" | "plan" | "signedOut"; reason: string; until: number | null } | null;
  plan: { usedPercent: number; resetsAt: number | null } | null;
  running: number;
}

interface EngineRow {
  instanceId: string;
  driverKind: string;
  name: string;
  available: boolean;
  enabled: boolean;
  accounts: AccountRow[];
}

interface AccountsState {
  engines: EngineRow[];
  max: number;
  canManage: boolean;
}

/** Where a sign-in stands after Add or Sign in: Terminal opened with it
 * running, or the command to run where there is no Terminal to open. */
/** A sign-in being waited for, and how the account stood when it began:
 * signing in again to an account already signed in is done when it comes
 * back as someone else, not the moment it is looked at. */
type SigningIn = { accountId: string; command: string | null; before: { signedIn: boolean; email: string | null } };

const nameOf = (account: AccountRow) => account.label ?? t("engineAccounts.mainSignIn");

/** One line under an account: what stops it, else what it is. */
function statusOf(account: AccountRow): { text: string; warn: boolean } {
  if (account.blocked?.why === "signedOut" || account.signedIn === false) return { text: t("engineAccounts.notSignedIn"), warn: true };
  if (account.blocked) {
    const until = account.blocked.until;
    if (account.blocked.reason === "limit") {
      return { text: until ? t("engineAccounts.atLimitUntil", { until: stamp(until) }) : t("engineAccounts.atLimit"), warn: true };
    }
    return { text: until ? t("engineAccounts.restingUntil", { until: stamp(until) }) : t("engineAccounts.resting"), warn: true };
  }
  const parts: string[] = [];
  if (account.running) parts.push(t("engineAccounts.running", { count: account.running }));
  if (account.email) parts.push(account.email);
  if (account.plan) {
    parts.push(
      account.plan.resetsAt
        ? t("engineAccounts.planUsedResets", { percent: account.plan.usedPercent, at: stamp(account.plan.resetsAt) })
        : t("engineAccounts.planUsed", { percent: account.plan.usedPercent }),
    );
  }
  if (!parts.length) parts.push(account.signedIn ? t("engineAccounts.signedIn") : t("engineAccounts.signInUnknown"));
  return { text: parts.join(" · "), warn: false };
}

export function EngineAccounts() {
  const { state } = useStore();
  const [data, setData] = useState<AccountsState | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<SigningIn | null>(null);

  // Answers are numbered, so one that set out before a change and lands
  // after it never puts the old state back. Only a server too old to
  // know accounts takes the card away; one look that fails keeps it.
  const asked = useRef(0);
  const load = useCallback((fresh = false) => {
    const mine = ++asked.current;
    api(`/api/engine-accounts${fresh ? "?fresh=1" : ""}`)
      .then((body: AccountsState) => {
        if (mine === asked.current) setData({ engines: body.engines ?? [], max: body.max ?? 8, canManage: Boolean(body.canManage) });
      })
      .catch((e: { status?: number }) => {
        if (mine === asked.current && e.status === 404) setData(null);
      });
  }, []);
  useEffect(() => load(), [load, state.ticks.engineAccounts, state.instances]);

  // A sign-in finishes in Terminal, so look again every few seconds for a
  // while rather than asking for a click to say it is done.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => loadRef.current(true), 4000);
    const stop = setTimeout(() => clearInterval(timer), 5 * 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [signingIn]);
  // signed in: nothing left to wait for
  const waitingOn = signingIn ? data?.engines.flatMap((e) => e.accounts).find((a) => a.id === signingIn.accountId) : undefined;
  useEffect(() => {
    if (!signingIn || !waitingOn?.signedIn) return;
    if (!signingIn.before.signedIn || (waitingOn.email ?? null) !== signingIn.before.email) setSigningIn(null);
  }, [signingIn, waitingOn?.signedIn, waitingOn?.email]);

  if (!data || !data.engines.length) return null;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  const signIn = (accountId: string) =>
    run(async () => {
      const was = data?.engines.flatMap((e) => e.accounts).find((a) => a.id === accountId);
      const said: { opened: boolean; command: string } = await api(`/api/engine-accounts/${accountId}/signin`, { method: "POST" });
      setSigningIn({ accountId, command: said.opened ? null : said.command, before: { signedIn: was?.signedIn === true, email: was?.email ?? null } });
    });

  const add = (engine: EngineRow) =>
    run(async () => {
      const { account }: { account: { id: string } } = await api("/api/engine-accounts", {
        method: "POST",
        body: JSON.stringify({ instanceId: engine.instanceId, label: name.trim() || undefined }),
      });
      setAdding(null);
      setName("");
      const said: { opened: boolean; command: string } = await api(`/api/engine-accounts/${account.id}/signin`, { method: "POST" });
      setSigningIn({ accountId: account.id, command: said.opened ? null : said.command, before: { signedIn: false, email: null } });
    });

  const use = (engine: EngineRow, account: AccountRow) =>
    run(() => api("/api/engine-accounts/current", { method: "PUT", body: JSON.stringify({ instanceId: engine.instanceId, accountId: account.id }) }));

  const saveName = (account: AccountRow) =>
    run(async () => {
      await api(`/api/engine-accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ label: rename }) });
      setRenaming(null);
    });

  const remove = async (engine: EngineRow, account: AccountRow) => {
    const yes = await confirm({
      title: t("engineAccounts.removeTitle", { name: nameOf(account) }),
      body: t("engineAccounts.removeBody", { engine: engine.name }),
      confirmLabel: t("engineAccounts.remove"),
      destructive: true,
    });
    if (!yes) return;
    if (signingIn?.accountId === account.id) setSigningIn(null);
    await run(() => api(`/api/engine-accounts/${account.id}`, { method: "DELETE" }));
  };

  return (
    <section aria-labelledby="engine-accounts-title" className="mb-9 overflow-hidden rounded-2xl border bg-card last:mb-0">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div id="engine-accounts-title" className="text-ui font-semibold text-foreground">
              {t("engineAccounts.accounts")}
            </div>
            <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">{t("engineAccounts.intro")}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => load(true)}
            className="shrink-0 text-muted-foreground"
            aria-label={t("engineAccounts.checkAgain")}
            title={t("engineAccounts.checkAgain")}
          >
            <RefreshCw size={13} />
          </Button>
        </div>
      </div>

      {data.engines.map((engine) => {
        const added = engine.accounts.length - 1;
        const room = added < data.max;
        return (
          <div key={engine.instanceId}>
            <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-2">
              <ProviderMark driverKind={engine.driverKind} size={13} />
              <div className="min-w-0 flex-1 truncate text-small font-medium text-muted-foreground">{engine.name}</div>
              {data.canManage && room && adding !== engine.instanceId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAdding(engine.instanceId);
                    setName("");
                    setError(null);
                  }}
                  disabled={busy || !engine.available}
                  className="h-7 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Plus size={13} />
                  {t("engineAccounts.addAccount")}
                </Button>
              )}
            </div>

            {engine.accounts.map((account) => {
              const status = statusOf(account);
              const canUse = !account.inUse && engine.available && account.signedIn !== false && account.blocked?.why !== "signedOut";
              return (
                <div key={account.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3" aria-current={account.inUse ? "true" : undefined}>
                  <div className="min-w-0 flex-1">
                    {renaming === account.id ? (
                      <div className="flex gap-2">
                        <Input
                          autoFocus
                          value={rename}
                          maxLength={40}
                          onChange={(e) => setRename(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && rename.trim()) void saveName(account);
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          aria-label={t("engineAccounts.accountName")}
                          className="h-8 text-body"
                        />
                        <Button variant="secondary" size="sm" onClick={() => void saveName(account)} disabled={busy || !rename.trim()} className="h-8 shrink-0">
                          <Check size={13} />
                          {t("common.save")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-ui font-medium text-foreground">{nameOf(account)}</span>
                        {account.inUse && (
                          <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-caption font-medium text-brand">{t("engineAccounts.inUse")}</span>
                        )}
                      </div>
                    )}
                    <div className={cn("mt-0.5 truncate text-small", status.warn ? "text-warning" : "text-muted-foreground")}>{status.text}</div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {canUse && (
                      <Button variant="ghost" size="sm" onClick={() => void use(engine, account)} disabled={busy} className="text-muted-foreground hover:text-foreground">
                        {t("engineAccounts.useNow")}
                      </Button>
                    )}
                    {!account.main && data.canManage && account.signedIn !== true && (
                      <Button variant="secondary" size="sm" onClick={() => void signIn(account.id)} disabled={busy || !engine.available}>
                        {t("engineAccounts.signIn")}
                      </Button>
                    )}
                    {!account.main && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="px-2 text-muted-foreground" aria-label={t("engineAccounts.moreFor", { name: nameOf(account) })}>
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setRenaming(account.id);
                              setRename(account.label ?? "");
                            }}
                          >
                            {t("engineAccounts.rename")}
                          </DropdownMenuItem>
                          {data.canManage && account.signedIn === true && (
                            <DropdownMenuItem onClick={() => void signIn(account.id)}>{t("engineAccounts.signInAgain")}</DropdownMenuItem>
                          )}
                          {data.canManage && (
                            <DropdownMenuItem onClick={() => void remove(engine, account)} className="text-destructive focus:text-destructive">
                              {t("engineAccounts.remove")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {signingIn?.accountId === account.id && (
                    <div className="w-full text-small leading-relaxed text-muted-foreground">
                      {signingIn.command ? (
                        <>
                          <div className="mb-1.5">{t("engineAccounts.runToSignIn")}</div>
                          <CopyCommand command={signingIn.command} />
                        </>
                      ) : (
                        t("engineAccounts.terminalOpened", { engine: engine.name })
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {adding === engine.instanceId && (
              <div className="flex flex-col gap-2 border-t px-4 py-3">
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={name}
                    maxLength={40}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void add(engine);
                      if (e.key === "Escape") setAdding(null);
                    }}
                    placeholder={t("engineAccounts.namePlaceholder", { number: added + 2 })}
                    aria-label={t("engineAccounts.accountName")}
                    className="h-8 text-body"
                  />
                  <Button variant="ghost" size="sm" onClick={() => setAdding(null)} className="h-8 shrink-0">
                    {t("common.cancel")}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void add(engine)} disabled={busy} className="h-8 shrink-0">
                    {t("engineAccounts.addAndSignIn")}
                  </Button>
                </div>
                <div className="text-small leading-relaxed text-muted-foreground">{t("engineAccounts.addNote", { engine: engine.name })}</div>
              </div>
            )}

            {!data.canManage && added === 0 && (
              <div className="border-t px-4 py-3 text-small text-muted-foreground">{t("engineAccounts.addOnThisComputer")}</div>
            )}
          </div>
        );
      })}

      <div className="border-t px-4 py-2.5 text-small leading-relaxed text-muted-foreground">{t("engineAccounts.howItMoves")}</div>
      {error && (
        <div role="alert" className="border-t px-4 py-2.5 text-small text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
