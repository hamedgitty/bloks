// A room's topics on screen (GitHub 523; the rules are server/room-topics.ts).
//
//   TopicBar        under the room's header: the main stream and each open
//                   topic, with its mark, and a way to open a new one for
//                   whoever may. Topics with a category sit in its folder,
//                   which folds to one chip with a count and the loudest
//                   mark inside. Closed topics wait behind a count.
//   NewTopicDialog  a title, a category, which agents work in it, and the
//                   folder and branch its work belongs in.
//   TopicPanel      a topic's context in the side dock: what it is for, who
//                   works in it, where its work goes, the files and pages
//                   it has touched, and closing or reopening it. On the
//                   main stream, the owner's switch that lets the room's
//                   lead move people's messages into topics.
import { useState } from "react";
import { Check, ChevronRight, FileText, Folder, GitBranch, Globe, Lock, MessagesSquare, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentAvatar } from "@/components/Avatar";
import { api, type Blok, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatList, t } from "@/lib/i18n";
import { stamp } from "@/lib/when";
import { fileBase } from "@/lib/sharedFile";
import { hostLabel } from "@/lib/appBrowser";
import { topicFiles, topicFolders, topicLinks, type RoomTopic, type TopicState } from "@/lib/roomTopics";

/** A topic's mark: blue while an agent works in it, amber while something
 * in it waits for a person, a hollow ring when open and quiet, nothing
 * when closed. */
export function TopicMark({ state }: { state: TopicState }) {
  if (state === "working") {
    return (
      <span role="img" aria-label={t("roomTopics.state.working")} className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full rounded-full bg-working opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-working" />
      </span>
    );
  }
  if (state === "waiting") return <span role="img" aria-label={t("roomTopics.state.waiting")} className="size-2 shrink-0 rounded-full bg-warning" />;
  if (state === "closed") return <Lock size={11} className="shrink-0 text-muted-foreground" aria-label={t("roomTopics.state.closed")} />;
  return <span aria-hidden className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />;
}

