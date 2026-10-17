import { useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { codexSpeedRoute, resolveCodexSpeed, REMOTE_CODEX_SPEED_REASON, type CodexSpeed } from "../../server/codex-speed.ts";

export function CodexSpeedControl({ bot }: { bot?: Bot }) {
  const { state, dispatch } = useStore();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const choice = resolveCodexSpeed(state.config ?? {}, bot);
  const routes = bot ? [bot.modelSelection, bot.backupSelection].filter((p) => p != null).map((pick) => {
    const instance = state.instances.find((i) => i.instanceId === pick!.instanceId);
    const route = codexSpeedRoute(instance?.driverKind, pick!.model);
    const model = instance?.models.options.find((m) => m.id === pick!.model);
    const fresh = instance?.models.checkedAt && Date.now() - instance.models.checkedAt < 300_000;
    return { route, fast: fresh ? model?.codexFast : undefined };
  }) : [];
  const native = routes.filter((r) => r.route === "native");
  const remote = routes.some((r) => r.route === "remote-unsupported");
  const save = async (value: CodexSpeed | null) => {
    setError("");
    if (bot) {
      dispatch({ type: "updateBot", botId: bot.id, patch: { codexSpeed: value } });
      return;
    }
    if (!value) return;
    setSaving(true);
    try {
      const result = await api("/api/config", { method: "PATCH", body: JSON.stringify({ codex: { speed: value } }) });
      dispatch({ type: "configStatus", config: result });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save Codex speed"); }
    finally { setSaving(false); }
  };
  if (!state.config) return <p role="status">Loading Codex speed...</p>;
  return <section className="rounded-2xl border bg-card p-4" aria-label={bot ? "Agent Codex speed" : "Workspace Codex speed"}>
    <div className="text-[13.5px] font-semibold">Codex speed{bot ? "" : " workspace default"}</div>
    <select aria-label="Codex speed" className="mt-3 rounded-lg border bg-background p-2 text-[13px]" disabled={saving}
      value={bot ? choice.override ?? "inherit" : choice.default} onChange={(e) => void save(e.target.value === "inherit" ? null : e.target.value as CodexSpeed)}>
      {bot && <option value="inherit">Use workspace default</option>}
      <option value="standard">Standard</option><option value="fast" disabled={native.some((r) => r.fast === false)}>Fast{native.some((r) => r.fast === false) ? " (unavailable for selected model)" : ""}</option>
    </select>
    <p className="mt-2 text-[12.5px] text-muted-foreground">Resolved: {choice.resolved === "fast" ? "Fast" : "Standard"}. Source: {choice.source === "agent" ? "Agent override" : "Workspace default"}.</p>
    <p className="mt-1 text-[12px] text-muted-foreground">For Bloks Codex calls, this choice takes precedence over ordinary host and project settings. It does not edit those files.</p>
    <p className="mt-1 text-[12px] text-muted-foreground">One preference for primary and backup Codex. Changes apply to subsequent dispatches; a running turn keeps its choice. Actual execution tier is unverified.</p>
    <p className="mt-1 text-[12px] text-muted-foreground">Fast uses more quota: <a className="underline" href="https://learn.chatgpt.com/docs/agent-configuration/speed" target="_blank" rel="noreferrer">2.5x included usage, 2x purchased credits</a>.</p>
    {remote && <p role="status" className="mt-2 text-[12px]">Unavailable for Box/Boat Codex: {REMOTE_CODEX_SPEED_REASON} Saved choices are kept.</p>}
    {native.length > 0 && <p className="mt-1 text-[12px]">Fast capability: {native.some((r) => r.fast === false) ? "unavailable for a selected Codex model" : native.every((r) => r.fast === true) ? "reported by the current Codex catalog" : "unknown"}. Configured tier is checked before model input.</p>}
    {bot && !remote && !native.length && <p className="mt-1 text-[12px]">Preference saved for Codex; current primary and backup use other engines.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
