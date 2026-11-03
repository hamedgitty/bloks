// OpenCode's own setup for this workspace (GitHub 484): a switch under
// OpenCode's row in Engines and, while it is on, a way to connect a
// provider there, since `opencode auth login` on its own signs in to the
// person's setup, not this one (server/opencode-setup.ts).
//
// Shown only where it can mean something: a server that knows about it
// (an older one sends no opencode section in its config) and an OpenCode
// that is installed. Connecting opens Terminal on the computer Bloks runs
// on, so a window anywhere else has the switch and nothing more.
import { useState } from "react";
import { LogIn } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, useStore } from "@/state/store";
import { CopyCommand, useOnThisComputer } from "./EngineSetup";
import { t } from "@/lib/i18n";

export function OpenCodeSetupControl({ onChanged }: { onChanged: () => void }) {
  const { state, dispatch } = useStore();
  const here = useOnThisComputer();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ opened: boolean; command: string | null } | null>(null);
  if (!state.config?.opencode) return null;
  const on = state.config.opencode.isolated;

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    setSignIn(null);
    try {
      const result = await api("/api/config", { method: "PATCH", body: JSON.stringify({ opencode: { isolated: next } }) });
      dispatch({ type: "configStatus", config: result });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setError(null);
    try {
      setSignIn(await api("/api/engines/opencode/signin", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-2.5 pl-10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-small font-medium text-foreground">{t("enginesPanel.opencodeIsolated")}</div>
          <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">{t("enginesPanel.opencodeIsolatedNote")}</div>
        </div>
        <Switch
          checked={on}
          disabled={saving}
          aria-label={t("enginesPanel.opencodeIsolated")}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>
      {on && here && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div>
            <Button size="sm" variant="secondary" onClick={() => void connect()}>
              <LogIn size={13} />
              {t("enginesPanel.opencodeConnect")}
            </Button>
          </div>
          {signIn?.opened && (
            <div className="text-small leading-relaxed text-muted-foreground">{t("enginesPanel.opencodeFinishInTerminal")}</div>
          )}
          {signIn && !signIn.opened && signIn.command && (
            <div className="text-small leading-relaxed text-muted-foreground">
              {t("engineSetup.runThisInTerminal")}
              <CopyCommand command={signIn.command} className="mt-1" />
            </div>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-1.5 text-small text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