export function TopicBar({
  topics,
  current,
  states,
  counts,
  canOpen,
  onPick,
  onNew,
}: {
  topics: readonly RoomTopic[];
  current: string | null;
  states: ReadonlyMap<string, TopicState>;
  counts: ReadonlyMap<string, number>;
  canOpen: boolean;
  onPick: (topicId: string | null) => void;
  onNew: () => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  // folders the person folded (true) or opened (false), by category
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const open = topics.filter((tp) => tp.status === "open");
  const closed = topics.filter((tp) => tp.status === "closed");
  const shown = showClosed ? [...open, ...closed] : [...open, ...closed.filter((tp) => tp.id === current)];
  const folders = topicFolders(shown, states, current, folded);
  const chip = (selected: boolean) =>
    cn(
      "flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-body outline-none transition-colors duration-150",
      selected ? "border-foreground/20 bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    );
  return (
    <div role="tablist" aria-label={t("roomTopics.label")} className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 [scrollbar-width:none] md:px-4">
      <button type="button" role="tab" aria-selected={current === null} onClick={() => onPick(null)} className={chip(current === null)}>
        <MessagesSquare size={13} className="shrink-0" aria-hidden />
        {t("roomTopics.main")}
      </button>
      {folders.map((folder) => {
        const tabs = folder.open
          ? folder.topics.map((topic) => (
              <button
                key={topic.id}
                type="button"
                role="tab"
                aria-selected={current === topic.id}
                onClick={() => onPick(topic.id)}
                title={[topic.title, topic.category, t("roomTopics.messages", { count: counts.get(topic.id) ?? 0 })].filter(Boolean).join("\n")}
                className={cn(chip(current === topic.id), topic.status === "closed" && "opacity-70")}
              >
                <TopicMark state={states.get(topic.id) ?? "idle"} />
                <span className="truncate">{topic.title}</span>
              </button>
            ))
          : [];
        if (folder.category === null) return tabs;
        const category = folder.category;
        return [
          <button
            key={`folder:${category}`}
            type="button"
            aria-expanded={folder.open}
            onClick={() => setFolded((was) => ({ ...was, [category]: folder.open }))}
            title={t(folder.open ? "roomTopics.folder.fold" : "roomTopics.folder.unfold", { category, count: folder.topics.length })}
            className={cn(
              "flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-full px-2 text-body outline-none transition-colors duration-150 hover:bg-accent/60 hover:text-foreground",
              folder.open ? "text-muted-foreground" : "bg-muted/60 text-foreground",
            )}
          >
            <ChevronRight size={12} aria-hidden className={cn("shrink-0 transition-transform duration-150", folder.open && "rotate-90")} />
            <Folder size={13} aria-hidden className="shrink-0" />
            <span className="truncate">{category}</span>
            <span className="shrink-0 tabular-nums text-small text-muted-foreground">{folder.topics.length}</span>
            {!folder.open && (folder.mark === "working" || folder.mark === "waiting") && <TopicMark state={folder.mark} />}
          </button>,
          ...tabs,
        ];
      })}
      {closed.length > 0 && (
        <button
          type="button"
          onClick={() => setShowClosed((s) => !s)}
          aria-pressed={showClosed}
          className="shrink-0 rounded-full px-2 py-1 text-small text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {showClosed ? t("roomTopics.hideClosed") : t("roomTopics.closedCount", { count: closed.length })}
        </button>
      )}
      {canOpen && (
        <button
          type="button"
          onClick={onNew}
          className="ml-auto flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-body text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <Plus size={13} aria-hidden />
          {t("roomTopics.new")}
        </button>
      )}
    </div>
  );
}

export function NewTopicDialog({
  blok,
  members,
  topic,
  onClose,
  onDone,
}: {
  blok: Blok;
  members: Bot[];
  /** Given to change a topic rather than open one. */
  topic?: RoomTopic;
  onClose: () => void;
  onDone: (topic: RoomTopic) => void;
}) {
  const [title, setTitle] = useState(topic?.title ?? "");
  const [category, setCategory] = useState(topic?.category ?? "");
  const [agents, setAgents] = useState<string[]>(topic?.agents ?? []);
  const [folder, setFolder] = useState(topic?.folder ?? "");
  const [branch, setBranch] = useState(topic?.branch ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = [...new Set((blok.topics ?? []).map((tp) => tp.category).filter((c): c is string => Boolean(c)))];
  const save = () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const body = { title, category: category.trim() || null, agents, folder: folder.trim() || null, branch: branch.trim() || null };
    api(topic ? `/api/bloks/${blok.id}/topics/${topic.id}` : `/api/bloks/${blok.id}/topics`, { method: topic ? "PATCH" : "POST", body: JSON.stringify(body) })
      .then((r: { topic: RoomTopic }) => onDone(r.topic))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const field = "mb-1.5 block text-body font-medium text-muted-foreground";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(720px,92vh)] w-[calc(100vw-24px)] max-w-[520px] flex-col gap-0 overflow-hidden p-0">
        <header className="border-b px-6 pb-4 pt-5 pr-14">
          <DialogTitle className="text-heading">{topic ? t("roomTopics.editTitle") : t("roomTopics.newTitle")}</DialogTitle>
          <DialogDescription className="mt-0.5">{t("roomTopics.newHint", { name: blok.name })}</DialogDescription>
        </header>
        <form
          id="topic-form"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div>
            <label className={field} htmlFor="topic-title">{t("roomTopics.field.title")}</label>
            <Input id="topic-title" autoFocus value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t("roomTopics.field.titleHint")} />
          </div>
          <div>
            <label className={field} htmlFor="topic-category">{t("roomTopics.field.category")}</label>
            <Input id="topic-category" list="topic-categories" value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} placeholder={t("roomTopics.field.categoryHint")} />
            <datalist id="topic-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <fieldset>
            <legend className={field}>{t("roomTopics.field.agents")}</legend>
            <p className="-mt-1 mb-2 text-small text-muted-foreground">{t("roomTopics.field.agentsHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {members.map((bot) => {
                const on = agents.includes(bot.id);
                return (
                  <button
                    key={bot.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setAgents((list) => (on ? list.filter((id) => id !== bot.id) : [...list, bot.id]))}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-body transition-colors duration-150",
                      on ? "border-brand/40 bg-brand-soft text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <AgentAvatar bot={bot} size={22} />
                    {bot.name}
                    {on && <Check size={13} className="text-brand-ink" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={field} htmlFor="topic-folder">{t("roomTopics.field.folder")}</label>
              <Input id="topic-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("roomTopics.field.folderHint")} spellCheck={false} autoCapitalize="off" />
            </div>
            <div>
              <label className={field} htmlFor="topic-branch">{t("roomTopics.field.branch")}</label>
              <Input id="topic-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t("roomTopics.field.branchHint")} spellCheck={false} autoCapitalize="off" />
            </div>
          </div>
          <p className="-mt-2 text-small text-muted-foreground">{t("roomTopics.field.whereHint")}</p>
        </form>
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3 text-small">
          <div role="alert" className="mr-auto min-w-0 text-destructive">{error}</div>
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="secondary" onClick={onClose} className="max-sm:flex-1">
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="topic-form" disabled={!title.trim() || busy} className="min-w-[112px] max-sm:flex-1">
              {topic ? t("common.save") : t("roomTopics.open")}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

export function TopicPanel({
  blok,
  topic,
  state,
  members,
  messages,
  count,
  canClose,
  canEdit,
  lead,
  creatorName,
  onEdit,
  onOpenDoc,
  onOpenLink,
}: {
  blok: Blok;
  topic: RoomTopic | null;
  state: TopicState;
  members: Bot[];
  messages: readonly Message[];
  count: number;
  canClose: boolean;
  canEdit: boolean;
  /** The room's lead, who routes work into topics when allowed. */
  lead: Bot | null;
  creatorName: (by: string) => string;
  onEdit: () => void;
  onOpenDoc: (doc: { botId: string; name: string; mime: string; size: number }) => void;
  onOpenLink: ((url: string) => void) | null;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!topic) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MessagesSquare size={18} />
        </div>
        <p className="text-ui font-medium text-foreground">{t("roomTopics.panel.none")}</p>
        <p className="max-w-[36ch] text-pretty text-body text-muted-foreground">{t("roomTopics.panel.noneHint")}</p>
        {canEdit && lead && <RoutingSwitch blok={blok} lead={lead} />}
      </div>
    );
  }
  const working = topic.agents?.length ? members.filter((m) => topic.agents!.includes(m.id)) : members;
  const files = topicFiles(messages, topic.id);
  const links = topicLinks(messages, topic.id);
  const setStatus = (status: "open" | "closed") => {
    setError(null);
    api(`/api/bloks/${blok.id}/topics/${topic.id}`, { method: "PATCH", body: JSON.stringify({ status }) }).catch((e: Error) => setError(e.message));
  };
  const section = "px-4 py-3";
  const heading = "mb-1.5 text-caption font-medium uppercase tracking-wide text-muted-foreground";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className={cn(section, "border-b")}>
        <div className="flex items-center gap-2">
          <TopicMark state={state} />
          <h2 className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">{topic.title}</h2>
        </div>
        <p className="mt-1 text-small text-muted-foreground">
          {[
            topic.category,
            topic.status === "closed" ? t("roomTopics.panel.closedBy", { name: creatorName(topic.closedBy ?? "owner"), when: stamp(topic.closedAt ?? 0) }) : t("roomTopics.panel.openedBy", { name: creatorName(topic.createdBy), when: stamp(topic.createdAt) }),
            t("roomTopics.messages", { count }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {canClose && (
            <Button size="sm" variant="secondary" onClick={() => setStatus(topic.status === "open" ? "closed" : "open")}>
              {topic.status === "open" ? t("roomTopics.close") : t("roomTopics.reopen")}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t("roomTopics.edit")}
            </Button>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-small text-destructive">{error}</p>}
      </div>
      <div className={section}>
        <h3 className={heading}>{t("roomTopics.panel.agents")}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {working.map((bot) => (
            <span key={bot.id} className="flex h-7 items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 text-body text-foreground">
              <AgentAvatar bot={bot} size={20} />
              {bot.name}
            </span>
          ))}
        </div>
        {!topic.agents?.length && <p className="mt-1.5 text-small text-muted-foreground">{t("roomTopics.panel.everyAgent")}</p>}
      </div>
      {(topic.folder || topic.branch) && (
        <div className={section}>
          <h3 className={heading}>{t("roomTopics.panel.where")}</h3>
          {topic.folder && (
            <p className="flex items-center gap-2 text-body text-foreground">
              <Folder size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              <code className="truncate font-mono text-small">{topic.folder}</code>
            </p>
          )}
          {topic.branch && (
            <p className="mt-1 flex items-center gap-2 text-body text-foreground">
              <GitBranch size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              <code className="truncate font-mono text-small">{topic.branch}</code>
            </p>
          )}
          <p className="mt-1.5 text-small text-muted-foreground">{t("roomTopics.panel.whereHint")}</p>
          {topic.folder && <p className="mt-1 text-pretty text-small text-muted-foreground">{t("roomTopics.panel.folderHeld")}</p>}
        </div>
      )}
      <div className={section}>
        <h3 className={heading}>{t("roomTopics.panel.files")}</h3>
        {files.length ? (
          <ul className="flex flex-col gap-0.5">
            {files.map((file) => (
              <li key={`${file.botId}/${file.name}`}>
                <button
                  type="button"
                  onClick={() => onOpenDoc(file)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body text-foreground transition-colors duration-150 hover:bg-accent"
                >
                  <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{fileBase(file.name)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-muted-foreground">{t("roomTopics.panel.noFiles")}</p>
        )}
      </div>
      <div className={section}>
        <h3 className={heading}>{t("roomTopics.panel.links")}</h3>
        {links.length ? (
          <ul className="flex flex-col gap-0.5">
            {links.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={url}
                  onClick={(e) => {
                    if (!onOpenLink || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpenLink(url);
                  }}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-body text-foreground transition-colors duration-150 hover:bg-accent"
                >
                  <Globe size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{hostLabel(url) || url}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-muted-foreground">{t("roomTopics.panel.noLinks")}</p>
        )}
      </div>
      {working.length > 0 && topic.status === "open" && (
        <p className="mt-auto border-t px-4 py-2.5 text-small text-muted-foreground">
          {t("roomTopics.panel.wakes", { names: formatList(working.map((b) => b.name), { type: "conjunction" }) })}
        </p>
      )}
    </div>
  );
}

/**
 * The owner's switch for the room's lead routing work: with it on, the
 * lead may move a person's message from the main stream into an open
 * topic, or into one it opens for it, and the move is said in the stream.
 * The server holds the rule (PATCH /api/bloks/:id, leadRoutes).
 */
function RoutingSwitch({ blok, lead }: { blok: Blok; lead: Bot }) {
  const [error, setError] = useState<string | null>(null);
  const on = blok.leadRoutes === true;
  return (
    <label htmlFor={`routes-${blok.id}`} className="mt-5 flex w-full max-w-[340px] items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-left">
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-foreground">{t("roomTopics.routing.label", { name: lead.name })}</span>
        <span className="mt-0.5 block text-pretty text-small leading-relaxed text-muted-foreground">{t("roomTopics.routing.line", { name: lead.name })}</span>
        {error && <span role="alert" className="mt-1 block text-small text-destructive">{error}</span>}
      </span>
      <Switch
        id={`routes-${blok.id}`}
        checked={on}
        onCheckedChange={(next) => {
          setError(null);
          api(`/api/bloks/${blok.id}`, { method: "PATCH", body: JSON.stringify({ leadRoutes: next }) }).catch((e: Error) => setError(e.message));
        }}
      />
    </label>
  );
}
