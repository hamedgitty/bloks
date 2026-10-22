// Where you write to an agent.
//
// The frame (composer/Shell.tsx) is the tray, a skinny box and a quiet
// row under it; this fills it for one agent's conversation. In the box:
// + to add things, the words and what rides with them, the `/` list,
// dictation, and Send, which is Stop while it works. Under it: how much
// the agent asks, the model and its effort, the speed where the model has
// one, and a ring for how full the conversation is and what it has used.
// Everything the conversation has to say above the box goes through the
// one tray, most pressing first, so a busy conversation never stacks
// strips up the window.
import { track } from "@/lib/analytics";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { Mic } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Hand } from "@/components/icons";
import { Archive } from "@/components/icons";
import { CornerUpLeft } from "@/components/icons";
import { File as FileIcon } from "@/components/icons";
import { Undo2 } from "@/components/icons";
import { X } from "@/components/icons";
import { FlaskConical } from "@/components/icons";
import { ShieldAlert } from "@/components/icons";
import { api, useStore, openLaneWorking, type Bot, type Message } from "@/state/store";
import { type ReplyDraft } from "./MessageActions";
import { ComposerRing } from "./ComposerRing";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/cn";
import { BoxButton, ComposerShell, SendStop } from "./composer/Shell";
import { ApprovalModeMenu } from "./composer/ApprovalMode";
import { CodexSpeedMenu } from "./CodexSpeed";
import { NoticeTray, RANK, TrayButton, type Notice } from "./composer/Tray";
import { SlashMenu } from "./composer/SlashMenu";
import { guestMailNotice, useApprovalsNotice, useCreditsNotice, useEngineNotice, useOtherLanesNotice, useSuggestionNotice } from "./chat/Banners";
import { useGoalNotice } from "./Goal";
import { useQueuedNotice } from "./WaitingStrip";
import { useUnsentNotice } from "./chat/HeldSends";
import { UsageNotice } from "./composer/UsageNotice";
import { useDeliveryPreview, type DeliveryPreview } from "@/lib/delivery";
import {
  attachmentBasename,
  composeOutgoing,
  destination,
  formatBytes,
  intakeFiles,
  isLongPaste,
  pasteAttachment,
  uploadFileAttachment,
  uploadImageAttachment,
  type Attachment,
} from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { modKey } from "@/lib/thisComputer";
import { edgeMask } from "@/lib/composerSize";
import { acceptDraft, boxFor, carryFocus, discardRecovery, isEmptyDraft, keepDraft, readDraft, readRecoveries, recoverDraft, restoreRecovery, showBox, takeFocus, type Draft } from "@/lib/drafts";
import { grouped, insert as insertCommand, matches as matchCommands, segments, slashAt, withBloksCommands, type Command } from "@/lib/slashCommands";
import { escapeTaken } from "@/lib/useEscape";
import { ComparePicker } from "./composer/ComparePicker";

/** Fade whichever edges have more text beyond them (see edgeMask). */
function shadeEdges(el: HTMLTextAreaElement) {
  const mask = edgeMask(el.scrollTop, el.clientHeight, el.scrollHeight);
  el.style.maskImage = mask;
  el.style.webkitMaskImage = mask;
  // the skill highlights behind the text fade and scroll with it
  const layer = el.previousElementSibling as HTMLElement | null;
  if (layer?.dataset.skillLayer) {
    layer.style.maskImage = mask;
    layer.style.webkitMaskImage = mask;
    const inner = layer.firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = `translateY(${-el.scrollTop}px)`;
  }
}

/** How much of the window a long message may take before it scrolls. */
const GROW_SHARE = 0.4;
/** However tall the window, past this many lines a message scrolls. */
const GROW_MAX_LINES = 16;
/** And however short, it gets this many before it does. */
const GROW_MIN_LINES = 3;

/**
 * The tallest the words get: about two fifths of the window, capped, and
 * always a whole number of lines plus the padding. A flat pixel ceiling
 * lands between lines, and then a scrolled composer always shows part of
 * one sliced off against its border (#50).
 */
function growCeiling(lineHeight: number, padding: number): number {
  const line = lineHeight > 0 ? lineHeight : 24;
  const room = Math.floor((window.innerHeight * GROW_SHARE - padding) / line);
  const lines = Math.max(GROW_MIN_LINES, Math.min(GROW_MAX_LINES, room));
  return Math.ceil(lines * line + padding);
}

