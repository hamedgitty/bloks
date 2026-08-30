// The skill catalog: browsing, and the honest bit.
//
// Browsing is the easy half. The half that matters is the line under a
// skill you already have. An update that would throw away something you
// wrote is not an update, so it does not get an Update button: it says
// what it would do and asks for that specifically.
import { useCallback, useEffect, useState } from "react";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type SkillState =
  | "available"
  | "current"
  | "outdated"
  | "edited"
  | "edited-and-outdated"
  | "yours"
  | "bundled";

interface Standing {
  state: SkillState;
  says: string;
  action: string | null;
  destructive: boolean;
}

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  body: string;
  sha256: string;
  author?: string;
  standing: Standing;
}

/** A word for each state, short enough to sit beside a name. */
const CHIP: Record<SkillState, { label: string; tone: string } | null> = {
  available: null,
  current: { label: "Installed", tone: "text-muted-foreground" },
  outdated: { label: "Update", tone: "text-brand-ink" },
  edited: { label: "Edited here", tone: "text-warning" },
  "edited-and-outdated": { label: "Edited here", tone: "text-warning" },
  yours: { label: "Yours", tone: "text-muted-foreground" },
  bundled: { label: "Bundled", tone: "text-muted-foreground" },
};

export function SkillCatalog({ onInstalled }: { onInstalled: () => void }) {
  const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((refresh = false) => {
    if (refresh) setRefreshing(true);
    return api(`/api/skills/registry${refresh ? "?refresh=1" : ""}`)
      .then((r) => {
        setSkills(r.skills ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = (skill: CatalogSkill) => {
    setBusy(skill.id);
    setError(null);
    api(`/api/skills/registry/${skill.id}`, { method: "POST" })
      .then(() => {
        onInstalled();
        return load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const showing = skills?.find((skill) => skill.id === open) ?? null;

  if (showing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start gap-2 pb-3">
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(null)} aria-label="Back to the catalog">
            <ArrowLeft size={15} />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-semibold text-foreground">{showing.name}</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              Version {showing.version}
              {showing.author ? ` · by ${showing.author}` : ""}
              {showing.tags.length ? ` · ${showing.tags.join(", ")}` : ""}
            </div>
          </div>
          <ActionButton skill={showing} busy={busy === showing.id} onAct={() => install(showing)} />
        </div>

        <Says standing={showing.standing} />

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border bg-card p-3.5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{showing.description}</p>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground">
            {showing.body}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between pb-2">
        <span className="text-[12.5px] text-muted-foreground">
          Skills anyone can install. They live on your machine once they are here.
        </span>
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => load(true)}>
          {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
        {skills === null && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Reading the catalog
          </div>
        )}
        {skills?.length === 0 && (
          <div className="py-10 text-center text-[13px] text-muted-foreground">
            The catalog is empty.
          </div>
        )}
        {skills?.map((skill, i) => {
          const chip = CHIP[skill.standing.state];
          return (
            <div
              key={skill.id}
              className={cn(
                "flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-accent/50",
                i > 0 && "border-t",
              )}
            >
              <button onClick={() => setOpen(skill.id)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-foreground">{skill.name}</span>
                  {chip && <span className={cn("shrink-0 text-[11px]", chip.tone)}>{chip.label}</span>}
                </span>
                <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                  {skill.standing.state === "available" ? skill.description : skill.standing.says}
                </span>
              </button>
              <ActionButton skill={skill} busy={busy === skill.id} onAct={() => install(skill)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One button, whose words are decided by the server rather than here, so
 * what it says and what it does cannot drift apart. */
function ActionButton({
  skill,
  busy,
  onAct,
}: {
  skill: CatalogSkill;
  busy: boolean;
  onAct: () => void;
}) {
  if (!skill.standing.action) {
    return (
      <span className="flex shrink-0 items-center gap-1 px-2 text-[12px] text-muted-foreground">
        <Check size={13} />
        Installed
      </span>
    );
  }
  return (
    <Button
      variant={skill.standing.destructive ? "ghost" : "secondary"}
      size="sm"
      disabled={busy}
      onClick={onAct}
      className={cn("shrink-0", skill.standing.destructive && "text-warning hover:text-warning")}
      title={skill.standing.says}
    >
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : skill.standing.destructive ? (
        <TriangleAlert size={12} />
      ) : (
        <Download size={12} />
      )}
      {skill.standing.action}
    </Button>
  );
}

/** The line that decides whether this feature is honest or not. */
function Says({ standing }: { standing: Standing }) {
  if (standing.state === "available" || standing.state === "current") return null;
  return (
    <div
      className={cn(
        "flex shrink-0 gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed",
        standing.destructive ? "bg-warning/10 text-warning" : "bg-muted/60 text-foreground",
      )}
    >
      {standing.destructive && <TriangleAlert size={14} className="mt-[2px] shrink-0" />}
      <span>
        {standing.says}
        {standing.destructive ? ". Going ahead replaces what is on this machine." : "."}
      </span>
    </div>
  );
}
