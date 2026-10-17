import type { IncomingMessage, ServerResponse } from "node:http";
import { SettingsWindows, type SettingsAdmission, type SettingsWindowSource } from "./settings-windows.ts";

export type SettingsReportCaller =
  | { role: "owner"; source: SettingsWindowSource }
  | { role: "agent" | "member" | "invite" | "invalid" };

function key(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function admission(raw: unknown): SettingsAdmission | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Partial<SettingsAdmission>;
  return typeof a.label === "string" && a.label.length <= 128 &&
    typeof a.generation === "string" && a.generation.length <= 128 && key(a.capability)
    ? { label: a.label, generation: a.generation, capability: a.capability, issuedAt: 0, lifetimeMs: 0 } : null;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A private frame on this ONE response, outside broadcast and the replay ring.
 * Capacity failure leaves the ordinary chat stream usable. */
export function attachSettingsWindow(windows: SettingsWindows, source: SettingsWindowSource, res: ServerResponse): () => void {
  const opened = windows.open(source);
  res.write(`data: ${JSON.stringify(opened ? {
    kind: "settings-report", windowKey: opened.windowKey, admission: opened.admission,
  } : { kind: "settings-report", unavailable: true })}\n\n`);
  const close = () => { if (opened) windows.close(opened.binding); };
  res.once("close", close);
  res.once("error", close);
  return () => { res.off("close", close); res.off("error", close); close(); };
}

/** Bound bytes before parsing. Do not retain or quote an oversized body.
 * An early refusal drains without buffering while the response completes. */
export async function readSettingsBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) { req.resume(); throw new Error("invalid settings observation"); }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Called only at these exact paths, with authenticated identity resolved
 * before the body is read. Never derives an owner from a loopback socket. */
export async function serveSettingsReport(
  windows: SettingsWindows, caller: SettingsReportCaller, path: string, method: string,
  read: () => Promise<unknown>, res: ServerResponse,
): Promise<void> {
  if (caller.role !== "owner") return json(res, caller.role === "invalid" ? 401 : 403, { error: "settings reporting requires an owner window" });
  if (method !== "POST") return json(res, 405, { error: "settings reporting requires POST" });
  let body: Record<string, unknown>;
  try {
    const raw = await read();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 16_384) {
      return json(res, 400, { error: "invalid settings observation" });
    }
    body = raw as Record<string, unknown>;
  } catch { return json(res, 400, { error: "invalid settings observation" }); }
  if (path === "/api/settings/device-session") {
    if (body.action === "open" && caller.source.path === "remote") {
      const opened = windows.open(caller.source);
      return opened ? json(res, 200, { windowKey: opened.windowKey, admission: opened.admission })
        : json(res, 503, { error: "settings observation capacity is full" });
    }
    if (body.action === "renew" && key(body.windowKey)) {
      const renewed = windows.renewWindow(caller.source, body.windowKey);
      return renewed ? json(res, 200, { admission: renewed })
        : json(res, 409, { error: "settings window is no longer available" });
    }
    if (body.action === "close" && caller.source.path === "remote") {
      const a = admission(body.admission);
      return a && windows.closeAdmission(caller.source, a) ? json(res, 200, { ok: true })
        : json(res, 409, { error: "settings window is no longer available" });
    }
  } else if (path === "/api/settings/device-report") {
    const a = admission(body.admission);
    return a && typeof body.sequence === "number" && windows.report(caller.source, a, body.sequence, body.snapshot)
      ? json(res, 200, { ok: true }) : json(res, 409, { error: "settings observation was not accepted" });
  }
  return json(res, 400, { error: "invalid settings observation" });
}
