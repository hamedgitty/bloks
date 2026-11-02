// A skill opened: what it says, every version it has been, and what each
// one changed.
//
// Shown wherever a skill opens (the Skills page and Settings, Plugins),
// so "who changed this, and why" is answered beside the text rather than
// somewhere else. Three things a person does here:
//
//   Edit it. The edit is saved against the version it started from, so
//   one made while a suggestion was kept is refused rather than written
//   over the top. A built-in is never edited; "Make it yours" copies it,
//   and the copy keeps its versions from the text as it shipped.
//
//   Read the history: who made each version (you, an agent, a suggestion
//   you kept, the catalogue), when, the one line on why, and how often
//   that version was used and then corrected.
//
//   Compare any two, and put an earlier one back. Restoring adds a
//   version rather than removing any, so it can itself be undone.
import { useCallback, useEffect, useState } from "react";
import { History, Loader2, Pencil, RotateCcw } from "@/components/icons";
import { api, type Skill } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { stamp } from "@/lib/when";
import { MAX_SKILL_CHARS } from "@/lib/skillLength";
import { DiffLines, type DiffLine } from "./DiffLines";
import { SkillFiles } from "./SkillFiles";
import { SettingsSelect } from "./SettingsLayout";
import { t } from "@/lib/i18n";

export interface Author {
  kind: "person" | "agent" | "proposal" | "catalog" | "import" | "file" | "migration" | "builtin";
  name?: string;
}

export interface VersionRow {
  n: number;
  at: number;
  by: Author;
  why: string;
  chars: number;
  restoredFrom?: number;
  uses: number;
  corrected: number;
  lastUsed: number | null;
}

interface SkillHistoryAnswer {
  id: string;
  builtin: boolean;
  /** A copy of a built-in, which can always go back to the shipped text. */
  shipped?: boolean;
  current: number;
  /** Newest first. */
  revisions: VersionRow[];
  usage: { uses: number; corrected: number; lastUsed: number | null };
  pruned: boolean;
  max: number;
}

interface DiffAnswer {
  from: number;
  to: number;
  lines: DiffLine[];
  tooBig?: boolean;
  name?: { from: string; to: string };
  description?: { from: string; to: string };
}

/** Who made a version, in a few words. */
export function authorWords(by: Author): string {
  switch (by.kind) {
    case "person":
      return t("skillVersions.by.person");
    case "agent":
      return by.name ? t("skillVersions.by.agent", { name: by.name }) : t("skillVersions.by.anAgent");
    case "proposal":
      return by.name ? t("skillVersions.by.proposal", { name: by.name }) : t("skillVersions.by.proposalAnAgent");
    case "catalog":
      return t("skillVersions.by.catalog");
    case "import":
      return t("skillVersions.by.import");
    case "file":
      return t("skillVersions.by.file");
    case "migration":
      return t("skillVersions.by.migration");
    case "builtin":
      return t("skillVersions.asItShips");
  }
}

/** How much a skill is used, in one line: counted when you name it with
 * a slash or an agent reads it in full (server/skill-usage.ts). */
export function usageWords(uses: number, corrected: number, lastUsed: number | null): string {
  if (!uses) return t("skillVersions.notUsedYet");
  const params = { count: uses, corrected, last: lastUsed ? stamp(lastUsed) : "" };
  if (!corrected) return t(lastUsed ? "skillVersions.usedLast" : "skillVersions.used", params);
  if (corrected === uses) return t(lastUsed ? "skillVersions.usedLastCorrectedAll" : "skillVersions.usedCorrectedAll", params);
  return t(lastUsed ? "skillVersions.usedLastCorrectedSome" : "skillVersions.usedCorrectedSome", params);
}

const versionWord = (n: number) => (n === 0 ? t("skillVersions.asItShips") : t("skillVersions.version", { n: String(n) }));

/** How long the instructions are against the limit, red once over it. */
function Count({ text }: { text: string }) {
  const length = [...text.trim()].length;
  return (
    <span className={cn("text-small tabular-nums", length > MAX_SKILL_CHARS ? "text-destructive" : "text-muted-foreground")}>
      {t("skillVersions.lengthOfMax", { length, max: MAX_SKILL_CHARS })}
    </span>
  );
}

/**
 * A skill, opened. `onChanged` is called after anything here wrote to it,
 * with the skill as it now stands when that is known, so the page around
 * it can refresh its list.
 */
