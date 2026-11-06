// The line above what arrived since the person last read the conversation
// (src/lib/lastRead.ts). Marked like a date line, a fact about the
// conversation rather than something said in it, in the green of the
// unread dot it stands for in the transcript.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function NewLine({ className }: { className?: string }) {
  return (
    <div
      role="separator"
      aria-label={t("chatView.newSince")}
      data-new-line=""
      // the line is where they were, never part of a copied reply
      data-copy="skip"
      className={cn("flex animate-fade-in items-center gap-3 py-1", className)}
    >
      <span aria-hidden className="h-px min-w-6 flex-1 bg-success/45" />
      <span aria-hidden className="text-caption font-semibold tracking-wide text-success">
        {t("chatView.new")}
      </span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-success/45" />
    </div>
  );
}
