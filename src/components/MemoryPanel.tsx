// Memory, as your own files.
//
// Every agent keeps plain Markdown notes in its workspace: MEMORY.md,
// loaded into every turn, and topic files it reads when a topic comes up.
// This panel puts all of them in one place, for every agent: read them,
// correct them, forget a topic. And because an agent writes these on its
// own, every change it makes lands in a journal (server/memory-journal.ts)
// with its diff, and any one of them can be undone.
import { useCallback, useEffect, useMemo, useState } from "react";
import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import History from "lucide-react/dist/esm/icons/history.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Undo2 from "lucide-react/dist/esm/icons/undo-2.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";

interface DiffLine {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}

interface Entry {
  id: string;
  at: number;
  file: string;
  by: "agent" | "you" | "undo";
  undoes?: string;
  undoneBy?: string;
  big?: boolean;
  added: number;
  removed: number;
  lines: DiffLine[] | null;
  created: boolean;
  deleted: boolean;
}

type Tab = "files" | "changes";

export function MemoryPanel() {
  const { state, dispatch } = useStore();
  const agents = useMemo(() => state.bots.filter((b) => !b.hidden), [state.bots]);
  const [botId, setBotId] = useState<string | null>(state.memoryBotId ?? agents[0]?.id ?? null);
  const [tab, setTab] = useState<Tab>("files");
  const bot = agents.find((b) => b.id === botId) ?? null;
  const close = () => dispatch({ type: "toggleMemory", open: false, botId: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex h-[82%] w-[900px] max-w-[94vw] animate-pop-in flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl shadow-[--shadow-color]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Memory"
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[16px] font-semibold text-foreground">
              <Brain size={17} className="text-muted-foreground" />
              Memory
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              What each agent keeps between conversations, as plain files. Every change is recorded and can be undone.
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close memory" onClick={close}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="hidden w-[200px] shrink-0 overflow-y-auto border-r p-2 sm:block" aria-label="Agents">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setBotId(agent.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                  agent.id === botId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <AgentAvatar bot={agent} size={22} />
                <span className="min-w-0 truncate">{agent.name}</span>
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <select
                className="rounded-md border bg-background px-2 py-1 text-[13px] sm:hidden"
                value={botId ?? ""}
                onChange={(e) => setBotId(e.target.value)}
                aria-label="Agent"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1 rounded-lg bg-muted p-0.5">
                {(
                  [
                    ["files", "Files", FileText],
                    ["changes", "Changes", History],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                      tab === key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!bot ? (
                <div className="py-10 text-center text-[13px] text-muted-foreground">No agents yet.</div>
              ) : tab === "files" ? (
                <Files key={bot.id} bot={bot} />
              ) : (
                <Changes key={bot.id} bot={bot} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── files ──────────────────────────────────────────────────────────────

function Files({ bot }: { bot: Bot }) {
  const [main, setMain] = useState<{ text: string; truncated: boolean } | null>(null);
  const [topics, setTopics] = useState<Array<{ name: string; bytes: number }>>([]);
  const [open, setOpen] = useState<string>("MEMORY.md");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [reread, setReread] = useState(0);

  const load = useCallback(() => {
    api(`/api/bots/${bot.id}/memory`)
      .then((r) => {
        setMain({ text: r.text ?? "", truncated: Boolean(r.truncated) });
        setTopics(r.topics ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, [bot.id]);
  useEffect(load, [load]);

  // what the editor shows follows the file chosen, read fresh each time
  useEffect(() => {
    setDirty(false);
    setNote(null);
    setError(null);
    if (open === "MEMORY.md") {
      if (main) setText(main.text);
      return;
    }
    api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(open.slice(7))}`)
      .then((r) => setText(r.text ?? ""))
      .catch(() => setText(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot.id, main === null, reread]);

  const save = () => {
    setBusy(true);
    setError(null);
    const request =
      open === "MEMORY.md"
        ? api(`/api/bots/${bot.id}/memory`, { method: "PUT", body: JSON.stringify({ text }) })
        : api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(open.slice(7))}`, {
            method: "PUT",
            body: JSON.stringify({ text }),
          });
    request
      .then(() => {
        setDirty(false);
        setNote("Saved. The change is in the journal.");
        load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const forget = () => {
    if (open === "MEMORY.md") return;
    setBusy(true);
    api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(open.slice(7))}`, { method: "DELETE" })
      .then(() => {
        setOpen("MEMORY.md");
        load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const createTopic = () => {
    const raw = (naming ?? "").trim().replace(/\.md$/i, "");
    if (!raw) return;
    const name = `${raw.replace(/[^\w .-]+/g, "-").slice(0, 100)}.md`;
    setBusy(true);
    api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ text: `# ${raw}\n\n` }),
    })
      .then(() => {
        setNaming(null);
        load();
        setOpen(`memory/${name}`);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
  const files = [{ file: "MEMORY.md", hint: "loaded every turn" }, ...topics.map((t) => ({ file: `memory/${t.name}`, hint: size(t.bytes) }))];

  return (
    <div className="flex h-full min-h-[360px] flex-col gap-3 md:flex-row">
      <div className="flex shrink-0 flex-col gap-0.5 md:w-[210px]">
        {files.map(({ file, hint }) => (
          <button
            key={file}
            onClick={() => setOpen(file)}
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
              open === file ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <span className="min-w-0 truncate font-mono text-[12px]">{file}</span>
            <span className="shrink-0 text-[10.5px] text-muted-foreground">{hint}</span>
          </button>
        ))}
        {naming === null ? (
          <button
            onClick={() => setNaming("")}
            className="mt-1 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Plus size={13} />
            New topic
          </button>
        ) : (
          <div className="mt-1 flex gap-1">
            <Input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createTopic();
                if (e.key === "Escape") setNaming(null);
              }}
              placeholder="people, projects..."
              className="h-7 text-[12px]"
            />
            <Button size="sm" className="h-7" disabled={busy || !naming.trim()} onClick={createTopic}>
              Add
            </Button>
          </div>
        )}
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
          The agent reads topic files when a topic comes up, and keeps them itself. Anything here, you can change.
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            setNote(null);
          }}
          spellCheck={false}
          className="min-h-[280px] flex-1 resize-none font-mono text-[12.5px] leading-relaxed"
          aria-label={open}
        />
        {open === "MEMORY.md" && main?.truncated && (
          <div className="mt-2 text-[11.5px] text-warning">
            Longer than a turn loads. Only the first part reaches the agent; move detail into a topic file.
          </div>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <Button size="sm" disabled={!dirty || busy} onClick={save}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            Save
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (open === "MEMORY.md" && main) setText(main.text);
                setReread((n) => n + 1);
              }}
            >
              Discard
            </Button>
          )}
          {open !== "MEMORY.md" && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={forget} disabled={busy}>
              <Trash2 size={13} />
              Forget this topic
            </Button>
          )}
          {note && <span className="text-[12px] text-muted-foreground">{note}</span>}
          {error && <span className="text-[12px] text-destructive">{error}</span>}
        </div>
      </div>
    </div>
  );
}

// ── the journal ────────────────────────────────────────────────────────

function Changes({ bot }: { bot: Bot }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api(`/api/bots/${bot.id}/memory/journal`)
      .then((r) => setEntries(r.entries ?? []))
      .catch((e: Error) => setError(e.message));
  }, [bot.id]);
  useEffect(() => {
    load();
    // an agent writes its notes as it works; keep the journal current
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const undo = (entry: Entry) => {
    setBusy(entry.id);
    setError(null);
    api(`/api/bots/${bot.id}/memory/journal/${entry.id}/undo`, { method: "POST" })
      .then(load)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  if (entries === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Reading the journal
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-[13px] leading-relaxed text-muted-foreground">
        Nothing yet. When {bot.name} writes to its memory, or you edit it, each change shows up here with a way back.
      </div>
    );
  }

  const day = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  let lastDay = "";
  return (
    <div className="flex flex-col">
      {error && <div className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</div>}
      {entries.map((entry) => {
        const heading = day(entry.at) !== lastDay ? (lastDay = day(entry.at)) : null;
        const who = entry.by === "agent" ? bot.name : entry.by === "you" ? "You" : "Undo";
        const verb = entry.created ? "started" : entry.deleted ? "forgot" : entry.by === "undo" ? "put back" : "changed";
        const isOpen = expanded === entry.id;
        return (
          <div key={entry.id}>
            {heading && (
              <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0">
                {heading}
              </div>
            )}
            <div className={cn("rounded-xl border bg-card", entry.undoneBy && "opacity-60")}>
              <div className="flex items-center gap-2.5 px-3 py-2">
                {entry.by === "agent" ? (
                  <AgentAvatar bot={bot} size={20} />
                ) : (
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    {entry.by === "undo" ? <Undo2 size={11} /> : <span className="text-[9px] font-semibold">YOU</span>}
                  </span>
                )}
                <button onClick={() => setExpanded(isOpen ? null : entry.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[12.5px] text-foreground">
                    <span className="font-medium">{who}</span> {verb} <span className="font-mono text-[12px]">{entry.file}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    {!entry.big && (
                      <>
                        {" · "}
                        <span className="text-success">+{entry.added}</span> <span className="text-destructive">-{entry.removed}</span>
                      </>
                    )}
                    {entry.undoneBy && " · undone"}
                  </div>
                </button>
                {!entry.undoneBy && entry.by !== "undo" && !entry.big && (
                  <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" disabled={busy === entry.id} onClick={() => undo(entry)}>
                    {busy === entry.id ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                    Undo
                  </Button>
                )}
              </div>
              {isOpen && entry.lines && (
                <div className="max-h-[300px] overflow-auto border-t bg-muted/30 py-1.5 font-mono text-[11.5px] leading-[1.55]">
                  {entry.lines.map((line, i) =>
                    line.kind === "gap" ? (
                      <div key={i} className="px-3 font-sans text-[10.5px] text-muted-foreground">
                        {line.text}
                      </div>
                    ) : (
                      <div
                        key={i}
                        className={cn(
                          "whitespace-pre-wrap break-words px-3",
                          line.kind === "add" && "bg-success/12",
                          line.kind === "del" && "bg-destructive/12",
                          line.kind === "same" && "text-muted-foreground",
                        )}
                      >
                        <span className="mr-2 select-none opacity-60">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                        {line.text || " "}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
            <div className="h-1.5" />
          </div>
        );
      })}
    </div>
  );
}
