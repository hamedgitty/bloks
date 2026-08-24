// The one-line window.
//
// A thought arrives while you are in another app. Going to find Bloks
// first is where most of those die, so this appears over whatever you
// are doing, takes one line, sends it, and leaves. It is deliberately
// not a chat: the reply lands in the agent's thread and the banner tells
// you when it does, which is the job the notification policy already
// does well. Anything more here would be a second, worse app.
import { useEffect, useRef, useState } from "react";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left.js";
import { AgentAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

interface QuickBot {
  id: string;
  name: string;
  title?: string;
  color: string;
  shape?: string;
  hidden?: boolean;
  mascotExpression?: string;
}

const LAST_USED = "bloks-quick-last";

export function QuickAsk() {
  const [bots, setBots] = useState<QuickBot[]>([]);
  const [chosen, setChosen] = useState<string>(() => localStorage.getItem(LAST_USED) ?? "");
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // The roster is small and the panel is short-lived; one read on open is
  // cheaper and calmer than a live subscription.
  useEffect(() => {
    void fetch("/api/bots")
      .then((r) => r.json())
      .then((d) => {
        const list: QuickBot[] = (d.bots ?? []).filter((b: QuickBot) => !b.hidden);
        setBots(list);
        setChosen((current) => (list.some((b) => b.id === current) ? current : (list[0]?.id ?? "")));
      })
      .catch(() => setError("Bloks is not running."));
  }, []);

  // Reopening should feel like a fresh field, not like resuming a form
  // somebody abandoned three days ago.
  useEffect(() => {
    const bridge = window.bloks;
    if (!bridge?.onQuickOpened) return;
    return bridge.onQuickOpened(() => {
      setText("");
      setSent(null);
      setError(null);
      input.current?.focus();
    });
  }, []);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const send = () => {
    const body = text.trim();
    const bot = bots.find((b) => b.id === chosen);
    if (!body || !bot) return;
    localStorage.setItem(LAST_USED, bot.id);
    setSent(bot.name);
    setText("");
    void fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    }).catch(() => setError("That did not send."));
    // Long enough to read, short enough not to be in the way.
    setTimeout(() => window.bloks?.quickHide(), 900);
  };

  const cycle = (by: number) => {
    if (bots.length < 2) return;
    const at = Math.max(0, bots.findIndex((b) => b.id === chosen));
    setChosen(bots[(at + by + bots.length) % bots.length].id);
  };

  const bot = bots.find((b) => b.id === chosen);

  return (
    <div className="flex h-screen w-screen items-start justify-center p-3">
      <div className="w-full overflow-hidden rounded-2xl border bg-popover/95 shadow-2xl shadow-black/40 backdrop-blur-xl">
        {sent ? (
          <div className="flex items-center gap-3 px-4 py-5">
            {bot && <AgentAvatar bot={bot as never} size={30} />}
            <div className="flex-1 text-[14px] text-foreground">Sent to {sent}</div>
            <button
              onClick={() => window.bloks?.quickOpenMain()}
              className="rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Open Bloks
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
              {bot && <AgentAvatar bot={bot as never} size={30} />}
              <textarea
                ref={input}
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") return window.bloks?.quickHide();
                  // Tab walks the roster: the fastest way to redirect a
                  // thought without reaching for the mouse.
                  if (e.key === "Tab") {
                    e.preventDefault();
                    return cycle(e.shiftKey ? -1 : 1);
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={bot ? `Ask ${bot.name}…` : "No agents yet"}
                className="min-h-[46px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex items-center gap-1.5 border-t px-3 py-1.5">
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                {bots.slice(0, 8).map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setChosen(b.id)}
                    title={b.title || b.name}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-1 text-[12px] transition-colors",
                      b.id === chosen
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <AgentAvatar bot={b as never} size={16} />
                    {b.name}
                  </button>
                ))}
              </div>
              <span className="flex shrink-0 items-center gap-1 pl-1 text-[11px] text-muted-foreground">
                <CornerDownLeft size={11} /> send
              </span>
            </div>
          </>
        )}
        {error && <div className="px-4 pb-2 text-[12px] text-destructive">{error}</div>}
      </div>
    </div>
  );
}
