// The skill library: browse what's installed, add your own from a
// markdown file or pasted text, attach them to agents.
//
// Installing a skill means injecting its text into every turn of every
// agent that uses it, the highest-trust content in the app. So the
// import flow always shows the exact body before it is written, and
// nothing is ever fetched and installed automatically.
import { useCallback, useEffect, useRef, useState } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Lock from "lucide-react/dist/esm/icons/lock.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, type Skill } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { SkillCatalog } from "./SkillCatalog";
import { cn } from "@/lib/cn";

const MAX_SKILL_BYTES = 16_000;

/** Best name for a pasted or dropped document: the frontmatter's own
 * name wins, then a leading heading, then the filename. */
function nameFor(markdown: string, fileName: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const declared = frontmatter?.[1].match(/^name\s*:\s*(.+)$/m)?.[1];
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1];
  return (
    declared?.trim().replace(/^["']|["']$/g, "") ||
    heading?.trim() ||
    fileName ||
    "New skill"
  );
}

/** Step 2 of import: show exactly what will be injected, then install. */
function ReviewImport({
  draft,
  onBack,
  onInstalled,
}: {
  draft: { name: string; markdown: string };
  onBack: () => void;
  onInstalled: (skill: Skill) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = new Blob([draft.markdown]).size > MAX_SKILL_BYTES;

  const install = () => {
    setSaving(true);
    setError(null);
    api("/api/skills", {
      method: "POST",
      body: JSON.stringify({ markdown: draft.markdown, name: name.trim() || draft.name, id: name }),
    })
      .then(({ skill }) => onInstalled(skill))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2.5 rounded-xl bg-warning/10 px-3 py-2.5">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="text-[12.5px] leading-relaxed text-warning">
          These instructions go into every turn of any agent you attach this to. Read them before
          installing, and only add skills from a source you trust.
        </div>
      </div>

      <label className="mt-3 block">
        <div className="mb-1.5 text-[12.5px] font-medium text-muted-foreground">Name</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-[14px] text-foreground outline-none focus-visible:border-ring/60"
        />
      </label>

      <div className="mb-1.5 mt-3 text-[12.5px] font-medium text-muted-foreground">
        Instructions to be installed
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
        {draft.markdown}
      </pre>

      {tooLong && (
        <div className="mt-2 text-[12px] text-destructive">
          Too long. Skills are capped at {MAX_SKILL_BYTES.toLocaleString()} characters.
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button onClick={install} disabled={saving || tooLong} className="flex-1">
          {saving ? <Loader2 size={13} className="animate-spin" /> : "Install skill"}
        </Button>
      </div>
    </div>
  );
}

function AddSkill({
  onBack,
  onInstalled,
}: {
  onBack: () => void;
  onInstalled: (skill: Skill) => void;
}) {
  const [markdown, setMarkdown] = useState("");
  const [fileName, setFileName] = useState("");
  const [review, setReview] = useState<{ name: string; markdown: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    file.text().then((text) => {
      setMarkdown(text);
      setFileName(file.name.replace(/\.mdx?$/i, ""));
    });
  };

  if (review) {
    return <ReviewImport draft={review} onBack={() => setReview(null)} onInstalled={onInstalled} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) readFile(file);
        }}
        className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed py-6 transition-colors duration-150 hover:border-ring/50 hover:bg-accent/50"
      >
        <FileText size={18} className="text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">Drop a .md file, or click to pick</span>
        <span className="text-[12px] text-muted-foreground">
          Markdown, with optional name/description frontmatter
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) readFile(file);
        }}
      />

      <div className="my-3 flex items-center gap-3 text-[11.5px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or write it
        <span className="h-px flex-1 bg-border" />
      </div>

      <Textarea
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        placeholder={`Use this when…\n\n1. First step\n2. Second step\n\nNot for: when to leave this alone.\nReturn: what to hand back.\nApproval: what needs a human first.`}
        className="min-h-[180px] flex-1 resize-none font-mono text-[12px] leading-relaxed"
      />

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={onBack} className="flex-1">
          Cancel
        </Button>
        <Button
          disabled={!markdown.trim()}
          onClick={() => setReview({ name: nameFor(markdown, fileName), markdown })}
          className="flex-1"
        >
          Review
        </Button>
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
  onDelete,
}: {
  skill: Skill;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={cn("border-t px-3.5 py-2.5 first:border-t-0", expanded && "bg-muted/40")}>
      <div className="flex items-start gap-3">
        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-foreground">{skill.name}</span>
            {skill.source === "builtin" && (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">
                <Lock size={9} />
                built in
              </span>
            )}
          </div>
          {skill.description && (
            <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {skill.description}
            </div>
          )}
        </button>
        {skill.source === "user" && (
          <button
            onClick={onDelete}
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors duration-150 hover:text-destructive"
            title="Remove skill"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {expanded && (
        <pre className="mt-2 max-h-[220px] animate-rise-in overflow-auto whitespace-pre-wrap rounded-lg bg-background p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {skill.body}
        </pre>
      )}
    </div>
  );
}

export function SkillsPanel() {
  const { dispatch } = useStore();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Two halves: what is on this machine, and what could be.
  const [tab, setTab] = useState<"mine" | "catalog">("mine");
  const [updates, setUpdates] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const load = useCallback(
    () =>
      Promise.all([
        api("/api/skills")
          .then((r) => setSkills(r.skills ?? []))
          .catch(() => setSkills([])),
        api("/api/skills/proposals")
          .then((r) => setProposals(r.proposals ?? []))
          .catch(() => setProposals([])),
      ]).then(() => undefined),
    [],
  );

  useEffect(() => {
    void load();
    // Only for the badge: the catalog itself is loaded when it is opened,
    // and a number nobody can see is not worth a request on every render.
    api("/api/skills/registry")
      .then((r) => setUpdates(r.updates ?? 0))
      .catch(() => setUpdates(0));
  }, [load]);

  const close = () => dispatch({ type: "toggleSkills", open: false });

  const visible = (skills ?? []).filter(
    (s) =>
      !search ||
      `${s.name} ${s.description} ${s.body}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex h-[76%] w-[560px] max-w-[92vw] animate-pop-in flex-col rounded-2xl border bg-popover p-4 shadow-2xl shadow-[--shadow-color] sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[16px] font-semibold text-foreground">
              {adding ? "Add a skill" : "Skills"}
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {adding
                ? "Teach your agents something new."
                : "Reusable instructions any agent can use."}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {!adding && (
              <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                <Plus size={13} />
                Add
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Close skills" onClick={close}>
              <X size={16} />
            </Button>
          </div>
        </div>

        {!adding && (
          <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
            {(
              [
                ["mine", "On this machine"],
                ["catalog", "Catalog"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                  tab === key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {key === "catalog" && updates > 0 && (
                  <span className="rounded-full bg-brand/15 px-1.5 text-[10.5px] font-medium text-brand-ink">
                    {updates}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          {!adding && tab === "catalog" ? (
            <SkillCatalog
              onInstalled={() => {
                void load();
                api("/api/skills/registry")
                  .then((r) => setUpdates(r.updates ?? 0))
                  .catch(() => {});
              }}
            />
          ) : adding ? (
            <AddSkill
              onBack={() => setAdding(false)}
              onInstalled={() => {
                setAdding(false);
                void load();
              }}
            />
          ) : (
            <>
              {proposals.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    <Sparkles size={12} className="text-brand-ink" />
                    Suggested from your conversations
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {proposals.map((proposal) => (
                      <ProposedSkill key={proposal.id} proposal={proposal} onDone={load} />
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-[7px] transition-colors duration-150 focus-within:bg-accent">
                <Search size={15} className="shrink-0 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search skills"
                  className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border">
                {skills === null ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" /> Loading…
                  </div>
                ) : visible.length === 0 ? (
                  <div className="py-8 text-center text-[13px] text-muted-foreground">
                    {search ? "No skills match." : "No skills yet."}
                  </div>
                ) : (
                  visible.map((skill) => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      expanded={expanded === skill.id}
                      onToggle={() => setExpanded(expanded === skill.id ? null : skill.id)}
                      onDelete={() =>
                        api(`/api/skills/${skill.id}`, { method: "DELETE" })
                          .then(load)
                          .catch(() => {})
                      }
                    />
                  ))
                )}
              </div>
              <div className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Attach skills to an agent from its settings. Files live in{" "}
                <code className="rounded bg-muted px-1 py-px font-mono">~/.bloks/skills</code>.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export interface Proposal {
  id: string;
  kind: "new" | "patch";
  botName: string;
  skillId?: string;
  name: string;
  description: string;
  body: string;
  because: string;
  at: number;
  overwritesEdits?: boolean;
}

/**
 * A skill the workspace wrote and has not installed.
 *
 * It opens closed, because the interesting question is whether to keep it
 * at all and that is answerable from one line. Opening it shows the whole
 * thing, editable: a suggestion is a draft with the words already
 * written, so changing them before keeping it is the ordinary case rather
 * than an exception.
 */
function ProposedSkill({ proposal, onDone }: { proposal: Proposal; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(proposal.name);
  const [description, setDescription] = useState(proposal.description);
  const [body, setBody] = useState(proposal.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (keep: boolean) => {
    setBusy(true);
    setError(null);
    const call = keep
      ? api(`/api/skills/proposals/${proposal.id}`, {
          method: "POST",
          body: JSON.stringify({ name, description, body }),
        })
      : api(`/api/skills/proposals/${proposal.id}`, { method: "DELETE" });
    call
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-xl border border-brand/30 bg-brand-soft/30 p-3">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left">
        <div className="text-[13px] font-medium text-foreground">
          {proposal.kind === "patch" ? `Change to ${proposal.skillId}` : name}
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {proposal.because}
        </div>
        <div className="mt-1 text-[11.5px] text-muted-foreground/80">
          From {proposal.botName}. {open ? "Hide it" : "Read it"}
        </div>
      </button>

      {/* An edited skill is somebody's own work, and a suggestion that
          would land on top of it should say so before it is approved. */}
      {proposal.overwritesEdits && (
        <div className="mt-2 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-warning">
          You have your own changes in that skill. Keeping this replaces them.
        </div>
      )}

      {open && (
        <div className="mt-2.5 flex flex-col gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="text-[13px]" />
          <Input
            value={description}
            placeholder="When to use it"
            onChange={(e) => setDescription(e.target.value)}
            className="text-[13px]"
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[160px] font-mono text-[12px]"
          />
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}

      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" disabled={busy || !name.trim() || !body.trim()} onClick={() => act(true)}>
          Keep it
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(false)}>
          Discard
        </Button>
      </div>
    </div>
  );
}