/**
 * Grows with its content up to a ceiling, then scrolls.
 *
 * Measured at `auto` rather than at zero. An empty textarea collapsed to
 * no height reports a scrollHeight of its own maximum rather than of one
 * line, so measuring that way left the composer standing at its ceiling
 * whenever there was nothing in it, which is every time you look at it.
 *
 * The ceiling follows the window, so it is measured again when the
 * window changes size, not only when the words do.
 */
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
    // Nothing typed is exactly one row, and rows=1 already says that, so
    // the height comes off entirely rather than being measured. An empty
    // textarea does not report the scrollHeight of one line, which is how
    // the composer came to stand at its ceiling whenever it was empty.
    // A placeholder longer than the line (a long agent name on a phone)
    // wraps onto a second row the one-row box hides, and the box grows a
    // scrollbar for it. Empty, there is nothing to scroll to.
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
    // Typing at the end, the usual case: show the end, padding included.
    // The browser only scrolls far enough to keep the caret's line in
    // view, which parks that line in the bottom fade.
    if (el.selectionEnd === value.length) el.scrollTop = el.scrollHeight;
    shadeEdges(el);
  }, [value, tall]);
  return ref;
}

/** What the helper's error words mean to a person. */
const SPEECH_TROUBLE: Record<string, string> = {
  "speech-not-authorized":
    "Dictation needs Speech Recognition access. It's separate from the microphone.",
  "recognizer-unavailable":
    "English speech recognition isn't available on this Mac right now.",
  "mic-failed": "Couldn't open the microphone. Another app may be using it.",
  "recognition-error": "Dictation stopped. Try again, or check your microphone.",
};

/**
 * Five bars that move with your voice. A recording state that shows only
 * a red dot cannot distinguish "listening" from "deaf", which is exactly
 * the doubt somebody has when nothing appears in the field.
 */
