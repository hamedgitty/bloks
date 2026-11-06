// The questions an agent is waiting on, kept above the composer.
//
// Codex can ask and carry on working (GitHub 415), so a question left
// where it was asked was pushed up and out of view by everything said
// after it, and the person found out only by scrolling back. Here it
// stays in reach until it is answered: in the composer's own column, at
// the composer's width, with the conversation scrolling above it. Where
// it was asked keeps one line that points down here, and once answered
// the card goes and that line becomes its outcome (OptionCard.tsx).
//
// Several at once are a stack with a height of its own, scrolled inside,
// so a run of questions never pushes the conversation off the screen.
// It is tall enough for one ask of several questions, with what the
// agent said before it, to show its Next without scrolling on a laptop.
// Each card is keyed by its message, so one arriving or one answered
// leaves the others, and whatever is typed into them, as they were.
import type { Message } from "@/state/store";
import { OptionCard } from "@/components/OptionCard";
import { t } from "@/lib/i18n";

export function QuestionDock({ botId, questions }: { botId: string; questions: readonly Message[] }) {
  if (!questions.length) return null;
  return (
    <div className="shrink-0 px-4 pt-2 md:px-6">
      <div className="mx-auto max-w-[var(--transcript-width,760px)]">
        {/* The inset gives the cards' shadow room inside the scroll, and
            the negative margins take it back, with the scrollbar's own
            gutter (styles.css) on the right, so their edges meet the
            composer's whether or not there is anything to scroll. */}
        <div
          role="region"
          aria-label={t("optionCard.questionsWaiting")}
          className="-ml-1 -mr-[11px] flex max-h-[min(50vh,480px)] flex-col gap-2 overflow-y-auto overscroll-contain px-1 pb-1 [scrollbar-gutter:stable]"
        >
          {questions.map((m) => (
            <div key={m.id} data-question-dock={m.id} className="shrink-0">
              <OptionCard botId={botId} message={m} dock="card" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
