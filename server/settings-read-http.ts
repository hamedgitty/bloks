import type { ServerResponse } from "node:http";
import { SettingsPages, type SettingsCategory } from "./settings-pages.ts";

export type SettingsReader =
  | { role: "owner"; identity: string }
  | { role: "agent"; identity: string }
  | { role: "member" | "invite" | "invalid" };

/** Only the narrow route uses this projection. Caller identity is produced
 * by the existing authenticated request boundary, never a body/query field. */
export function serveSettingsRead(
  reader: SettingsReader, method: string, query: URLSearchParams, res: ServerResponse,
  pages: SettingsPages,
  records: (category: SettingsCategory) => { id: string; visible: boolean; project: () => object }[],
): void {
  const send = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (reader.role === "invalid") return send(401, { error: "settings inspection credential is not recognized" });
  if (reader.role !== "owner" && reader.role !== "agent") return send(403, { error: "settings inspection is unavailable to this caller" });
  if (method !== "GET") return send(405, { error: "settings inspection only accepts GET" });
  try {
    const result = pages.read(query, reader.identity, records);
    send(result.status, result.body);
  } catch {
    send(503, { error: "settings observations are unavailable" });
  }
}