export function SkillDetail({ skill, onChanged }: { skill: Skill; onChanged: (next?: Skill) => void }) {
  const [view, setView] = useState<"text" | "history">("text");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const builtin = skill.source === "builtin";

  // a different skill opened in the same place starts at its text
  useEffect(() => {
    setView("text");
    setEditing(false);
  }, [skill.id]);

  const makeOwn = () => {
    setBusy(true);
    api(`/api/skills/${skill.id}/fork`, { method: "POST" })
      .then(({ skill: mine }) => {
        toast.success(t("skillVersions.yoursNow", { name: skill.name }));
        onChanged(mine);
        setEditing(true);
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<"text" | "history">
          aria-label={t("skillVersions.show")}
          size="sm"
          value={view}
          onChange={(next) => {
            setView(next);
            if (next === "history") setEditing(false);
          }}
          options={[
            { value: "text", label: t("common.instructions") },
            {
              value: "history",
              label: !builtin && skill.revision ? t("skillVersions.historyCount", { count: String(skill.revision) }) : t("skillVersions.history"),
            },
          ]}
        />
        <span className="text-small text-muted-foreground">
          {t("skillVersions.statusLine", {
            version: builtin ? t("skillVersions.builtIn") : t("skillVersions.version", { n: String(skill.revision ?? 1) }),
            usage: usageWords(skill.uses ?? 0, skill.corrected ?? 0, skill.lastUsed ?? null),
          })}
        </span>
      </div>

      {view === "text" ? (
        editing && !builtin ? (
          <SkillEditor
            skill={skill}
            onCancel={() => setEditing(false)}
            onSaved={(next) => {
              setEditing(false);
              onChanged(next);
            }}
          />
        ) : (
          <>
            <pre className="mt-3 max-h-[420px] min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/40 p-3.5 font-mono text-small leading-relaxed text-foreground">
              {skill.body}
            </pre>
            {skill.files?.length ? (
              <SkillFiles
                className="mt-3"
                files={skill.files}
                read={(path) =>
                  api(`/api/skills/${encodeURIComponent(skill.id)}/files?path=${encodeURIComponent(path)}`).then((r: { text: string }) => r.text)
                }
              />
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {builtin ? (
                <>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={makeOwn}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Pencil size={13} />}
                    {t("skillVersions.makeItYours")}
                  </Button>
                  <span className="text-small text-muted-foreground">
                    {t("skillVersions.builtInSkillsStayAs")}
                  </span>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil size={13} />
                  {t("common.edit")}
                </Button>
              )}
            </div>
          </>
        )
      ) : (
        <SkillHistory skill={skill} onRestored={onChanged} onMakeOwn={builtin ? makeOwn : undefined} />
      )}
    </div>
  );
}

/** Editing a skill of yours, saved as its next version. */
function SkillEditor({ skill, onCancel, onSaved }: { skill: Skill; onCancel: () => void; onSaved: (next: Skill) => void }) {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== skill.name || description.trim() !== skill.description || body.trim() !== skill.body.trim();
  const tooLong = [...body.trim()].length > MAX_SKILL_CHARS;

  const save = () => {
    setSaving(true);
    setError(null);
    api(`/api/skills/${skill.id}`, {
      method: "PUT",
      body: JSON.stringify({ name, description, body, why, from: skill.revision }),
    })
      .then(({ skill: next }) => {
        toast.success(t("skillVersions.savedAs", { name: next.name, version: String(next.revision) }));
        onSaved(next);
      })
      .catch((e: Error & { status?: number }) =>
        // moved on while this was open: say so, and keep what was typed
        setError(e.status === 409 ? t("skillVersions.movedOnError", { error: e.message }) : e.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
      <label className="block">
        <span className="mb-1 block text-small font-medium text-muted-foreground">{t("common.name")}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="text-body" />
      </label>
      <label className="block">
        <span className="mb-1 block text-small font-medium text-muted-foreground">{t("skillVersions.whenToUseIt")}</span>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} className="text-body" />
      </label>
      <label className="flex min-h-0 flex-1 flex-col">
        <span className="mb-1 flex items-center justify-between text-small font-medium text-muted-foreground">
          {t("common.instructions")}
          <Count text={body} />
        </span>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[220px] flex-1 resize-none font-mono text-small leading-relaxed"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-small font-medium text-muted-foreground">{t("skillVersions.whatChanged")}</span>
        <Input
          value={why}
          maxLength={200}
          placeholder={t("skillVersions.oneLineForTheHistory")}
          onChange={(e) => setWhy(e.target.value)}
          className="text-body"
        />
      </label>
      {error && (
        <div role="alert" className="text-small text-destructive">
          {error}
        </div>
      )}
      <div className="mt-1 flex gap-2">
        <Button size="sm" disabled={saving || !changed || !body.trim() || !name.trim() || tooLong} onClick={save}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : t("skillVersions.saveAsANewVersion")}
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Every version, newest first; pick one to see what it changed. */
function SkillHistory({
  skill,
  onRestored,
  onMakeOwn,
}: {
  skill: Skill;
  onRestored: (next?: Skill) => void;
  onMakeOwn?: () => void;
}) {
  const [history, setHistory] = useState<SkillHistoryAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [against, setAgainst] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffAnswer | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return api(`/api/skills/${skill.id}/history`)
      .then((answer: SkillHistoryAnswer) => {
        setHistory(answer);
        setPicked((was) => (was !== null && answer.revisions.some((r) => r.n === was) ? was : (answer.revisions[0]?.n ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, [skill.id]);
  useEffect(() => {
    void load();
  }, [load, skill.revision]);

  const rows = history?.revisions ?? [];
  // by default a version is compared with the one before it: what it changed
  const before = picked === null ? null : (rows.find((r) => r.n < picked)?.n ?? (history?.shipped && picked > 0 ? 0 : null));
  const base = against ?? before;

  useEffect(() => {
    setAgainst(null);
  }, [picked]);

  useEffect(() => {
    if (picked === null || base === null || history?.builtin) {
      setDiff(null);
      return;
    }
    let live = true;
    setDiffError(null);
    api(`/api/skills/${skill.id}/diff?from=${Math.min(base, picked)}&to=${Math.max(base, picked)}`)
      .then((answer: DiffAnswer) => live && setDiff(answer))
      .catch((e: Error) => live && setDiffError(e.message));
    return () => {
      live = false;
    };
  }, [skill.id, picked, base, history?.builtin]);

  const restore = async (n: number) => {
    const yes = await confirm({
      title: n === 0 ? t("skillVersions.restoreShippedTitle") : t("skillVersions.restoreTitle", { n: String(n) }),
      body: t("skillVersions.restoreBody"),
      confirmLabel: t("skillVersions.restore"),
    });
    if (!yes) return;
    setRestoring(true);
    api(`/api/skills/${skill.id}/restore`, { method: "POST", body: JSON.stringify({ revision: n, from: history?.current }) })
      .then(({ skill: next }) => {
        toast.success(t("skillVersions.restoredAs", { version: String(next.revision) }));
        onRestored(next);
        void load();
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setRestoring(false));
  };

  if (error) return <p className="mt-4 text-body text-destructive">{error}</p>;
  if (!history) {
    return (
      <div className="mt-4 flex items-center gap-2 text-body text-muted-foreground" role="status">
        <Loader2 size={14} className="animate-spin" />
        {t("skillVersions.loadingVersions")}
      </div>
    );
  }
  if (history.builtin) {
    return (
      <div className="mt-4 flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
        <History size={18} className="text-muted-foreground" />
        <p className="text-body text-muted-foreground">
          {t("skillVersions.builtInSkillsShipWith")}
        </p>
        {onMakeOwn && (
          <Button size="sm" variant="secondary" onClick={onMakeOwn}>
            <Pencil size={13} />
            {t("skillVersions.makeItYours")}
          </Button>
        )}
      </div>
    );
  }

  const chosen = rows.find((r) => r.n === picked) ?? null;
  const others = rows.filter((r) => r.n !== picked);
  return (
    <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
      <ol aria-label={t("skillVersions.versions")} className="flex max-h-[220px] flex-col gap-1 overflow-auto md:max-h-[440px]">
        {rows.map((row) => (
          <li key={row.n}>
            <button
              onClick={() => setPicked(row.n)}
              aria-pressed={row.n === picked}
              className={cn(
                "w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                row.n === picked ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-body font-medium text-foreground">{versionWord(row.n)}</span>
                {row.n === history.current && (
                  <span className="rounded-full bg-brand/15 px-1.5 text-caption font-semibold text-brand-ink">{t("skillVersions.now")}</span>
                )}
                <span className="ml-auto shrink-0 text-caption text-muted-foreground">{stamp(row.at)}</span>
              </div>
              <div className="mt-0.5 truncate text-small text-muted-foreground">{authorWords(row.by)}</div>
              <div className="mt-0.5 line-clamp-2 text-small text-foreground/85">{row.why}</div>
              {row.uses > 0 && (
                <div className={cn("mt-0.5 text-caption", row.corrected ? "text-warning" : "text-muted-foreground")}>
                  {row.corrected
                    ? t("skillVersions.usesCorrected", { count: row.uses, corrected: row.corrected })
                    : t("skillVersions.uses", { count: row.uses })}
                </div>
              )}
            </button>
          </li>
        ))}
        {history.pruned && (
          <li className="px-2.5 py-2 text-caption text-muted-foreground">
            {t("skillVersions.pruned", { count: history.max })}
          </li>
        )}
      </ol>

      <div className="flex min-h-0 min-w-0 flex-col">
        {chosen && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium text-foreground">{versionWord(chosen.n)}</span>
              {chosen.restoredFrom !== undefined && (
                <span className="text-small text-muted-foreground">
                  {chosen.restoredFrom === 0
                    ? t("skillVersions.putBackShipped")
                    : t("skillVersions.putBackVersion", { n: String(chosen.restoredFrom) })}
                </span>
              )}
              {(others.length > 0 || history.shipped) && (
                <label className="ml-auto flex items-center gap-2 text-small text-muted-foreground">
                  {t("skillVersions.comparedWith")}
                  <SettingsSelect
                    aria-label={t("skillVersions.compareWith")}
                    value={base === null ? "" : String(base)}
                    onChange={(e) => setAgainst(e.target.value === "" ? null : Number(e.target.value))}
                    className="w-[150px]"
                  >
                    {base === null && <option value="">{t("skillVersions.nothingEarlier")}</option>}
                    {others.map((r) => (
                      <option key={r.n} value={r.n}>
                        {versionWord(r.n)}
                      </option>
                    ))}
                    {history.shipped && !rows.some((r) => r.n === 0) && <option value="0">{t("skillVersions.asItShips")}</option>}
                  </SettingsSelect>
                </label>
              )}
            </div>
            <div className="mt-2 min-h-[160px] flex-1 overflow-auto rounded-lg border bg-background py-2" aria-label={t("skillVersions.whatChanged")} role="region">
              {base === null ? (
                <p className="px-4 text-small text-muted-foreground">{t("skillVersions.theFirstVersionThereIs")}</p>
              ) : diffError ? (
                <p className="px-4 text-small text-destructive">{diffError}</p>
              ) : !diff ? (
                <p className="px-4 text-small text-muted-foreground">{t("skillVersions.comparing")}</p>
              ) : (
                <>
                  {base > picked! && (
                    <p className="px-4 pb-1 text-caption text-muted-foreground">
                      {Math.min(base, picked!) === 0
                        ? t("skillVersions.fromShippedTo", { to: String(Math.max(base, picked!)) })
                        : t("skillVersions.fromTo", { from: String(Math.min(base, picked!)), to: String(Math.max(base, picked!)) })}
                    </p>
                  )}
                  {diff.name && (
                    <p className="px-4 pb-1 text-small text-foreground">
                      {t("skillVersions.renamed", { from: diff.name.from, to: diff.name.to })}
                    </p>
                  )}
                  {diff.description && (
                    <p className="px-4 pb-1 text-small text-foreground">{t("skillVersions.descriptionChanged", { to: diff.description.to })}</p>
                  )}
                  {diff.tooBig ? (
                    <p className="px-4 text-small text-muted-foreground">{t("skillVersions.tooLargeToCompareLine")}</p>
                  ) : diff.lines.some((l) => l.kind === "add" || l.kind === "del") ? (
                    <DiffLines lines={diff.lines} />
                  ) : (
                    !diff.name && !diff.description && <p className="px-4 text-small text-muted-foreground">{t("skillVersions.theInstructionsAreTheSame")}</p>
                  )}
                </>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {chosen.n !== history.current && (
                <Button size="sm" variant="secondary" disabled={restoring} onClick={() => void restore(chosen.n)}>
                  {restoring ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {t("skillVersions.restoreThisVersion")}
                </Button>
              )}
              {history.shipped && chosen.n === history.current && (
                <Button size="sm" variant="ghost" disabled={restoring} onClick={() => void restore(0)}>
                  <RotateCcw size={13} />
                  {t("skillVersions.backToTheBuiltIn")}
                </Button>
              )}
              <span className="text-small text-muted-foreground">
                {usageWords(chosen.uses, chosen.corrected, chosen.lastUsed)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
