// Where you write to a room.
//
// The same frame as an agent's composer (composer/Shell.tsx): the tray,
// a skinny box that grows to a cap, and a quiet row under it. What fills
// it is the room's. In the box: + to add files, the words with every
// @name marked as it is typed, the list of who can be named, dictation,
// and Send, which is Stop while members are at work here. Under it: who
// the next message reaches, which changes as names are typed.
//
// No `/` list. A room's words go to its members as a transcript to read,
// not to one agent's engine, so a slash command would arrive as plain
// words. Files do travel: they ride in the text the way they do in a
// chat, and every member is on this Mac to open them.
import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { CornerUpLeft } from "@/components/icons";
import { File as FileIcon } from "@/components/icons";
import { FileImage } from "@/components/icons";
import { Mic } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Undo2 } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Blok, type Bot, type Message } from "@/state/store";
import type { RoomPerson } from "@/state/reducer";
import { AgentAvatar } from "@/components/Avatar";
import { type ReplyDraft } from "@/components/MessageActions";
import { BoxButton, ComposerShell, SendStop } from "@/components/composer/Shell";
import { RANK, TrayButton, type Notice } from "@/components/composer/Tray";
import { useQueuedNotice } from "@/components/WaitingStrip";
import { useUnsentNotice } from "@/components/chat/HeldSends";
import {
  composeOutgoing,
  destination,
  intakeFiles,
  isLongPaste,
  pasteAttachment,
  uploadFileAttachment,
  uploadImageAttachment,
  type Attachment,
} from "@/lib/attachments";
import { heldLine } from "@/lib/pendingImages";
import { AttachmentChips, usePendingImages } from "@/components/composer/Attachments";
import {
  acceptDraft,
  boxFor,
  carryFocus,
  discardRecovery,
  isEmptyDraft,
  keepDraft,
  readDraft,
  readRecoveries,
  recoverDraft,
  restoreRecovery,
  showBox,
  takeFocus,
  type Draft,
} from "@/lib/drafts";
import { edgeMask } from "@/lib/composerSize";
import { escapeTaken } from "@/lib/useEscape";
import { modKey } from "@/lib/thisComputer";
import { cn } from "@/lib/cn";
import { useDictation, VoiceMeter } from "./Dictation";
import { ReachMenu } from "./ReachMenu";
import { reachOf } from "./reach";
import { answersOf } from "@/lib/roomRoute";
import { t } from "@/lib/i18n";

/** Fade whichever edges have more text beyond them, the marks too. */
function shadeEdges(el: HTMLTextAreaElement) {
  const mask = edgeMask(el.scrollTop, el.clientHeight, el.scrollHeight);
  el.style.maskImage = mask;
  el.style.webkitMaskImage = mask;
  const layer = el.previousElementSibling as HTMLElement | null;
  if (layer?.dataset.mentionLayer) {
    layer.style.maskImage = mask;
    layer.style.webkitMaskImage = mask;
    const inner = layer.firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = `translateY(${-el.scrollTop}px)`;
  }
}

/** The tallest the words get, as in an agent's composer: about two
 * fifths of the window, between three and sixteen whole lines. */
function growCeiling(lineHeight: number, padding: number): number {
  const line = lineHeight > 0 ? lineHeight : 24;
  const room = Math.floor((window.innerHeight * 0.4 - padding) / line);
  return Math.ceil(Math.max(3, Math.min(16, room)) * line + padding);
}

/** Grows with the words to the ceiling, then scrolls. Empty is one row,
 * unmeasured: an empty textarea reports its own maximum, not a line. */
