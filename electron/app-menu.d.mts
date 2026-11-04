// Hand-written twin of app-menu.mjs, so the tests typecheck against the
// same shape the main process builds its menu from.

export type TabCommand = "newConversation" | "closeConversation" | "previousConversation" | "nextConversation";

export type MenuCommand = "settings" | "shortcuts" | TabCommand;

export const TAB_COMMANDS: readonly TabCommand[];

export interface MenuTemplateItem {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  /** Electron hands a click the item, the window and the event, whose
   * `triggeredByAccelerator` says the choice came from the item's key. */
  click?: (item?: unknown, window?: unknown, event?: { triggeredByAccelerator?: boolean }) => void;
  submenu?: MenuTemplateItem[];
}

export function appMenuTemplate(options: {
  name: string;
  packaged: boolean;
  command: (word: MenuCommand) => void;
  /** Quit, told whether it came from ⌘Q rather than the mouse. */
  quit: (byKey: boolean) => void;
  /** Each label in the person's language (electron/menu-words.mjs). */
  words: (key: string, params?: Record<string, string>) => string;
}): MenuTemplateItem[];
