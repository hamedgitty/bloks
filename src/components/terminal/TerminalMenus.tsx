// The terminal's two menus: the dots, for how it draws and behaves, and
// the arrows, for where it sits.
//
// Both are the app's own dropdown menu, so they open, move under the
// arrow keys and close on Escape the way every other menu here does, and
// both give the keyboard back to the shell when they close: a menu
// opened from the terminal was a detour, not a change of task.
import type { ReactNode } from "react";
import {
  AppWindow,
  Eraser,
  Maximize2,
  MoreHorizontal,
  PanelBottom,
  PanelFill,
  PanelLeft,
  PanelRight,
  PanelSplit,
  PanelTop,
  Pencil,
  RotateCw,
  X,
} from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { Tip } from "@/components/ui/tooltip";
import {
  arrangeTerminal,
  moveTerminal,
  type TerminalArrangement,
  type TerminalLayout,
  type TerminalPosition,
} from "@/lib/terminalLayout";
import {
  CURSOR_STYLES,
  FONT_SIZE,
  SCROLLBACK_CHOICES,
  scrollbackLabel,
  stepFont,
  type CursorStyle,
  type Scrollback,
  type TerminalPrefs,
} from "@/lib/terminalPrefs";
import { t, type MessageKey } from "@/lib/i18n";

/** A small square button in the terminal's header. */
export function HeaderButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
  className,
}: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tip label={label}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-foreground",
        pressed && "bg-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
    </Tip>
  );
}

/** The trigger's look, for a Radix trigger that renders its own button. */
const TRIGGER =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96] data-[state=open]:bg-accent data-[state=open]:text-foreground";

