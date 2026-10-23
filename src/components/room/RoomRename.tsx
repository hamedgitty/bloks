// A room's name, edited where it sits: in the room's header, or on its
// row in the sidebar. The same field in both, and the same rules as a
// conversation's title (LaneRename in SidebarParts.tsx), so renaming a
// room and renaming anything else feel like one thing. An agent's name is
// edited where it is shown too, as the heading of its own page.
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { MAX_ROOM_NAME, nextRoomName } from "@/lib/roomEdit";

/** Enter or clicking away keeps the new name; Escape, or blank, or
 * unchanged, keeps the old one. `onDone` is told which, once. */
export function RoomRename({
  name,
  onDone,
  className,
}: {
  name: string;
  onDone: (next: string | null) => void;
  className?: string;
}) {
  const [value, setValue] = useState(name);
  const ended = useRef(false);
  const end = (next: string | null) => {
    if (ended.current) return;
    ended.current = true;
    onDone(next);
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={MAX_ROOM_NAME}
      aria-label="Rename this room"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => end(nextRoomName(value, name))}
      onKeyDown={(e) => {
        // the row and the header have keys of their own; these are the field's
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") end(null);
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "min-w-0 rounded-md border border-foreground/30 bg-background px-1.5 py-0.5 text-foreground outline-none",
        className,
      )}
    />
  );
}
