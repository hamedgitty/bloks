// The small question mark that holds the paragraph.
//
// Settings cards had grown explainers three lines deep, read once and
// scrolled past forever after. The explanation still matters the first
// time, so it moves behind a ? that answers on hover: the card keeps
// one line, the paragraph keeps its length, and neither crowds the
// other. Click works too, for touch and for keyboards.
import HelpCircle from "lucide-react/dist/esm/icons/help-circle.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="More about this"
            className={cn(
              "rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground",
              className,
            )}
          >
            <HelpCircle size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] bg-popover px-3 py-2 text-[12px] font-normal leading-relaxed text-popover-foreground shadow-lg [&_svg]:hidden">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
