import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.js";
import Mic from "lucide-react/dist/esm/icons/mic.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import Hand from "lucide-react/dist/esm/icons/hand.js";
import Archive from "lucide-react/dist/esm/icons/archive.js";
import FileIcon from "lucide-react/dist/esm/icons/file.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { api, useStore, type Bot } from "@/state/store";
import { ReplyChip, type ReplyDraft } from "./MessageActions";
import { cn } from "@/lib/cn";
import {
  attachmentBasename,
  composeOutgoing,
  formatBytes,
  intakeFiles,
  isLongPaste,
  pasteAttachment,
  uploadImageAttachment,
  type Attachment,
} from "@/lib/attachments";
import { Button } from "@/components/ui/button";

/**
 * Grows with its content up to a ceiling, then scrolls.
 *
 * Measured at `auto` rather than at zero. An empty textarea collapsed to
 * no height reports a scrollHeight of its own maximum rather than of one
 * line, so measuring that way left the composer standing at its ceiling
 * whenever there was nothing in it, which is every time you look at it.
 */
function useAutoSize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Nothing typed is exactly one row, and rows=1 already says that, so
    // the height comes off entirely rather than being measured. An empty
    // textarea does not report the scrollHeight of one line, which is how
    // the composer came to stand at its ceiling whenever it was empty.
    if (!value) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);
  return ref;
}

/** What the helper's error words mean to a person. */
const SPEECH_TROUBLE: Record<string, string> = {
  "speech-not-authorized":
    "Bloks needs Speech Recognition access to turn your voice into text. It is a separate permission from the microphone.",
  "recognizer-unavailable":
    "macOS has no speech recognizer available for English on this Mac right now.",
  "mic-failed": "The microphone could not be opened. Another app may be holding it.",
  "recognition-error": "Recognition stopped. Try again, and check your input device if it repeats.",
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

export function Composer({
  bot,
  replyTo,
  onClearReply,
}: {
  bot: Bot;
  /** reply context to send with the next message */
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}) {
  const { dispatch } = useStore();
  const [text, setText] = useState("");
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
  /** Chips riding with the next message. */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Why something did not become a chip, said once, dismissible. */
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  /** The one road in, whether the files came by picker, drop or paste. */
  const intake = (files: File[]) => {
    if (!files.length) return;
    void intakeFiles(files, {
      pathOf: (file) => window.bloks?.filePath?.(file) ?? "",
      uploadImage: uploadImageAttachment,
    }).then(({ attachments: added, refused }) => {
      if (added.length) setAttachments((current) => [...current, ...added]);
      setAttachNotice(refused);
    });
  };

  const send = () => {
    if (!text.trim() && !attachments.length) return;
    dispatch({
      type: "send",
      botId: bot.id,
      text: composeOutgoing(text, attachments),
      replyTo: replyTo ?? undefined,
    });
    track("message_sent", { driver: bot.modelSelection?.instanceId });
    setText("");
    setAttachments([]);
    setAttachNotice(null);
    onClearReply?.();
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
          "Dictation needs Microphone and Speech Recognition access in System Settings, under Privacy & Security.",
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
      setSpeechError("Voice input needs the desktop app. Run pnpm dev:desktop.");
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
        "Bloks does not have access to your microphone, so dictation cannot start.",
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

  // Archived reads exactly like the wheel does from here: the transcript
  // is all still there, and the composer says why nothing can be sent and
  // offers the one press that fixes it. The server refuses either way;
  // this is so nobody types a paragraph into a refusal.
  if (bot.archivedAt) {
    return (
      <div className="px-4 pb-4 pt-1 md:px-6 md:pb-5">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 rounded-2xl border bg-muted/40 px-3.5 py-3">
          <Archive size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
            {bot.name} is archived. Everything it said is still here, and it will not take new work
            until you restore it.
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => dispatch({ type: "restoreBot", botId: bot.id })}
          >
            Restore
          </Button>
        </div>
      </div>
    );
  }

  if (bot.held) {
    return (
      <div className="px-4 pb-4 pt-1 md:px-6 md:pb-5">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 rounded-2xl border border-warning/40 bg-warning/5 px-3.5 py-3">
          <Hand size={15} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground">
            You have {bot.name}&rsquo;s computer ({bot.held.why}). It will not start anything until you
            hand the wheel back.
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
        </div>
      </div>
    );
  }

  return (
    <div
      className="px-4 pb-4 pt-1 md:px-6 md:pb-5"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        intake([...e.dataTransfer.files]);
      }}
    >
      {replyTo && (
        <div className="mx-auto mb-2 max-w-[760px]">
          <ReplyChip draft={replyTo} onClear={() => onClearReply?.()} />
        </div>
      )}
      {attachNotice && (
        <div className="mx-auto mb-2 flex max-w-[760px] animate-rise-in items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{attachNotice}</span>
          <button
            onClick={() => setAttachNotice(null)}
            className="shrink-0 rounded-lg px-1.5 py-1 opacity-60 transition-opacity hover:opacity-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-[760px] flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex max-w-[240px] items-center gap-1.5 rounded-xl border bg-muted/50 py-1 pl-1.5 pr-1 text-[12px] text-foreground"
            >
              {a.kind === "image" ? (
                <img
                  src={`/api/attachments/${attachmentBasename(a.path)}`}
                  alt={a.name}
                  className="size-7 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <FileIcon size={14} className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {a.kind === "paste" ? `Pasted text, ${a.lines} lines` : a.name}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(a.bytes)}</span>
              <button
                onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}
                className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`Remove ${a.kind === "paste" ? "pasted text" : a.name}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {speechError && (
        <div className="mx-auto mb-2 flex max-w-[760px] animate-rise-in items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{speechError}</span>
          {(micDenied || speechPane === "speech") && (
            <button
              onClick={() => void window.bloks?.permOpenSettings(speechPane)}
              className="shrink-0 rounded-lg bg-warning/15 px-2 py-1 font-medium underline-offset-2 transition-colors hover:bg-warning/25"
            >
              Open Settings
            </button>
          )}
          <button
            onClick={() => setSpeechError(null)}
            className="shrink-0 rounded-lg px-1.5 py-1 opacity-60 transition-opacity hover:opacity-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div
        className={cn(
          "mx-auto flex max-w-[760px] items-end gap-1 rounded-[22px] border bg-background p-1.5 pl-2 shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150",
          "focus-within:border-ring/50",
        )}
      >
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
        <button
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
          title="Attach a file or image"
          onClick={() => pickerRef.current?.click()}
        >
          <Plus size={18} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
            // Enter sends; Shift+Enter starts a new line
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          placeholder={
            recording
              ? "Listening…"
              : bot.busy
                ? `${bot.name} is working. Messages queue…`
                : `Message ${bot.name}`
          }
          className="w-full min-w-0 resize-none self-center bg-transparent px-1 py-1 text-[14.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        {bot.busy ? (
          <button
            onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
            title="Stop"
          >
            <Square size={13} className="fill-current" />
          </button>
        ) : (
          <button
            onClick={() => void toggleMic()}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
              recording
                ? "animate-pulse bg-destructive/15 text-destructive"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            {recording ? <VoiceMeter level={level} /> : <Mic size={17} />}
          </button>
        )}
        <button
          onClick={send}
          disabled={!canSend}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform,opacity] duration-150 ease-out active:scale-95",
            canSend
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "cursor-not-allowed bg-muted text-muted-foreground/60",
          )}
          title="Send"
        >
          <ArrowUp size={17} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}
