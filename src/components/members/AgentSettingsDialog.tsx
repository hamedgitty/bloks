// An agent's settings, for the people in a workspace: the owner looking
// after an agent a member made, an admin any agent, a member the agents
// they made (src/lib/agentSettings.ts says how, server/access.ts who).
//
// One dialog, opened from the Members page and from an agent in a
// member's app. Like the other decisions on that page it saves with one
// button, and an error appears where the decision is made. A control that
// is off for this person stays on screen, off, with the reason under it.
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "@/components/icons";
import { BlokAvatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { SettingsSelect } from "@/components/SettingsLayout";
import { APPROVAL_MODES } from "@/components/ApprovalsChooser";
import { api } from "@/state/store";
import { computerOptions } from "@/lib/hosted";
import {
  approvalAllowed,
  changesOf,
  computerAllowed,
  draftOf,
  effortChoices,
  settingsPath,
  type AgentSettingsView,
  type SettingsDraft,
} from "@/lib/agentSettings";
import type { BlokColor, BlokShape } from "@/lib/mascot";
import type { Effort } from "@/lib/effort";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-small text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-pretty text-small leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Why a control is off, said under it. */
function Held({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("rounded-lg bg-muted/60 px-3 py-2 text-pretty text-small leading-relaxed text-muted-foreground", className)}>{children}</p>;
}

export function AgentSettingsDialog({
  agentId,
  via,
  onOpenChange,
  onSaved,
}: {
  /** The agent, or null for the dialog closed. */
  agentId: string | null;
  /** The owner's way in, or a member's (an admin is one). */
  via: "owner" | "member";
  onOpenChange: (open: boolean) => void;
  onSaved?: (view: AgentSettingsView) => void;
}) {
  const [view, setView] = useState<AgentSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setView(null);
    setDraft(null);
    setError(null);
    if (!agentId) return;
    let live = true;
    api(settingsPath(via, agentId))
      .then((next: AgentSettingsView) => {
        if (!live) return;
        setView(next);
        setDraft(draftOf(next));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [agentId, via]);

  const changes = useMemo(() => (view && draft ? changesOf(view, draft) : {}), [view, draft]);
  const changed = Object.keys(changes).length > 0;
  const set = (patch: Partial<SettingsDraft>) => setDraft((was) => (was ? { ...was, ...patch } : was));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!view || !agentId || !changed) return;
    setBusy(true);
    setError(null);
    try {
      const next: AgentSettingsView = await api(settingsPath(via, agentId), { method: "PATCH", body: JSON.stringify(changes) });
      onSaved?.(next);
      toast.success(t("agentSettings.saved", { agent: next.agent.name }));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const owner = view?.owner.name ?? "";
  const engine = view && draft ? view.engines.find((x) => x.id === draft.engine) : undefined;
  const efforts = view && draft ? effortChoices(view, draft) : [];
  const anyEngineHeld = Boolean(view?.engines.some((x) => !x.allowed));
  const computers = view ? computerOptions(view.computers as Parameters<typeof computerOptions>[0]) : [];
  const about = !view
    ? null
    : view.agent.madeBy
      ? t("agentSettings.madeBy", { name: view.agent.madeBy.name, agent: view.agent.name })
      : view.agent.mine && view.agent.solo && via === "member"
        ? t("agentSettings.yours", { agent: view.agent.name, owner })
        : !view.agent.solo
          ? t("agentSettings.team", { agent: view.agent.name })
          : null;

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-[520px] flex-col p-0">
        <form onSubmit={(e) => void save(e)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start gap-3 px-5 pt-5 pr-12">
            {view && <BlokAvatar color={view.agent.color as BlokColor} shape={(view.agent.shape ?? undefined) as BlokShape | undefined} size={34} />}
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>{view ? t("settingsPanel.agentsSettings", { name: view.agent.name }) : t("common.settings")}</DialogTitle>
              <DialogDescription>{about ?? t("common.loading")}</DialogDescription>
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-2">
            {!view || !draft ? (
              error ? (
                <p role="alert" className="text-body text-destructive">
                  {error}
                </p>
              ) : (
                <div className="flex flex-col gap-3" aria-busy="true">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )
            ) : (
              <div className="flex flex-col gap-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("common.name")} htmlFor="agent-settings-name">
                    <Input id="agent-settings-name" value={draft.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} required />
                  </Field>
                  <Field label={t("settingsPanel.title")} htmlFor="agent-settings-title">
                    <Input id="agent-settings-title" value={draft.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
                  </Field>
                </div>
                <Field label={t("common.instructions")} htmlFor="agent-settings-instructions" hint={t("settingsPanel.itReadsTheseBeforeEvery")}>
                  <Textarea
                    id="agent-settings-instructions"
                    className="min-h-[104px] resize-y text-ui leading-relaxed"
                    placeholder={t("settingsPanel.whatThisAgentIsFor")}
                    value={draft.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("common.engine")} htmlFor="agent-settings-engine">
                    <SettingsSelect
                      id="agent-settings-engine"
                      className="w-full"
                      value={draft.engine ?? ""}
                      onChange={(e) => {
                        const next = view.engines.find((x) => x.id === e.target.value);
                        if (next) set({ engine: next.id, model: next.default || next.models[0]?.id || null });
                      }}
                    >
                      {!draft.engine && <option value="">{t("agentSettings.noEngine")}</option>}
                      {view.engines.map((x) => (
                        <option key={x.id} value={x.id} disabled={!x.allowed && x.id !== view.settings.modelSelection?.instanceId}>
                          {x.name}
                        </option>
                      ))}
                    </SettingsSelect>
                  </Field>
                  <Field label={t("settingsPanel.model")} htmlFor="agent-settings-model">
                    <SettingsSelect
                      id="agent-settings-model"
                      className="w-full"
                      value={draft.model ?? ""}
                      disabled={!engine?.models.length}
                      onChange={(e) => set({ model: e.target.value })}
                    >
                      {/* a model somebody typed in, or one the engine no longer lists, stays named */}
                      {draft.model && !engine?.models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                      {engine?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </SettingsSelect>
                  </Field>
                </div>
                {anyEngineHeld && <Held className="-mt-3">{t("agentSettings.engineHeld", { owner })}</Held>}
                {efforts.length > 1 && (
                  <Field label={t("settingsPanel.reasoningEffort")}>
                    <Segmented
                      aria-label={t("settingsPanel.reasoningEffort")}
                      value={(draft.effort ?? undefined) as Effort | undefined}
                      onChange={(next) => set({ effort: next ?? null })}
                      options={efforts}
                    />
                  </Field>
                )}

                <Field label={t("agentSettings.approvals")} hint={APPROVAL_MODES.find((m) => m.id === draft.approvals)?.hint}>
                  <Segmented
                    aria-label={t("agentSettings.approvals")}
                    value={draft.approvals}
                    onChange={(next) => set({ approvals: next })}
                    options={APPROVAL_MODES.map((m) => ({ value: m.id, label: m.label, disabled: !approvalAllowed(view, m.id) }))}
                  />
                </Field>
                {view.held.approvals && <Held className="-mt-3">{t("agentSettings.approvalsHeld", { owner })}</Held>}

                <div className="flex flex-col divide-y rounded-xl border">
                  <label className="flex items-center gap-3 px-3.5 py-3">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-ui text-foreground">{t("settingsPanel.itsOwnBrowser")}</span>
                      <span className="text-pretty text-small text-muted-foreground">{t("settingsPanel.forWebTasksLikeComparing")}</span>
                    </span>
                    <Switch checked={draft.browser} onCheckedChange={(browser) => set({ browser })} aria-label={t("settingsPanel.itsOwnBrowser")} />
                  </label>
                  <div className="flex flex-col gap-2 px-3.5 py-3">
                    <div className="flex items-center gap-3">
                      <label htmlFor="agent-settings-computer" className="flex-1 text-ui text-foreground">
                        {t("settingsPanel.computer")}
                      </label>
                      <SettingsSelect
                        id="agent-settings-computer"
                        value={draft.computer ?? ""}
                        onChange={(e) => set({ computer: e.target.value || null })}
                      >
                        <option value="">{t("settingsPanel.automatic")}</option>
                        {computers.map(([id, label]) => (
                          <option key={id} value={id} disabled={!computerAllowed(view, id)}>
                            {label}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    {view.held.computer && <Held>{t("agentSettings.computerHeld", { owner })}</Held>}
                  </div>
                </div>
              </div>
            )}
          </div>

          {view && error && (
            <p role="alert" className="px-5 pt-2 text-body text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t px-5 py-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !changed || !draft?.name.trim()}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