function VoiceMeter({ level }: { level: number }) {
  const bars = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <span className="flex h-[17px] items-center gap-[2px]" aria-hidden>
      {bars.map((weight, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-current transition-[height] duration-100 ease-out"
          style={{ height: `${Math.max(3, Math.min(15, 3 + level * weight * 22))}px` }}
        />
      ))}
    </span>
  );
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
  return (
    <span className="flex max-w-[240px] animate-pop-in items-center gap-1.5 rounded-xl border bg-muted/50 py-1 pl-1.5 pr-1 text-small text-foreground">
      {a.kind === "image" ? (
        <img src={`/api/attachments/${attachmentBasename(a.path)}`} alt={a.name} className="size-7 shrink-0 rounded-lg object-cover" />
      ) : (
        <FileIcon size={14} className="shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{a.kind === "paste" ? `Pasted text, ${a.lines} lines` : a.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(a.bytes)}</span>
      {onRemove && (
        <button onClick={onRemove} className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label={`Remove ${a.kind === "paste" ? "pasted text" : a.name}`}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** What the next message answers, inside the box with the files, since it
 * travels with the words rather than being something to read about. */
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
        aria-label="Cancel reply"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/**
 * How the words in the box will meet the turn running now, said before
 * they go, with the one press that sends them the other way: in now
 * rather than after, or after rather than now. Quiet, because most of
 * the time it is right and nobody needs to look at it.
 */
function DeliveryLine({ preview, onFlip }: { preview: DeliveryPreview; onFlip: () => void }) {
  const waits = preview.route === "queue";
  return (
    <div className="flex w-full animate-pop-in flex-wrap items-center gap-x-2 gap-y-0.5 text-small" role="status">
      <span className="text-muted-foreground">{preview.line}.</span>
      <button
        type="button"
        onClick={onFlip}
        // the box keeps the keyboard: this is a choice about the words in
        // it, and the next key is still meant for them
        onMouseDown={(e) => e.preventDefault()}
        className="rounded-md font-medium text-foreground underline-offset-2 transition-colors duration-150 hover:underline"
      >
        {waits ? "Send now" : "Wait instead"}
      </button>
    </div>
  );
}

export function Composer({
  bot,
  replyTo,
  onClearReply,
  prefill,
  onEditLast,
  approvals,
  waiting,
  editAsk,
  onSendAgain,
  notices: extra,
}: {
  bot: Bot;
  /** reply context to send with the next message */
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /** Words to put in the box, such as a message handed back by a rewind. */
  prefill?: { text: string; nonce: number } | null;
  /** ↑ in the empty box: open your last message for editing. False when
   * there is none that can be. */
  onEditLast?: () => boolean;
  /** Approval cards not yet answered; two or more are a queue, and the
   * tray offers to answer them together. */
  approvals?: Message[];
  /** Messages waiting to join the conversation, in the order sent. */
  waiting?: Message[];
  /** ↑ asked to edit this one, which may be waiting. */
  editAsk?: { id: string; nonce: number } | null;
  onSendAgain?: (message: Message) => void;
  /** Anything else for the tray. */
  notices?: Notice[];
}) {
  const { state, dispatch } = useStore();
  // One composer per conversation: ChatView keys it by agent and lane, so
  // nothing in it (the words, the chips, rehearsing, dictation) can be
  // carried to another agent and sent there. What it holds is kept for
  // this conversation when it goes, and found again when it comes back.
  const draftKey = `${bot.id}:${bot.activeTaskId ?? bot.threadId}`;
  const [draft, setDraftState] = useState(() => readDraft<Attachment>(draftKey));
  const { text, attachments } = draft;
  const latest = useRef(draft);
  // Accepted typing and asynchronous intake are visible to a failure in
  // the same batch, before React has rendered the new words or chips.
  const setDraft = (next: Draft<Attachment>) => {
    setDraftState(acceptDraft(latest, next));
  };
  const setText = (next: SetStateAction<string>) => setDraft({
    ...latest.current,
    text: typeof next === "function" ? next(latest.current.text) : next,
  });
  const setAttachments = (next: SetStateAction<Attachment[]>) => setDraft({
    ...latest.current,
    attachments: typeof next === "function" ? next(latest.current.attachments) : next,
  });
  const [recoveries, setRecoveries] = useState(() => readRecoveries(draftKey));
  const [blockedRecovery, setBlockedRecovery] = useState<string | null>(null);
  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill]);
  // Rehearse: the next message runs on a copy of the folder, optionally
  // by other agents too, and comes back as changes to apply or discard
  const [rehearse, setRehearse] = useState(false);
  // The person's one tap on how the words in the box will meet the turn
  // running now (server/delivery.ts). For this message only: it goes when
  // the message does, or when the box is emptied.
  const [deliveryChoice, setDeliveryChoice] = useState<"now" | "wait" | null>(null);
  useEffect(() => {
    if (!text.trim()) setDeliveryChoice(null);
  }, [text]);
  const [compareWith, setCompareWith] = useState<string[]>([]);
  const [rehearsing, setRehearsing] = useState(false);
  const [rehearseError, setRehearseError] = useState<string | null>(null);
  const others = state.bots.filter((b) => b.id !== bot.id && !b.hidden);
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  /** A standing denial: macOS will not prompt again, so we offer the pane. */
  const [micDenied, setMicDenied] = useState(false);
  /** Which Privacy pane would fix the current complaint. */
  const [speechPane, setSpeechPane] = useState<"mic" | "speech">("mic");
  /** Loudness right now, 0 to 1, straight from the microphone tap. */
  const [level, setLevel] = useState(0);
  // whatever was already typed, so speech is appended rather than
  // replacing what someone had started writing
  const baseText = useRef("");
  const inputRef = useAutoSize(text);
  const mounted = useRef(true);
  // the words a failed send hands back, into this box when it is the one
  // on screen for this conversation
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
      keepDraft(draftKey, latest.current);
    };
  }, [draftKey]);
  // Layout, not passive: on the way out the box has to still be in the
  // page to tell whether it had the keyboard, and the box replacing it
  // takes the keyboard in the same commit.
  useLayoutEffect(() => {
    if (takeFocus()) inputRef.current?.focus();
    const input = inputRef.current;
    return () => carryFocus(Boolean(input) && document.activeElement === input);
  }, [draftKey]);
  // A send that did not go comes back to the box it left; when this
  // conversation was left meanwhile, to the box now on screen for it, or
  // else to the draft kept for it.
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
  /** Why something did not become a chip, said once, dismissible. */
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  /** A wider approval mode that Touch ID was not given for. */
  const [modeRefused, setModeRefused] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  // The `/` list (#51): this agent's skills, fetched when the agent or
  // its attached skills change, and filtered as the word after a slash
  // is typed.
  const [commands, setCommands] = useState<Command[]>([]);
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const skillKey = (bot.skillIds ?? []).join(",");
  const laneId = bot.activeTaskId ?? bot.threadId;
  const commandTick = state.ticks[`commands:${laneId}`] ?? 0;
  const engine = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  const commandEngine = `${engine?.driverKind}:${engine?.snapshot.version}`;
  useEffect(() => {
    let live = true;
    setCommands([]);
    api(`/api/bots/${bot.id}/commands?taskId=${encodeURIComponent(laneId)}`)
      .then((r: { commands: Command[] }) => live && setCommands(r.commands ?? []))
      .catch(() => live && setCommands([]));
    return () => {
      live = false;
    };
  }, [bot.id, skillKey, laneId, bot.modelSelection.instanceId, bot.cwd, bot.busy, commandTick, commandEngine]);
  // Bloks' own (`/goal`) ride along with the agent's, except while
  // rehearsing, where the message becomes a rehearsal and not a turn
  const lane = bot.tasks?.find((t) => t.id === laneId);
  const listed = rehearse ? commands : withBloksCommands(commands, lane);
  const commandIds = new Set(listed.filter((c) => !c.prefix).map((c) => c.id));
  const dollarIds = new Set(listed.filter((c) => c.prefix === "$").map((c) => c.id));
  // in the order the list draws them, by source, so ↑↓ walk what is seen
  const offered = slash ? grouped(matchCommands(listed, slash.query, 8, slash.start === 0)).flatMap((g) => g.commands) : [];
  // whether the list is on screen: a slash with nothing to offer under it
  // draws nothing
  const slashShown = Boolean(slash && (offered.length > 0 || (listed.length === 0 && slash.query === "")));
  const readSlash = (el: HTMLTextAreaElement) => {
    setSlash(slashAt(el.value, el.selectionStart ?? el.value.length));
    setPick(0);
  };
  const choose = (command: Command) => {
    const el = inputRef.current;
    if (!slash || !el) return;
    // the word being typed ends where the query does; the caret is not
    // trusted here, since a key handler can see it before it settles
    const next = insertCommand(text, slash.start, slash.start + 1 + slash.query.length, command.id, command.prefix);
    setText(next.text);
    setSlash(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  /** The one road in, whether the files came by picker, drop or paste. */
  const intake = (files: File[]) => {
    if (!files.length) return;
    void intakeFiles(files, {
      pathOf: (file) => window.bloks?.filePath?.(file) ?? "",
      uploadImage: (file) => uploadImageAttachment(file),
      // a path from here is no use to a server elsewhere: the file goes
      uploadFile: (file) => uploadFileAttachment(file),
      sameComputer: async () => (await destination()).sameComputer,
      onSending: (file) => setAttachNotice(`Sending ${file.name || "the file"}…`),
    }).then(({ attachments: added, refused }) => {
      if (added.length) setAttachments((current) => [...current, ...added]);
      setAttachNotice(refused);
    });
  };

  // A file dropped anywhere in the window attaches here, not only one
  // dropped on this box: aiming at the bottom edge is fiddly, and with a
  // hidden Dock it brings the Dock up instead. A drop something else in
  // the window already took (it called preventDefault) is left to it.
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

  const send = (stopFirst = false) => {
    const { text, attachments } = latest.current;
    // These branches submit no message to sequence after Stop, but the
    // modifier shortcut still stops as it did before.
    const stopOnly = () => {
      if (stopFirst) dispatch({ type: "interrupt", botId: bot.id });
    };
    if (rehearse) { stopOnly(); return void startRehearsal(); }
    if (!text.trim() && !attachments.length) { stopOnly(); return; }
    // `/goal` alone has nothing to aim at yet, so it opens the dialog
    // that asks, rather than sending a goal the server would refuse
    if (/^\s*\/goal\s*$/.test(text) && !attachments.length && !lane?.noGoals) {
      stopOnly();
      dispatch({ type: "openGoal", botId: bot.id, taskId: laneId });
      setDraft({ text: "", attachments: [] });
      setSlash(null);
      return;
    }
    const sent = { text, attachments };
    dispatch({
      type: "send",
      botId: bot.id,
      text: composeOutgoing(text, attachments),
      replyTo: replyTo ?? undefined,
      stopFirst,
      ...(deliveryChoice ? { delivery: deliveryChoice } : {}),
      onFailed: () => giveBack(sent),
    });
    setDeliveryChoice(null);
    track("message_sent", { driver: bot.modelSelection?.instanceId });
    // Empty now, before a quick refusal can hand the input back.
    setDraft({ text: "", attachments: [] });
    setSlash(null);
    setAttachNotice(null);
    onClearReply?.();
  };


  const startRehearsal = () => {
    const { text, attachments } = latest.current;
    const task = composeOutgoing(text, attachments).trim();
    if (!task || rehearsing) return;
    setRehearsing(true);
    setRehearseError(null);
    // Emptied as it goes, like a send. Starting a rehearsal opens its own
    // lane, which can unmount this box before the answer comes back, and
    // the words left in it were then kept as this conversation's draft:
    // back here, Enter would have sent the task for real.
    const sent = { text, attachments };
    setDraft({ text: "", attachments: [] });
    api("/api/rehearsals", { method: "POST", body: JSON.stringify({ botId: bot.id, text: task, compareWith }) })
      .then(() => {
        track("rehearsal_started", { compared: compareWith.length });
        if (!mounted.current) return;
        setRehearse(false);
        setCompareWith([]);
        onClearReply?.();
      })
      .catch((e: Error) => {
        giveBack(sent);
        if (mounted.current) setRehearseError(e.message);
      })
      .finally(() => {
        if (mounted.current) setRehearsing(false);
      });
  };

  // Dictation runs through a native helper rather than the browser speech
  // APIs, which need a network round trip and are not available offline.
  // Partial results land in the field as they arrive and the finished text
  // simply stays there: it is a draft to edit, not a command to send.
  useEffect(() => {
    if (!recording) return;
    const bridge = window.bloks;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      // The helper speaks three kinds of line on one channel. Reading only
      // the transcript, as we used to, threw its errors away: a missing
      // Speech Recognition grant arrived, was dropped, and the button
      // looked broken.
      if (typeof line.level === "number") {
        setLevel(Math.max(0, Math.min(1, line.level)));
        return;
      }
      if (typeof line.error === "string") {
        setRecording(false);
        setSpeechError(SPEECH_TROUBLE[line.error] ?? "Dictation stopped unexpectedly.");
        setSpeechPane(line.error === "speech-not-authorized" ? "speech" : "mic");
        return;
      }
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      setLevel(0);
      // only if nothing more specific already explained itself
      if (code === 1) {
        setSpeechError((current) =>
          current ??
          "Allow Microphone and Speech Recognition in System Settings, Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  /**
   * Dictation is worthless if the button silently does nothing, which is
   * exactly what a missing microphone grant looked like: macOS refuses,
   * the helper never starts, and the icon just sits there. So the grant
   * is settled before recording starts. A first refusal is macOS's to
   * ask; a standing denial it will never ask about again, so that case
   * offers the Settings pane instead of a dead end.
   */
  const toggleMic = async () => {
    if (!window.bloks) {
      setSpeechError("Dictation needs the desktop app.");
      return;
    }
    if (recording) return setRecording(false);

    setSpeechError(null);
    setMicDenied(false);
    const status = await window.bloks.permStatus().catch(() => null);
    let mic = status?.mic ?? "unknown";
    if (mic === "not-determined") {
      mic = (await window.bloks.permRequestMic().catch(() => false)) ? "granted" : "denied";
    }
    if (mic === "denied" || mic === "restricted") {
      setMicDenied(true);
      setSpeechError(
        "Bloks doesn't have microphone access.",
      );
      return;
    }
    baseText.current = text.trim();
    setRecording(true);
  };

  const canSend = Boolean(text.trim()) || attachments.length > 0;

  // While you hold the wheel the server refuses a turn, and it is right
  // to: you are the one driving. But a bare refusal after typing a
  // sentence reads as a bug, so the composer says so first and offers
  // the one thing that fixes it.
  // The mic belongs to the composer, so a composer that goes away has to
  // take it with it. Without this the helper keeps listening with no
  // waveform, no stop button and nothing to type into.
  const quiet = Boolean(bot.held || bot.archivedAt);
  useEffect(() => {
    if (quiet && recording) setRecording(false);
  }, [quiet, recording]);

  // What the tray says. The conversation's (approvals, the engine, other
  // conversations, the goal, what waits to send) and the box's own (a
  // refused file, the microphone, a rehearsal that did not start, words a
  // failed send handed back). The tray orders them; this only says them.
  const working = openLaneWorking(bot);
  const delivery = useDeliveryPreview(bot.id, laneId, rehearse ? "" : text, working, deliveryChoice);
  const approvalsNotice = useApprovalsNotice(bot, approvals);
  const engineNotice = useEngineNotice(bot);
  const creditsNotice = useCreditsNotice(bot);
  const lanesNotice = useOtherLanesNotice(bot);
  const goalNotice = useGoalNotice(bot);
  const suggestionNotice = useSuggestionNotice(bot);
  const unsentNotice = useUnsentNotice(draftKey);
  const queuedNotice = useQueuedNotice({
    messages: waiting,
    threadId: bot.threadId,
    working,
    // Into the running turn when its engine can take words mid-turn,
    // each as it was said; otherwise the same stop Cmd+Enter makes, and
    // what waited goes together in the next turn (server/delivery.ts).
    onSendNow: () => {
      api(`/api/bots/${bot.id}/queued/now`, { method: "POST", body: JSON.stringify({ taskId: laneId }) }).catch((e: Error) =>
        dispatch({ type: "error", message: e.message }),
      );
    },
    onSendAgain,
    editAsk,
  });
  const own: Array<Notice | null> = [
    unsentNotice,
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
    speechError
      ? {
          id: "speech",
          tone: "warn",
          rank: RANK.feedback,
          icon: <Mic size={14} />,
          title: speechError,
          actions: (micDenied || speechPane === "speech") && (
            <TrayButton onClick={() => void window.bloks?.permOpenSettings(speechPane)}>Open Settings</TrayButton>
          ),
          onDismiss: () => setSpeechError(null),
        }
      : null,
    modeRefused
      ? {
          id: "approvals-refused",
          tone: "warn",
          rank: RANK.feedback,
          icon: <ShieldAlert size={14} />,
          title: "Not confirmed.",
          detail: `${bot.name} still asks as before.`,
          onDismiss: () => setModeRefused(false),
        }
      : null,
    rehearseError
      ? {
          id: "rehearse",
          tone: "warn",
          rank: RANK.feedback,
          icon: <FlaskConical size={14} />,
          title: "The rehearsal didn't start.",
          detail: rehearseError,
          onDismiss: () => setRehearseError(null),
        }
      : null,
    ...recoveries.map(
      (item): Notice => ({
        id: `unsent:${item.id}`,
        tone: "warn",
        rank: RANK.unsent,
        icon: <Undo2 size={14} />,
        title: "A message didn't send.",
        detail:
          blockedRecovery === item.id ? "Finish or clear the current draft first." : "Check the chat before sending again.",
        actions: (
          <>
            <TrayButton
              onClick={() => {
                discardRecovery(draftKey, item.id);
                setRecoveries(readRecoveries(draftKey));
                setBlockedRecovery(null);
              }}
            >
              Discard
            </TrayButton>
            <TrayButton strong onClick={() => restore(item.id)}>
              Restore
            </TrayButton>
          </>
        ),
        body: (item.draft.text || item.draft.attachments.length > 0) && (
          <div className="rounded-xl bg-muted/60 px-3 py-1.5 text-body">
            {item.draft.text && (
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-foreground">{item.draft.text}</p>
            )}
            {item.draft.attachments.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {item.draft.attachments.map((a) => (
                  <AttachmentChip key={a.id} attachment={a} />
                ))}
              </div>
            )}
          </div>
        ),
      }),
    ),
  ];
  const notices = [
    approvalsNotice,
    engineNotice,
    creditsNotice,
    lanesNotice,
    goalNotice,
    queuedNotice,
    suggestionNotice,
    guestMailNotice(bot),
    ...own,
    ...(extra ?? []),
  ].filter((n): n is Notice => n !== null);

  // Archived reads exactly like the wheel does from here: the transcript
  // is all still there, and the composer says why nothing can be sent and
  // offers the one press that fixes it. The server refuses either way;
  // this is so nobody types a paragraph into a refusal. The tray stays:
  // an approval or a queued message is no less there for it.
  const standIn = (children: ReactNode, className: string) => (
    <div className="px-4 pb-4 pt-1 md:px-6 md:pb-5">
      <div className="mx-auto max-w-[var(--transcript-width,760px)]">
        <NoticeTray notices={notices} />
        <div
          className={cn(
            "relative z-10 flex items-center gap-3 rounded-2xl border px-3.5 py-3",
            notices.length > 0 && "-mt-3",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );

  if (bot.archivedAt) {
    return standIn(
      <>
        <Archive size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-body leading-relaxed text-muted-foreground">
          {bot.archivedBy
            ? `${state.bots.find((b) => b.id === bot.archivedBy)?.name ?? "The agent that hired it"} archived ${bot.name}${bot.archiveNote ? `: "${bot.archiveNote}"` : ""}. `
            : `${bot.name} is archived. `}
          Restore it to give it new work.
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => dispatch({ type: "restoreBot", botId: bot.id })}
        >
          Restore
        </Button>
      </>,
      "bg-muted",
    );
  }

  if (bot.held) {
    return standIn(
      <>
        <Hand size={15} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 text-body leading-relaxed text-foreground">
          You have {bot.name}&rsquo;s computer ({bot.held.why}). It waits until you hand it back.
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => {
            void api(`/api/bots/${bot.id}/wheel`, { method: "DELETE" }).catch(() => {});
          }}
        >
          Hand it back
        </Button>
      </>,
      "border-warning/40 bg-background",
    );
  }

  const stopRehearsing = () => {
    setCompareWith([]);
    setRehearse(false);
    inputRef.current?.focus();
  };

  const chips = (replyTo || attachments.length > 0 || rehearse || delivery) && (
    <>
      {delivery && (
        <DeliveryLine
          preview={delivery}
          onFlip={() => setDeliveryChoice(delivery.route === "queue" ? "now" : "wait")}
        />
      )}
      {replyTo && <ReplyTag draft={replyTo} onClear={() => onClearReply?.()} />}
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))} />
      ))}
      {rehearse && (
        // what rehearsing means, said where the words go, with who else
        // could try the same task beside it
        <div className="flex w-full animate-pop-in flex-wrap items-center gap-1.5 text-small">
          <span className="text-muted-foreground">
            {bot.name} works on a copy. You choose what to keep.
          </span>
          {others.length > 0 && <ComparePicker others={others} chosen={compareWith} onChange={setCompareWith} />}
        </div>
      )}
    </>
  );

  return (
    <ComposerShell
      notices={notices}
      status={<UsageNotice bot={bot} />}
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
          // the whole window is the target, so say so where the eye is
          <div className="pointer-events-none fixed inset-2 z-50 flex animate-pop-in items-center justify-center rounded-2xl border-2 border-dashed border-brand/50 bg-background/70">
            <span className="rounded-xl bg-popover px-3.5 py-2 text-body text-foreground shadow-lg shadow-(color:--shadow-color)">
              Drop to attach to {bot.name}
            </span>
          </div>
        )
      }
      popover={
        slash &&
        slashShown && (
          <SlashMenu
            label={`${bot.name}'s commands`}
            offered={offered}
            pick={pick}
            onHover={setPick}
            onChoose={choose}
            empty="No skills yet. Add some from Skills or agent settings."
          />
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
          <BoxButton title="Attach a file or image" onClick={() => pickerRef.current?.click()}>
            <Plus size={18} />
          </BoxButton>
        </>
      }
      trail={
        <>
          {/* Rehearse sits with the other ways of sending, quiet until
              it is on, and then plainly on: the next message becomes a
              rehearsal, which is worth not forgetting. */}
          <BoxButton
            title={rehearse ? "Stop rehearsing" : "Rehearse"}
            hint={rehearse ? "Rehearsing: the next message runs on a copy" : "Rehearse: try it on a copy first"}
            pressed={rehearse}
            onClick={() => (rehearse ? stopRehearsing() : setRehearse(true))}
          >
            <FlaskConical size={16} />
          </BoxButton>
          <BoxButton
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
            onClick={() => void toggleMic()}
            className={cn(recording && "animate-pulse bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive motion-reduce:animate-none")}
          >
            {recording ? <VoiceMeter level={level} /> : <Mic size={17} />}
          </BoxButton>
          <SendStop
            mode={canSend ? "send" : working ? "stop" : "idle"}
            sendLabel={working ? `Send, ${modKey()}Enter stops ${bot.name} first` : "Send"}
            onSend={() => send()}
            onStop={() => dispatch({ type: "interrupt", botId: bot.id })}
          />
        </>
      }
      belowStart={<ApprovalModeMenu bot={bot} onRefused={setModeRefused} />}
      belowEnd={
        <>
          <ModelPicker bot={bot} variant="composer" />
          <CodexSpeedMenu bot={bot} />
          <ComposerRing bot={bot} />
        </>
      }
    >
      <div className="relative min-w-0">
        {/* The skills a message carries, marked behind the text (#51). The
            layer has the textarea's exact type and padding and transparent
            text, so each mark sits under its own word; shadeEdges keeps
            it scrolled and faded with the textarea. */}
        <div
          data-skill-layer="1"
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden px-1 py-1 text-lead text-transparent [overflow-wrap:break-word] [white-space:pre-wrap]"
        >
          <div>
            {segments(text, commandIds, dollarIds).map((run, i) =>
              run.skill ? (
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
          aria-label={`Message ${bot.name}`}
          onChange={(e) => {
            setText(e.target.value);
            readSlash(e.target);
          }}
          onSelect={(e) => {
            // the caret moved without typing: the word under it may have changed
            const next = slashAt(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
            if ((next?.start ?? -1) !== (slash?.start ?? -1)) setSlash(next);
          }}
          onBlur={() => setSlash(null)}
          onPaste={(e) => {
            // images in the clipboard become chips; so does a paste long
            // enough to bury the conversation
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
            // the `/` list takes the arrow keys, Enter, Tab and Escape
            // while it is open
            if (slash && offered.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                return setPick((i) => (i + step + offered.length) % offered.length);
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                return choose(offered[Math.min(pick, offered.length - 1)]);
              }
            }
            if (slash && e.key === "Escape") {
              setSlash(null);
              // Only a list that was on screen takes the key. A slash with
              // nothing offered under it had nothing to close, and Esc
              // goes on to what it means next.
              if (slashShown) {
                e.preventDefault();
                return;
              }
            }
            // ↑ in an empty box edits the last thing you said, the way
            // chat apps do. With anything in the box, a chip included, it
            // is only the caret moving, and it stays that.
            if (
              e.key === "ArrowUp" &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.shiftKey &&
              !text &&
              !attachments.length &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0 &&
              onEditLast?.()
            ) {
              e.preventDefault();
              return;
            }
            // Enter sends; Shift+Enter starts a new line. Cmd/Ctrl+Enter
            // stops a running turn first, then sends the same message.
            // Not while a keyboard is still composing a character: that
            // Enter picks the character, and must not stop the turn.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send((e.metaKey || e.ctrlKey) && openLaneWorking(bot));
            }
            if (e.key === "Escape" && recording) return setRecording(false);
            // Esc stops the agent, as the stop button does (GitHub 258).
            // Last in line: the `/` list and dictation have taken theirs
            // above, anything open on top of the conversation closes
            // first, and a keyboard still composing a character cancels
            // that. The box keeps what is in it.
            if (e.key === "Escape" && !e.nativeEvent.isComposing && openLaneWorking(bot) && !escapeTaken()) {
              e.preventDefault();
              dispatch({ type: "interrupt", botId: bot.id });
            }
          }}
          placeholder={
            recording
              ? "Listening…"
              : rehearse
                ? compareWith.length
                  ? "Describe the task to compare…"
                  : "Describe the task to rehearse…"
                : // the transcript and the header already say it is
                  // working; this says what typing does about it, and the
                  // Send button's own hint has the stop-first shortcut
                  working
                  ? `Add to what ${bot.name} is doing`
                  : // stopped on a card: words typed here are read after it is answered
                    lane?.state === "needs-you"
                    ? `${bot.name} is waiting for your answer above.`
                    : `Message ${bot.name}`
          }
          // the scale's own leading for lead text, a whole 24px: a
          // fractional line left the box a fraction short of its words,
          // and a scrollbar stood beside the very first line
          className="relative block w-full min-w-0 resize-none bg-transparent px-1 py-1 text-lead text-foreground outline-none placeholder:truncate placeholder:text-muted-foreground placeholder-shown:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]"
        />
      </div>
    </ComposerShell>
  );
}