function useAutoSize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [tall, setTall] = useState(() => window.innerHeight);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => shadeEdges(el);
    const onResize = () => setTall(window.innerHeight);
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      shadeEdges(el);
      return;
    }
    el.style.overflowY = "";
    const style = getComputedStyle(el);
    const ceiling = growCeiling(parseFloat(style.lineHeight), parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, ceiling)}px`;
    if (el.selectionEnd === value.length) el.scrollTop = el.scrollHeight;
    shadeEdges(el);
  }, [value, tall]);
  return ref;
}

/** Where each @name in the words is, longest names first and each span
 * used once, as the server reads them, for the marks behind the text. */
function mentionRuns(text: string, names: readonly string[]): Array<{ text: string; mention: boolean }> {
  const lower = text.toLowerCase();
  const taken: Array<[number, number]> = [];
  for (const name of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const needle = `@${name.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      const end = at + needle.length;
      if (!taken.some(([s, e]) => at < e && end > s)) taken.push([at, end]);
    }
  }
  taken.sort((a, b) => a[0] - b[0]);
  const runs: Array<{ text: string; mention: boolean }> = [];
  let from = 0;
  for (const [s, e] of taken) {
    if (s > from) runs.push({ text: text.slice(from, s), mention: false });
    runs.push({ text: text.slice(s, e), mention: true });
    from = e;
  }
  if (from < text.length) runs.push({ text: text.slice(from), mention: false });
  return runs;
}

