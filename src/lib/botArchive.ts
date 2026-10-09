// Archiving, restoring or deleting an agent, sent after the list already
// shows it.
//
// The row moves first, into the drawer or out of it or away, so the press
// feels instant. That is only honest if a refusal undoes it, the same as
// for a room (src/lib/roomPatch.ts): before, a failed archive left the
// agent hidden with no word, and a failed restore left it looking
// restored until the next reload. So a failure is said, and the agents
// are taken from the server again, which is the one place that knows
// what happened.

type Api = (path: string, init?: RequestInit) => Promise<any>;

export function sendBotArchive(
  api: Api,
  botId: string,
  how: "archive" | "forget" | "restore",
  hydrate: (bots: any[]) => void,
  showError: (e: unknown) => void,
): Promise<void> {
  const sent =
    how === "restore"
      ? api(`/api/bots/${botId}/restore`, { method: "POST" })
      : api(`/api/bots/${botId}${how === "forget" ? "?forget=1" : ""}`, { method: "DELETE" });
  return sent.then(
    () => {},
    (e) => {
      showError(e);
      return api("/api/bots").then(
        ({ bots }) => hydrate(bots),
        () => {},
      );
    },
  );
}
