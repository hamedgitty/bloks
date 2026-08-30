// Engines: every model provider Bloks can talk to, and how you sign in.
//
// The row tells you the truth about the auth up front. OpenRouter is a
// real browser sign-in; the rest are a pasted key, a CLI that already
// holds a login, or a server on this machine. Nothing here pretends to be
// a sign-in that is really a text field.
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { api, useStore, type ProviderRow } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

const AUTH_NOTE: Record<ProviderRow["auth"], string> = {
  oauth: "Browser sign-in",
  key: "API key",
  cli: "Signs in through its own CLI",
  none: "Runs on this machine",
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
          placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : "Paste your key"}
          autoComplete="off"
          className="h-8 text-[13px]"
        />
        <Button variant="secondary" onClick={save} disabled={!key.trim()} className="w-[72px]">
          <Check size={13} />
          Save
        </Button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className={cn("text-[11.5px]", mismatched ? "text-warning" : "text-muted-foreground")}>
          {mismatched ? `Keys here usually start with ${provider.keyPrefix}` : provider.keyHint}
        </span>
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          Get one <ExternalLink size={10} />
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

  // an engine can be connected and still be down: no CLI on PATH, a key
  // the provider rejected, a local server that is not running
  const instance = state.instances.find((i) => i.driverKind === provider.kind);
  const down = instance && instance.snapshot.state !== "available";

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
          <div className="truncate text-[13.5px] font-medium text-foreground">{provider.name}</div>
          <div
            className={cn(
              "truncate text-[12px]",
              down ? "text-warning" : provider.connected ? "text-success" : "text-muted-foreground",
            )}
          >
            {down
              ? (instance!.snapshot.reason ?? "unavailable")
              : provider.connected
                ? "Connected"
                : AUTH_NOTE[provider.auth]}
          </div>
        </div>

        {provider.auth === "cli" ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {provider.connected ? "" : "Not found"}
          </span>
        ) : provider.connected ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: "disconnectProvider", kind: provider.kind })}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={act} disabled={signingIn} className="shrink-0">
            {signingIn ? (
              <Loader2 size={13} className="animate-spin" />
            ) : provider.auth === "oauth" ? (
              "Sign in"
            ) : provider.auth === "none" ? (
              "Enable"
            ) : (
              <>
                <Plus size={13} />
                Key
              </>
            )}
          </Button>
        )}
      </div>

      {open && !provider.connected && (
        <KeyForm provider={provider} onDone={() => setOpen(false)} />
      )}
      {provider.auth === "cli" && (!provider.connected || provider.needsSignIn) && (
        <div className="mt-1.5 pl-10 text-[11.5px] leading-relaxed text-muted-foreground">
          {/* Installed and installed-but-signed-out need different advice.
              Some CLIs sign in where we cannot see it, so the second is a
              hint rather than a verdict, and stays muted. */}
          {provider.connected
            ? `No sign-in detected. ${provider.signInHint ?? provider.keyHint}`
            : provider.keyHint}
        </div>
      )}
      {error && <div className="mt-1.5 pl-10 text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

function Group({ title, note, rows }: { title: string; note: string; rows: ProviderRow[] }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="border-t bg-muted/30 px-4 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{note}</div>
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

  const connected = providers.filter((p) => p.connected).length;
  // Twelve flat rows is a list you scan past. The split is the one that
  // actually changes what an agent can do.
  const agents = providers.filter((p) => p.agentic);
  const chat = providers.filter((p) => !p.agentic);

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border bg-card">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[13.5px] font-semibold text-foreground">Engines</div>
          <div className="text-[11.5px] text-muted-foreground">{connected} connected</div>
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          What your agents run on. Keys stay on this machine.
        </div>
      </div>
      <Group
        title="Agents"
        note="Run commands and read files. Install the CLI, then sign in."
        rows={agents}
      />
      <Group
        title="Chat models"
        note="Write and reason, but cannot act on your machine."
        rows={chat}
      />
    </div>
  );
}