/** What the next message answers, inside the box with the files. */
function ReplyTag({ draft, onClear }: { draft: ReplyDraft; onClear: () => void }) {
  return (
    <span className="flex min-w-0 max-w-full animate-pop-in items-center gap-1.5 rounded-xl bg-brand-soft py-1 pl-2 pr-1 text-small">
      <CornerUpLeft size={12} className="shrink-0 text-brand-ink" />
      <span className="shrink-0 font-medium text-brand-ink">{draft.author}</span>
      <span className="min-w-0 truncate text-muted-foreground">{draft.excerpt}</span>
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors duration-150 hover:bg-background/60 hover:text-foreground"
        aria-label={t("roomComposer.cancelReply")}
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** A person in a shared room, by their initial, as the transcript draws them. */
function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-secondary text-caption font-semibold text-secondary-foreground"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function RoomComposer({
  blok,
  members,
  answering,
  lead,
  working,
  people,
  ownerName,
  nameOf,
  waiting,
  senderOf,
  replyTo,
  onClearReply,
  mentionAsk,
  onSent,
}: {
  blok: Blok;
  /** Everyone in the room, archived members too. */
  members: Bot[];
  /** Those who can answer, the lead first. */
  answering: Bot[];
  lead: Bot | null;
  /** Members taking a turn in this room right now. */
  working: Bot[];
  people: RoomPerson[];
  ownerName?: string;
  /** A person's name as the room calls them, told apart from anyone who
   * shares it (src/lib/names.ts): the label in the @ list. */
  nameOf?: (id: string) => string;
  /** What waits to join the room, in the order it was sent. */
  waiting: Message[];
  /** Who sent a waiting message that is not yours, or null for yours. */
  senderOf: (message: Message) => string | null;
  replyTo: ReplyDraft | null;
  onClearReply: () => void;
  /** Put @name in the box, from a face picked elsewhere. */
  mentionAsk?: { name: string; nonce: number } | null;
  /** A message went, so the room can follow it to the end. */
  onSent?: () => void;
}) {
  const { dispatch } = useStore();
  // One box per room (RoomView is keyed by room), so a half-written line
  // and its files stay with the room they were written in. What it holds
  // is kept when the room goes, and found again when it comes back.
  const draftKey = `room:${blok.id}`;
  const [draft, setDraftState] = useState(() => readDraft<Attachment>(draftKey));
  const { text, attachments } = draft;
  const latest = useRef(draft);
  const setDraft = (next: Draft<Attachment>) => setDraftState(acceptDraft(latest, next));
  const setText = (next: SetStateAction<string>) =>
    setDraft({ ...latest.current, text: typeof next === "function" ? next(latest.current.text) : next });
  const setAttachments = (next: SetStateAction<Attachment[]>) =>
    setDraft({ ...latest.current, attachments: typeof next === "function" ? next(latest.current.attachments) : next });
  const [recoveries, setRecoveries] = useState(() => readRecoveries(draftKey));
  const [blockedRecovery, setBlockedRecovery] = useState<string | null>(null);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  // a picture is a chip from the moment it lands, as in a chat
  const images = usePendingImages({
    onReady: (ready) => setAttachments((current) => [...current, ...ready]),
    onFailed: (name, error) => setAttachNotice(t("roomComposer.imageFailed", { name, error })),
  });
  const [sendHeld, setSendHeld] = useState(false);
  const heldBy = heldLine(images.items);
  useEffect(() => {
    if (!heldBy) setSendHeld(false);
  }, [heldBy]);
  const inputRef = useAutoSize(text);
  const pickerRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  // a send that failed comes back to the box on screen for this room
  const receive = (sent: Draft<Attachment>) => {
    const back = recoverDraft(draftKey, latest, sent);
    if (back) setDraft(back);
    else setRecoveries(readRecoveries(draftKey));
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useEffect(() => {
    mounted.current = true;
    const hide = showBox<Attachment>(draftKey, (sent) => receiveRef.current(sent));
    return () => {
      mounted.current = false;
      hide();
      const held = images.held();
      keepDraft(draftKey, held.length ? { ...latest.current, attachments: [...latest.current.attachments, ...held] } : latest.current);
    };
  }, [draftKey]);
  // the keyboard follows from the box this one replaced (lib/drafts)
  useLayoutEffect(() => {
    if (takeFocus()) inputRef.current?.focus();
    const input = inputRef.current;
    return () => carryFocus(Boolean(input) && document.activeElement === input);
  }, [draftKey]);
  const giveBack = (sent: Draft<Attachment>) => {
    if (mounted.current) return receive(sent);
    const box = boxFor<Attachment>(draftKey);
    if (box) return box(sent);
    const back = recoverDraft(draftKey, { current: readDraft<Attachment>(draftKey) }, sent);
    if (back) keepDraft(draftKey, back);
  };
  const restore = (id: string) => {
    if (!readRecoveries(draftKey).some((item) => item.id === id)) return;
    if (!isEmptyDraft(latest.current)) return setBlockedRecovery(id);
    const back = restoreRecovery(draftKey, id, latest);
    if (!back) return;
    setDraft(back);
    setRecoveries(readRecoveries(draftKey));
    setBlockedRecovery(null);
    inputRef.current?.focus();
  };

  // ── naming someone ──
  // Typing @ opens a list of who is in the room. Naming somebody is how
  // a room decides who answers, so guessing the spelling should never be
  // part of it: the list filters as you type, Tab or Enter completes,
  // Escape gets out of the way.
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  // A person is listed as the room calls them ("Sam O."), and completes
  // to the name they gave, which is what the server reads a mention by.
  const mentionable: Array<{ id: string; name: string; label?: string; title?: string; bot?: Bot }> = [
    ...answering.map((b) => ({ id: b.id, name: b.name, title: b.title, bot: b })),
    ...people.map((p) => ({ id: p.id, name: p.name, label: nameOf?.(p.id), title: p.role === "viewer" ? t("roomComposer.viewer") : t("roomComposer.collaborator") })),
  ];
  const query = mentionAt === null ? null : text.slice(mentionAt + 1, inputRef.current?.selectionStart ?? text.length);
  const matches =
    query === null || /\s/.test(query)
      ? []
      : mentionable.filter((m) => m.name.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);
  const readMention = (el: HTMLTextAreaElement) => {
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    const at = value.lastIndexOf("@", caret - 1);
    const startsWord = at === 0 || /\s/.test(value[at - 1] ?? "");
    const typing = at !== -1 && startsWord && !/\s/.test(value.slice(at + 1, caret));
    setMentionAt(typing ? at : null);
    setPick(0);
  };
  const putCaret = (at: number) =>
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  /** The half-typed @name, finished. */
  const complete = (name: string) => {
    if (mentionAt === null) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    setText(`${text.slice(0, mentionAt)}@${name} ${text.slice(caret)}`);
    setMentionAt(null);
    putCaret(mentionAt + name.length + 2);
  };
  /** @name added at the end, for a face picked rather than typed. */
  const mention = (name: string) => {
    const base = latest.current.text.trimEnd();
    const next = base ? `${base} @${name} ` : `@${name} `;
    setText(next);
    setMentionAt(null);
    putCaret(next.length);
  };
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  useEffect(() => {
    if (mentionAsk) mentionRef.current(mentionAsk.name);
  }, [mentionAsk]);
  // a reply is begun from the message, and the words go here next
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── files ──
  /** The one road in, whether the files came by picker, drop or paste. */
  const intake = (files: File[]) => {
    if (!files.length) return;
    void intakeFiles(files, {
      pathOf: (file) => window.bloks?.filePath?.(file) ?? "",
      uploadImage: (file) => uploadImageAttachment(file),
      // a path from here is no use to a server elsewhere: the file goes
      uploadFile: (file) => uploadFileAttachment(file),
      sameComputer: async () => (await destination()).sameComputer,
      onSending: (file) => setAttachNotice(file.name ? t("roomComposer.sendingFile", { name: file.name }) : t("roomComposer.sendingTheFile")),
      onImage: (file) => images.add([file]),
    }).then(({ attachments: added, refused }) => {
      if (added.length) setAttachments((current) => [...current, ...added]);
      if (added.length || refused) setAttachNotice(refused);
    });
  };
  // A file dropped anywhere in the window attaches here, as in a chat:
  // aiming at the bottom edge is fiddly. A drop something else in the
  // window already took is left to it.
  const intakeRef = useRef(intake);
  intakeRef.current = intake;
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDropping(false);
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      intakeRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const dictation = useDictation(text, (next) => setText(next));

  // ── stopping ──
  // A room's turn is each member's own, in the conversation it keeps for
  // this room, so Stop stops every member at work here and nobody
  // elsewhere. What waited behind the round then goes, as it would when
  // the round ended on its own.
  const busy = working.length > 0;
  const stopAll = () => {
    for (const m of working) {
      const lane = m.tasks?.find((t) => t.room === blok.id)?.id;
      void api(`/api/bots/${m.id}/interrupt`, {
        method: "POST",
        body: JSON.stringify(lane ? { taskId: lane } : {}),
      }).catch((e: Error) => dispatch({ type: "error", message: e.message }));
    }
  };

  const send = (stopFirst = false) => {
    const { text, attachments } = latest.current;
    // the message waits for a picture still on its way, as in a chat,
    // rather than going without it
    if (heldLine(images.now())) return setSendHeld(true);
    if (!text.trim() && !attachments.length) {
      if (stopFirst) stopAll();
      return;
    }
    if (stopFirst) stopAll();
    const sent = { text, attachments };
    dispatch({
      type: "sendToRoom",
      blokId: blok.id,
      text: composeOutgoing(text, attachments),
      replyTo: replyTo ?? undefined,
      onFailed: () => giveBack(sent),
    });
    // empty now, before a quick refusal can hand the words back
    setDraft({ text: "", attachments: [] });
    setMentionAt(null);
    setAttachNotice(null);
    onClearReply();
    onSent?.();
  };

  /** Sends a message again that never went, then clears the one left. */
  const sendAgain = (message: Message) => {
    api(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: message.text }) })
      .then(() => api(`/api/threads/${blok.id}/messages/${message.id}`, { method: "DELETE" }))
      .catch((e: Error) => dispatch({ type: "error", message: e.message }));
  };
  // ↑ in the empty box edits the last of yours still waiting: what has
  // gone into a room is on its record, but a queued line is still yours.
  const [editAsk, setEditAsk] = useState<{ id: string; nonce: number } | null>(null);
  const editLast = () => {
    const mine = [...waiting].reverse().find((m) => m.queued && m.text && senderOf(m) === null);
    if (!mine) return false;
    setEditAsk({ id: mine.id, nonce: Date.now() });
    return true;
  };

  const queuedNotice = useQueuedNotice({
    messages: waiting,
    threadId: blok.id,
    recoveryKey: draftKey,
    senderOf,
    working: busy,
    onSendNow: stopAll,
    onSendAgain: sendAgain,
    editAsk,
  });
  const unsentNotice = useUnsentNotice(draftKey);
  const notices = [
    queuedNotice,
    unsentNotice,
    dictation.notice,
    attachNotice
      ? {
          id: "attach",
          tone: "warn",
          rank: RANK.feedback,
          icon: <FileIcon size={14} />,
          title: attachNotice,
          onDismiss: () => setAttachNotice(null),
        }
      : null,
    sendHeld && heldBy
      ? {
          id: "images-held",
          tone: "info",
          rank: RANK.feedback,
          icon: <FileImage size={14} />,
          title: heldBy,
          onDismiss: () => setSendHeld(false),
        }
      : null,
    ...recoveries.map(
      (item): Notice => ({
        id: `unsent:${item.id}`,
        tone: "warn",
        rank: RANK.unsent,
        icon: <Undo2 size={14} />,
        title: t("roomComposer.unsent.title"),
        detail: blockedRecovery === item.id ? t("roomComposer.unsent.finishDraftFirst") : t("roomComposer.unsent.checkRoom"),
        actions: (
          <>
            <TrayButton
              onClick={() => {
                discardRecovery(draftKey, item.id);
                setRecoveries(readRecoveries(draftKey));
                setBlockedRecovery(null);
              }}
            >
              {t("common.discard")}
            </TrayButton>
            <TrayButton strong onClick={() => restore(item.id)}>
              {t("roomComposer.restore")}
            </TrayButton>
          </>
        ),
        body: item.draft.text && (
          <div className="rounded-xl bg-muted/60 px-3 py-1.5 text-body">
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-foreground">{item.draft.text}</p>
          </div>
        ),
      }),
    ),
  ].filter((n): n is Notice => n !== null);

  const canSend = Boolean(text.trim()) || attachments.length > 0 || images.items.length > 0;
  const named = [...members.map((m) => m.name), ...people.map((p) => p.name), ...(ownerName ? [ownerName] : [])];
  const reach = reachOf(text, {
    members,
    lead: lead?.id ?? null,
    leadOnly: Boolean(blok.leadOnly),
    // with only one who can answer there is nobody to choose between
    auto: answersOf(blok) === "auto" && members.filter((m) => !m.archivedAt).length > 1,
    // only a shared room has people to name, and only there does naming
    // one and no agent keep the agents quiet
    people: blok.sharing ? [...people.map((p) => p.name), ...(ownerName ? [ownerName] : [])] : [],
  });

  const chips = (replyTo || attachments.length > 0 || images.items.length > 0) && (
    <>
      {replyTo && <ReplyTag draft={replyTo} onClear={onClearReply} />}
      <AttachmentChips
        attachments={attachments}
        images={images}
        onRemove={(id) => setAttachments((cur) => cur.filter((x) => x.id !== id))}
      />
    </>
  );

  return (
    <ComposerShell
      notices={notices}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        intake([...e.dataTransfer.files]);
      }}
      overlay={
        dropping && (
          <div className="pointer-events-none fixed inset-2 z-50 flex animate-pop-in items-center justify-center rounded-2xl border-2 border-dashed border-brand/50 bg-background/70">
            <span className="rounded-xl bg-popover px-3.5 py-2 text-body text-foreground shadow-lg shadow-(color:--shadow-color)">
              {t("roomComposer.dropToShare", { name: blok.name })}
            </span>
          </div>
        )
      }
      popover={
        matches.length > 0 && (
          <div className="animate-pop-in origin-bottom overflow-hidden rounded-xl border bg-popover shadow-lg shadow-(color:--shadow-color)">
            <div role="listbox" aria-label={t("roomComposer.peopleInThisRoom")} className="p-1">
              {matches.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  onMouseEnter={() => setPick(i)}
                  // mousedown, not click, so the words keep their caret
                  onMouseDown={(e) => {
                    e.preventDefault();
                    complete(m.name);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100",
                    i === pick ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  {m.bot ? <AgentAvatar bot={m.bot} size={22} /> : <Initial name={m.name} />}
                  <span className="text-body font-medium text-foreground">{m.label ?? m.name}</span>
                  {m.title && <span className="min-w-0 truncate text-small text-muted-foreground">{m.title}</span>}
                  {m.bot && m.id === lead?.id && answering.length > 1 && (
                    <span className="ml-auto shrink-0 text-caption text-muted-foreground">{t("roomComposer.lead")}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="border-t px-3 py-1.5 text-caption text-muted-foreground max-sm:hidden" aria-hidden>
              {t("roomComposer.pickTabInsertEscClose")}
            </div>
          </div>
        )
      }
      chips={chips || undefined}
      lead={
        <>
          <input
            ref={pickerRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              intake([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <BoxButton title={t("roomComposer.attachAFileOrImage")} onClick={() => pickerRef.current?.click()}>
            <Plus size={18} />
          </BoxButton>
        </>
      }
      trail={
        <>
          <BoxButton
            title={dictation.recording ? t("roomComposer.stopDictationEsc") : t("roomComposer.dictate")}
            onClick={() => void dictation.toggle()}
            className={cn(
              dictation.recording &&
                "animate-pulse bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive motion-reduce:animate-none",
            )}
          >
            {dictation.recording ? <VoiceMeter level={dictation.level} /> : <Mic size={17} />}
          </BoxButton>
          <SendStop
            mode={canSend ? "send" : busy ? "stop" : "idle"}
            sendLabel={busy ? t("roomComposer.sendStopsRoomFirst", { key: modKey() }) : t("roomComposer.send")}
            stopLabel={t("roomComposer.stopTheRoomEsc")}
            onSend={() => send()}
            onStop={stopAll}
          />
        </>
      }
      belowStart={
        answering.length > 0 && (
          <ReachMenu
            blok={blok}
            reach={reach}
            members={members}
            answering={answering}
            lead={lead}
            onMention={mention}
          />
        )
      }
    >
      <div className="relative min-w-0">
        {/* Each @name marked behind its word, so who a message reaches is
            seen in the words as well as under the box. The layer has the
            textarea's exact type and padding and clear text; shadeEdges
            keeps it scrolled and faded with the textarea. */}
        <div
          data-mention-layer="1"
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden px-1 py-1 text-lead text-transparent [overflow-wrap:break-word] [white-space:pre-wrap]"
        >
          <div>
            {mentionRuns(text, named).map((run, i) =>
              run.mention ? (
                <span key={i} className="rounded-[5px] bg-brand-soft ring-2 ring-brand-soft">
                  {run.text}
                </span>
              ) : (
                <span key={i}>{run.text}</span>
              ),
            )}
            {"​"}
          </div>
        </div>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          aria-label={t("roomComposer.messageTo", { name: blok.name })}
          onChange={(e) => {
            setText(e.target.value);
            readMention(e.target);
          }}
          onBlur={() => setMentionAt(null)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              intake(files);
              return;
            }
            const pasted = e.clipboardData.getData("text/plain");
            if (pasted && isLongPaste(pasted)) {
              e.preventDefault();
              setAttachments((cur) => [...cur, pasteAttachment(pasted)]);
            }
          }}
          onKeyDown={(e) => {
            if (matches.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                return setPick((i) => (i + step + matches.length) % matches.length);
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                return complete(matches[Math.min(pick, matches.length - 1)].name);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                return setMentionAt(null);
              }
            }
            if (
              e.key === "ArrowUp" &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.shiftKey &&
              !text &&
              !attachments.length &&
              !images.items.length &&
              e.currentTarget.selectionStart === 0 &&
              editLast()
            ) {
              e.preventDefault();
              return;
            }
            // Enter sends; Shift+Enter starts a new line; Cmd/Ctrl+Enter
            // stops the room first. Not while a character is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send((e.metaKey || e.ctrlKey) && busy);
            }
            if (e.key === "Escape" && dictation.recording) return dictation.stop();
            // Esc stops the room, as Stop does, once nothing above the
            // box wants the key first. The words stay where they are.
            if (e.key === "Escape" && !e.nativeEvent.isComposing && busy && !escapeTaken()) {
              e.preventDefault();
              stopAll();
            }
          }}
          placeholder={
            dictation.recording
              ? t("roomComposer.listening")
              : replyTo
                ? t("roomComposer.replyTo", { name: replyTo.author })
                : t("roomComposer.placeholder", { name: blok.name })
          }
          className="relative block w-full min-w-0 resize-none bg-transparent px-1 py-1 text-lead text-foreground outline-none placeholder:truncate placeholder:text-muted-foreground placeholder-shown:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]"
        />
      </div>
    </ComposerShell>
  );
}
