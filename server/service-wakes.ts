// Trusted-host wake admission uses the lane's existing transcript as its
// only audit. Missing evidence never grants permission to send again.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isLocalRequest } from "./http-guard.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";

export const MAX_SERVICE_WAKE_BYTES = 64_000;
export const MAX_SERVICE_WAKE_BODY_BYTES = MAX_SERVICE_WAKE_BYTES * 6 + 256;
export const MAX_SERVICE_QUEUE_ITEMS = 20;
export const MAX_SERVICE_QUEUE_BYTES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const wakeUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const wakeTextHash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface ServiceWake {
  botId: string;
  taskId: string;
  wakeId: string;
  textHash: string;
  /** Written before preparation can perform work. Not a completion claim. */
  dispatchedAt?: number;
}
export type WakeStatus = "queued" | "dispatched" | "unsent" | "unconfirmed";
export interface WakeInput { taskId: string; wakeId: string; text: string }

/** Header presence matters, including an empty header. Relay callers must
 * be rejected before their loopback forwarding can look like the host. */
export function serviceWakeLocal(req: IncomingMessage, forwarded: boolean): boolean {
  return !forwarded && req.headers.origin === undefined && req.headers.authorization === undefined && isLocalRequest(req);
}
export function readWakeInput(raw: unknown): WakeInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some((key) => !["taskId", "wakeId", "text"].includes(key)) ||
      !wakeUuid(b.taskId) || !wakeUuid(b.wakeId) || typeof b.text !== "string" || !b.text.trim() ||
      Buffer.byteLength(b.text) > MAX_SERVICE_WAKE_BYTES) return null;
  return { taskId: b.taskId, wakeId: b.wakeId, text: b.text };
}
export function ordinaryWakeLane(bot: BotRecord | null | undefined, task: TaskRecord | undefined, special: boolean): boolean {
  return Boolean(bot && !bot.archivedAt && (!bot.solo || bot.solo.by === "owner") && task && !special &&
    !task.personId && !task.team && !task.guestMail && !task.signalPerson && !task.imported);
}
export function wakeRecord(messages: readonly Message[], botId: string, taskId: string, wakeId: string): Message | undefined {
  return messages.find((m) => m.via === "service" && m.serviceWake?.botId === botId && m.serviceWake.taskId === taskId && m.serviceWake.wakeId === wakeId);
}
export function wakeStatus(message: Message | undefined): WakeStatus {
  if (!message?.serviceWake || message.via !== "service") return "unconfirmed";
  if (message.serviceWake.dispatchedAt !== undefined) return "dispatched";
  if (message.unsent || message.deleted) return "unsent";
  return message.queued && !message.deliveredAt ? "queued" : "unconfirmed";
}
/** IDs come only from the admitted queue or the same turn's persisted
 * continuation. Generic input and transcript imports cannot name them. */
export function boundServiceMessages(messages: readonly Message[], botId: string, taskId: string, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.length <= MAX_SERVICE_QUEUE_ITEMS && ids.every((id) => {
    const m = messages.find((message) => message.id === id);
    return m?.role === "user" && m.kind === "text" && m.via === "service" && m.serviceWake?.botId === botId &&
      m.serviceWake.taskId === taskId && wakeUuid(m.serviceWake.wakeId) && !m.deleted && !m.unsent &&
      typeof m.text === "string" && wakeTextHash(m.text) === m.serviceWake.textHash;
  });
}
export function serviceQueueFull(messages: readonly Message[], text: string): boolean {
  const waiting = messages.filter((m) => m.via === "service" && m.queued && !m.deleted && !m.unsent && m.serviceWake?.dispatchedAt === undefined);
  return waiting.length >= MAX_SERVICE_QUEUE_ITEMS || waiting.reduce((n, m) => n + Buffer.byteLength(m.text ?? ""), 0) + Buffer.byteLength(text) > MAX_SERVICE_QUEUE_BYTES;
}
