// A change to a room, sent after the list already shows it.
//
// The list moves first so archiving feels instant. That is only honest
// if a refusal undoes it: before, a failed archive left the room hidden
// with no word, and the next reload brought it back as if by itself
// (GitHub 226). So a failure is said, and the rooms are taken from the
// server again, which is the one place that knows what happened.

type Api = (path: string, init?: RequestInit) => Promise<any>;

export function sendRoomPatch(
  api: Api,
  blokId: string,
  patch: Record<string, unknown>,
  hydrate: (bloks: any[]) => void,
  showError: (e: unknown) => void,
): Promise<void> {
  return api(`/api/bloks/${blokId}`, { method: "PATCH", body: JSON.stringify(patch) }).then(
    () => {},
    (e) => {
      showError(e);
      return api("/api/bloks").then(
        ({ bloks }) => hydrate(bloks),
        () => {},
      );
    },
  );
}
