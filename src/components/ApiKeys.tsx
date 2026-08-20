// The paste-a-key rows.
//
// Write-only, in both directions: what is typed goes to the server and
// nothing ever comes back. Reading the config says whether a credential
// exists, never what it is, so a key cannot be recovered from the screen
// that set it.
//
// Saving rebuilds the engines server-side, which is why a pasted key
// works on the next message rather than after a restart.
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import HelpCircle from "lucide-react/dist/esm/icons/help-circle.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export type ConfigSection = "composio" | "composioApi" | "box" | "elevenlabs" | "openaiSpeech";

const SECTIONS: Record<
  ConfigSection,
  { body: (value: string) => unknown; flag: (config: ConfigStatus) => boolean }
> = {
  composio: { body: (v) => ({ composio: { key: v } }), flag: (c) => c.composio.configured },
  elevenlabs: {
    body: (v) => ({ speech: { elevenlabsKey: v } }),
    flag: (c) => c.speech?.elevenlabs ?? false,
  },
  openaiSpeech: {
    body: (v) => ({ speech: { openaiKey: v } }),
    flag: (c) => c.speech?.openai ?? false,
  },
  composioApi: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.apiKeyConfigured ?? false,
  },
  box: { body: (v) => ({ box: { token: v } }), flag: (c) => c.box.configured },
};

export function ApiKeyRow({
  section,
  label,
  placeholder,
  onSaved,
  info,
}: {
  section: ConfigSection;
  label: string;
  placeholder: string;
  /** Fires once the save lands, with whether that section now has a
   * credential, so the surrounding UI can stop saying it is missing. */
  onSaved?: (configured: boolean) => void;
  /** A small ? beside the label that opens an explainer, with an
   * optional guide link. */
  info?: { text: string; linkLabel?: string; linkHref?: string };
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify(SECTIONS[section].body(value.trim())),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
        <span
          className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-muted-foreground/30")}
        />
        {label}
        {configured && <span className="text-[11px] font-normal text-success">Connected</span>}
        {info && (
          <button
            onClick={() => setInfoOpen(!infoOpen)}
            className={cn(
              "ml-auto rounded-full p-0.5 transition-colors",
              infoOpen ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
            )}
            aria-label={`About ${label}`}
          >
            <HelpCircle size={14} />
          </button>
        )}
      </div>
      {info && infoOpen && (
        <div className="mb-2 rounded-xl bg-muted/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          {info.text}
          {info.linkHref && (
            <a
              href={info.linkHref}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex items-center gap-1 font-medium text-brand-ink hover:underline"
            >
              {info.linkLabel ?? "Learn more"}
              <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? "••••••••  (paste to replace)" : placeholder}
          autoComplete="off"
          className="h-8 text-[13px]"
        />
        <Button
          variant={clearing ? "destructive" : "secondary"}
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className="w-[72px]"
          title={clearing ? "Remove the saved key" : "Save"}
        >
          {saving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : clearing ? (
            "Clear"
          ) : (
            <>
              <Check size={13} />
              Save
            </>
          )}
        </Button>
      </div>
      {error && <div className="mt-1 text-[12px] text-destructive">{error}</div>}
    </div>
  );
}
