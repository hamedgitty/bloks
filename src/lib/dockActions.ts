// Where a panel's own buttons go in its pane's top row (dock/SideDock.tsx):
// the terminal's options menu, say, which the terminal draws itself but
// shows up there, beside the pane's minimize, expand and close. A panel
// drawn somewhere React does not reach from the pane (the terminal is
// moved into its box, not rendered there) finds the spot here by name.
import { useSyncExternalStore } from "react";
import type { DockPanel } from "./dock";

const slots = new Map<DockPanel, HTMLElement>();
const listeners = new Set<() => void>();

/** Said by the pane showing a panel: its buttons go in this element, or
 * nowhere once it is null. */
export function setDockActions(panel: DockPanel, el: HTMLElement | null): void {
  if (el ? slots.get(panel) === el : !slots.has(panel)) return;
  if (el) slots.set(panel, el);
  else slots.delete(panel);
  for (const listener of listeners) listener();
}

/** The element a panel's own buttons go in, while a pane shows it. */
export function useDockActions(panel: DockPanel): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => slots.get(panel) ?? null,
    () => null,
  );
}

// ── a pane expanded over the conversation ─────────────────────────────

const expandedPlaces = new Set<string>();

/** Said by the right pane as it expands over its conversation and as it
 * goes back: the conversation's header gives its buttons' place to the
 * pane's own then, so they are not shown twice. */
export function setDockExpanded(key: string, on: boolean): void {
  if (on === expandedPlaces.has(key)) return;
  if (on) expandedPlaces.add(key);
  else expandedPlaces.delete(key);
  for (const listener of listeners) listener();
}

/** Whether a conversation's right pane is expanded over it. */
export function useDockExpanded(key: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => expandedPlaces.has(key),
    () => false,
  );
}
