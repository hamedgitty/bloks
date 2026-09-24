// WhatsApp, for rooms linked to a WhatsApp group (server/chat-bridge.ts).
//
// Meta's Cloud API, with its Groups API: one business phone number sits in
// a group, sends into it with the ordinary messages endpoint, and hears it
// through a webhook. That last part is the one real difference from Slack
// and Discord. Those are connections this computer opens, so nothing here
// listens. A webhook is Meta calling an address, and this computer has
// none. So Meta calls Bloks Cloud, which hands the call to this computer
// over the line it already holds open, and says to Meta whatever this
// computer answered. The relay keeps nothing.
//
// Unlike everything else the relay carries, a webhook arrives readable:
// Meta sends it in the clear, and there is no key of ours on Meta's side
// to seal it with. The settings screen says so before anything is turned
// on. What protects it is the signature Meta puts on every call, checked
// here with the app secret, which never leaves this computer.
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChatMessage } from "./chat-bridge.ts";

// overridable only so a test can stand in for Meta
const API = process.env.BLOKS_WHATSAPP_API || "https://graph.facebook.com/v23.0";

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  appSecret: string;
}

export function cleanToken(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9_-]{40,600}$/.test(t) ? t : null;
}
export function cleanPhoneNumberId(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return /^\d{6,20}$/.test(t) ? t : null;
}
export function cleanAppSecret(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  return /^[a-f0-9]{32}$/i.test(t) ? t : null;
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (json as { error?: { message?: string } }).error?.message;
    throw new Error(`WhatsApp said ${message ?? res.status}`);
  }
  return json;
}

/** The business number, checked with the token: the proof both are right. */
export async function whoAmI(token: string, phoneNumberId: string): Promise<{ number: string; name: string }> {
  const me = await call(token, "GET", `/${phoneNumberId}?fields=display_phone_number,verified_name`);
  return { number: String(me.display_phone_number ?? ""), name: String(me.verified_name ?? "WhatsApp") };
}

/** Groups the number is in, for the picker. */
export async function groups(token: string, phoneNumberId: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let path: string | null = `/${phoneNumberId}/groups?limit=100`;
  for (let page = 0; path && page < 5; page++) {
    const body = await call(token, "GET", path);
    const list = Array.isArray(body?.data?.groups) ? body.data.groups : Array.isArray(body?.data) ? body.data : [];
    for (const g of list as Array<Record<string, unknown>>) {
      if (typeof g.id === "string") out.push({ id: g.id, name: typeof g.subject === "string" && g.subject ? g.subject : "A group" });
    }
    const after = body?.paging?.cursors?.after;
    path = typeof after === "string" && after ? `/${phoneNumberId}/groups?limit=100&after=${encodeURIComponent(after)}` : null;
  }
  return out;
}

export async function post(token: string, phoneNumberId: string, groupId: string, text: string): Promise<void> {
  await call(token, "POST", `/${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "group",
    to: groupId,
    type: "text",
    text: { body: text, preview_url: false },
  });
}

/**
 * Whether a webhook body really came from Meta: the X-Hub-Signature-256
 * header is an HMAC of the exact bytes, keyed with the app secret.
 * Constant time, and false for anything malformed.
 */
export function verifySignature(rawBody: string, header: unknown, appSecret: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const want = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Digits only, for comparing a number however it was written. */
const digits = (text: string) => text.replace(/\D/g, "");

/**
 * The group messages in one webhook call, as ChatMessages. Anything that
 * is not text in a group (a status update, a reaction, a one to one chat,
 * an image) is not for a room and is dropped here.
 *
 * WhatsApp writes a mention as "@" and the person's number. A mention of
 * this business number is `addressedBot`, and other numbers are left as
 * they are, since the group already shows them that way.
 */
export function parseWebhook(body: unknown, ownNumber: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const own = digits(ownNumber);
  const entries = Array.isArray((body as { entry?: unknown })?.entry) ? (body as { entry: unknown[] }).entry : [];
  for (const entry of entries as Array<Record<string, any>>) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value ?? {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        const groupId = typeof m?.group_id === "string" ? m.group_id : typeof value.group_id === "string" ? value.group_id : null;
        if (!groupId || m?.type !== "text" || typeof m.text?.body !== "string" || typeof m.from !== "string") continue;
        const raw = m.text.body.slice(0, 4_000);
        const mention = own ? new RegExp(`@\\+?${own}\\b`, "g") : null;
        const addressedBot = Boolean(mention && mention.test(raw));
        const contact = contacts.find((c: Record<string, any>) => c?.wa_id === m.from);
        out.push({
          platform: "whatsapp",
          channelId: groupId,
          userId: m.from,
          userName: String(contact?.profile?.name || "Someone").slice(0, 40),
          text: (mention ? raw.replace(new RegExp(`@\\+?${own}\\b`, "g"), "") : raw).trim(),
          addressedBot,
          // the business number's own messages come back as echoes
          fromBot: Boolean(own) && digits(m.from) === own,
          messageId: typeof m.id === "string" ? m.id : "",
        });
      }
    }
  }
  return out;
}