export function MoreMenu({
  prefs,
  onPrefs,
  onClear,
  onRestart,
  onRename,
  onCloseTab,
  hasTab,
  onClosed,
}: {
  prefs: TerminalPrefs;
  onPrefs: (change: (current: TerminalPrefs) => TerminalPrefs) => void;
  onClear: () => void;
  onRestart: () => void;
  onRename: () => void;
  onCloseTab: () => void;
  hasTab: boolean;
  /** The menu closed: the keyboard goes back to the shell. */
  onClosed: () => void;
}) {
  const style = t(CURSOR_STYLES.find((c) => c.id === prefs.cursorStyle)?.label ?? "terminalPrefs.cursor.bar");
  // Stepping the text size is something you do a few times in a row
  // while watching it change, so those items leave the menu open.
  const stay = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu modal={false}>
      <Tip label={t("terminalMenus.terminalOptions")}>
        <DropdownMenuTrigger className={TRIGGER} aria-label={t("terminalMenus.terminalOptions")}>
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-[232px]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={style}>{t("terminalMenus.cursorStyle")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.cursorStyle}
              onValueChange={(value) => onPrefs((p) => ({ ...p, cursorStyle: value as CursorStyle }))}
            >
              {CURSOR_STYLES.map((c) => (
                <DropdownMenuRadioItem key={c.id} value={c.id}>
                  {t(c.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem
          checked={prefs.cursorBlink}
          onCheckedChange={(on) => onPrefs((p) => ({ ...p, cursorBlink: on }))}
        >
          {t("terminalMenus.blinkCursor")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.copyOnSelect}
          onCheckedChange={(on) => onPrefs((p) => ({ ...p, copyOnSelect: on }))}
        >
          {t("terminalMenus.copyOnSelect")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={scrollbackLabel(prefs.scrollback)}>{t("terminalMenus.scrollback")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(prefs.scrollback)}
              onValueChange={(value) => onPrefs((p) => ({ ...p, scrollback: Number(value) as Scrollback }))}
            >
              {SCROLLBACK_CHOICES.map((lines) => (
                <DropdownMenuRadioItem key={lines} value={String(lines)}>
                  {scrollbackLabel(lines)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={t("terminalMenus.fontSizePx", { size: prefs.fontSize })}>{t("terminalMenus.textSize")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={(e) => (stay(e), onPrefs((p) => stepFont(p, 1)))}
              disabled={prefs.fontSize >= FONT_SIZE.max}
            >
              {t("terminalMenus.larger")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => (stay(e), onPrefs((p) => stepFont(p, -1)))}
              disabled={prefs.fontSize <= FONT_SIZE.min}
            >
              {t("terminalMenus.smaller")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => (stay(e), onPrefs((p) => stepFont(p, 0)))}
              disabled={prefs.fontSize === FONT_SIZE.initial}
            >
              {t("terminalMenus.actualSize")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClear} disabled={!hasTab}>
          <Eraser />
          {t("common.clear")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename} disabled={!hasTab}>
          <Pencil />
          {t("terminalMenus.renameTab")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRestart} disabled={!hasTab}>
          <RotateCw />
          {t("terminalMenus.restartShell")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseTab} disabled={!hasTab}>
          <X />
          {t("terminalMenus.closeTab")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Labels are catalogue keys, put into words where the menu draws them.
const MOVES: ReadonlyArray<{ position: TerminalPosition; label: MessageKey; Icon: typeof PanelLeft }> = [
  { position: "left", label: "terminalMenus.moveLeft", Icon: PanelLeft },
  { position: "right", label: "terminalMenus.moveRight", Icon: PanelRight },
  { position: "top", label: "terminalMenus.moveTop", Icon: PanelTop },
  { position: "bottom", label: "terminalMenus.moveBottom", Icon: PanelBottom },
];

const ARRANGEMENTS: ReadonlyArray<{ arrangement: TerminalArrangement; label: MessageKey; Icon: typeof PanelLeft }> = [
  { arrangement: "fill", label: "terminalMenus.arrangeFill", Icon: PanelFill },
  { arrangement: "split", label: "terminalMenus.arrangeSplit", Icon: PanelSplit },
];

/** One square choice in the layout menu: an icon, named for the ear. */
function LayoutChoice({
  label,
  chosen,
  onSelect,
  children,
}: {
  label: string;
  chosen: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      aria-label={label}
      aria-checked={chosen}
      role="menuitemradio"
      title={label}
      className={cn(
        "size-9 justify-center p-0 [&_svg]:size-[18px]",
        // the chosen one is marked in the accent's ink, as a mark rather
        // than a fill that carries words
        chosen && "bg-brand/10 data-[highlighted]:bg-brand/15 [&_svg]:text-brand-ink",
      )}
    >
      {children}
    </DropdownMenuItem>
  );
}

export function LayoutMenu({
  layout,
  onLayout,
  onPopOut,
  onClosed,
}: {
  layout: TerminalLayout;
  onLayout: (change: (current: TerminalLayout) => TerminalLayout) => void;
  /** Absent where a window of its own cannot be had. */
  onPopOut?: () => void;
  onClosed: () => void;
}) {
  const fill = layout.arrangement === "fill";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={TRIGGER} aria-label={t("terminalMenus.terminalLayout")}>
        <Maximize2 size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[208px] p-1.5"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuLabel className="pb-1 pt-0.5">{t("terminalMenus.move")}</DropdownMenuLabel>
        <div className="flex gap-1 px-1 pb-1.5">
          {MOVES.map(({ position, label, Icon }) => (
            <LayoutChoice
              key={position}
              label={t(label)}
              chosen={!fill && layout.position === position}
              onSelect={() => onLayout((l) => moveTerminal(l, position))}
            >
              <Icon />
            </LayoutChoice>
          ))}
        </div>
        <DropdownMenuLabel className="pb-1 pt-0.5">{t("terminalMenus.fillAndArrange")}</DropdownMenuLabel>
        <div className="flex gap-1 px-1 pb-1">
          {ARRANGEMENTS.map(({ arrangement, label, Icon }) => (
            <LayoutChoice
              key={arrangement}
              label={t(label)}
              chosen={layout.arrangement === arrangement}
              onSelect={() => onLayout((l) => arrangeTerminal(l, arrangement))}
            >
              <Icon />
            </LayoutChoice>
          ))}
        </div>
        {onPopOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onPopOut}>
              <AppWindow />
              {t("terminalMenus.openInNewWindow")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
