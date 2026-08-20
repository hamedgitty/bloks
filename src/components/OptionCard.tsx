import { useState } from "react";
import X from "lucide-react/dist/esm/icons/x.js";
import { useStore, type Message, type TeamPlan } from "@/state/store";
import { BlokAvatar } from "@/components/Avatar";
import { BLOK_COLOR_NAMES, shapeForBot, type BlokColor } from "@/lib/mascot";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  message,
  roomId,
}: {
  botId: string;
  message: Message;
  /** Set when the card is being shown inside a room, so an answer goes to
   * the room rather than to the agent alone. */
  roomId?: string;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, roomId, messageId: message.id, answer: text.trim() });
  };

  if (card.team) {
    const lead = state.bots.find((b) => b.id === botId);
    return (
      <TeamProposal
        plan={card.team}
        leadName={lead?.name ?? "Your agent"}
        settled={card.answered}
        onHire={() => dispatch({ type: "hireTeam", botId, messageId: message.id })}
        onDecline={() => answer("Not now. Handle this yourself.")}
      />
    );
  }

  return (
    <div className="w-full max-w-[560px] animate-rise-in rounded-2xl border bg-card p-4 shadow-[0_1px_3px_var(--shadow-color)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div
            className={cn(
              "text-[11px] font-semibold uppercase tracking-[0.1em]",
              card.requestId || card.runId ? "text-warning" : "text-brand-ink",
            )}
          >
            {card.requestId ? "Approval" : card.runId ? "Workflow" : "Question"}
          </div>
          <div className="mt-1 text-[14.5px] font-semibold text-foreground">{card.title}</div>
          {card.subtitle && (
            <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              {card.subtitle}
            </div>
          )}
        </div>
        <button
          onClick={() => dispatch({ type: "dismissCard", botId, roomId, messageId: message.id })}
          aria-label="Put this question aside"
          title="Put this question aside"
          className="rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] transition-colors duration-150",
              card.answered === opt
                ? "bg-brand-soft text-brand-ink"
                : "text-foreground hover:bg-accent disabled:hover:bg-transparent",
              card.answered && card.answered !== opt && "opacity-45",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-lg text-[11.5px] font-semibold",
                card.answered === opt ? "bg-brand-ink text-brand-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {/* A workflow gate has exactly two answers and each one decides
          what happens next. Offering a text box beside them would invite
          an answer nobody can act on, and anything unrecognised has to be
          read as a decline, which is not what somebody typing a sentence
          would expect. */}
      {!card.answered && !card.runId && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer…"
          className="mt-2 w-full rounded-xl border border-input bg-transparent px-3 py-2 text-[13.5px] text-foreground outline-none transition-[border-color] duration-150 placeholder:text-muted-foreground focus:border-ring/60"
        />
      )}
    </div>
  );
}

/** Deterministic colour for someone who is not an agent yet, so the roster
 * you approve looks like the roster you get. */
function colorFor(name: string): BlokColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return BLOK_COLOR_NAMES[Math.abs(hash) % BLOK_COLOR_NAMES.length];
}

/**
 * A lead asking to hire. Nothing is created until this is approved, so the
 * card shows the whole roster: who, what they own, and what they can do.
 */
function TeamProposal({
  plan,
  leadName,
  settled,
  onHire,
  onDecline,
}: {
  plan: TeamPlan;
  leadName: string;
  settled?: string;
  onHire: () => void;
  onDecline: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hired = settled === "Hire the team";

  return (
    <div className="w-full max-w-[560px] animate-rise-in overflow-hidden rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)]">
      <div className="px-4 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-ink">
          {hired ? "Team hired" : "Proposed team"}
        </div>
        <div className="mt-1 text-[14.5px] font-semibold text-foreground">
          {leadName} wants {plan.members.length} people for “{plan.room}”
        </div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          They run on the cheaper model and do the legwork. {leadName} reviews everything and reports
          back to you.
        </div>
      </div>

      <div className="mt-3 flex flex-col divide-y border-t">
        {plan.members.map((member) => (
          <div key={member.name} className="flex gap-3 px-4 py-3">
            <BlokAvatar
              color={colorFor(member.name)}
              shape={shapeForBot({ name: member.name })}
              expression="friendly"
              size={30}
              className="mt-0.5 rounded-[9px]"
            />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-foreground">{member.name}</div>
              {member.title && (
                <div className="text-[12.5px] leading-snug text-muted-foreground">{member.title}</div>
              )}
              {member.skills.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {member.skills.map((skill) => (
                    <span
                      key={skill}
                      title={skill}
                      className="max-w-[220px] truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {skill.split(":")[0]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {plan.brief && (
        <div className="border-t px-4 py-2.5">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[12px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {open ? "Hide the brief" : "See the brief they get"}
          </button>
          {open && (
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
              {plan.brief}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
        {hired ? (
          <span className="text-[13px] text-muted-foreground">
            Hired. The room is open and {leadName} has briefed them.
          </span>
        ) : settled ? (
          <span className="text-[13px] text-muted-foreground">Declined.</span>
        ) : (
          <>
            <button
              onClick={onHire}
              className="rounded-xl bg-brand-ink px-3.5 py-2 text-[13.5px] font-medium text-brand-foreground transition-[transform,filter] duration-150 hover:brightness-95 active:scale-[0.98]"
            >
              Hire the team
            </button>
            <button
              onClick={onDecline}
              className="rounded-xl px-3 py-2 text-[13.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
