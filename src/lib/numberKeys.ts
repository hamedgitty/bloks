import type { Platform } from "./shortcuts.ts";
import { keysOwner, keysWhere } from "./conversationKeys.ts";

interface NumberKey {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
}

/** Option can turn a number into a symbol on a Mac. The code names the
 * number key even then, including the numpad; use the key only if no code
 * is available. A present code always wins, even if the key differs. */
function macNumber(e: NumberKey): number | null {
  const match = e.code ? /^(?:Digit|Numpad)([1-9])$/.exec(e.code) : /^([1-9])$/.exec(e.key);
  return match ? Number(match[1]) : null;
}

/** A Mac desktop agent key, with no workspace or terminal modifiers. */
export function agentNumberKey(e: NumberKey): number | null {
  if (e.defaultPrevented || e.repeat || e.isComposing || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  return macNumber(e);
}

/** A workspace key. Outside Mac, keep the existing Ctrl+number behavior. */
export function workspaceNumberKey(e: NumberKey, platform: Platform): number | null {
  if (e.defaultPrevented || e.shiftKey) return null;
  if (platform !== "mac") {
    if (e.altKey || !e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key)) return null;
    return Number(e.key);
  }
  if (e.repeat || e.isComposing || !e.metaKey || !e.altKey || e.ctrlKey) return null;
  return macNumber(e);
}

/** Dialogs, menus and terminals keep their own keys. An agent's context
 * menu is not a role=menu, and clicking a numbered row programmatically
 * would otherwise leave it open over the newly selected agent. */
export function numberKeysAvailable(): boolean {
  return keysOwner(keysWhere()) === "conversation" && !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-bot-menu]');
}
