// Defense in depth for permitted human text. Opaque fields are still excluded
// by the projectors. This never discovers credentials or reads an auth file.
//
// What counts as a credential is the backup's list, SECRET_PATHS, read here
// rather than copied: a key added there for backups is protected here the
// same day, and the two cannot drift apart.
import { SECRET_PATHS } from "./backup.ts";
import { own } from "./settings-records.ts";

/** Kept by a backup, because none of these is a key by itself, but each is
 * text that can carry one: a connection URL with a token in it, a server's
 * command line and environment, a chat pairing code. Credentials belong in
 * SECRET_PATHS, not here. */
const SECRET_BEARING = [
  "providers.*.url",
  "xai.url",
  "composio.url",
  "relay.url",
  "custom[].url",
  "chat.whatsapp.webhookUrl",
  "telegram.pairing",
  "telegram.generation",
  "telegram.pending.pairing",
  "telegram.bots.*.pairing",
  "telegram.bots.*.generation",
  "signal.bots.*.pairing",
  "signal.bots.*.generation",
  "mcpServers[].url",
  "mcpServers[].command",
  "mcpServers[].args",
  "mcpServers[].env",
  "instances.*.environment",
  // a custom host's headers as its engine was built with them; the same
  // values are SECRET_PATHS where they are saved (custom[].headers)
  "instances.*.config.headers",
] as const;

// A paired device's chosen name sits beside its digest under remote.devices.
// The name is what the owner calls the phone and the app shows it on the
// device list, so it is the one string under a secret path left readable.
const DISPLAY_NAMES = new Set(["name"]);

function entries(raw: unknown): [string, unknown][] {
  if (!raw || typeof raw !== "object") return [];
  // Own data properties only: never invoke a getter or follow a prototype.
  return Object.entries(Object.getOwnPropertyDescriptors(raw)).flatMap(([key, d]) => ("value" in d ? [[key, d.value] as [string, unknown]] : []));
}

/** Every string at or under one path. `*` is any key, `[]` any list item. */
function collect(node: unknown, steps: string[], out: (value: string) => void, depth = 0): void {
  if (depth > 8) return;
  if (!steps.length) {
    if (typeof node === "string") return out(node);
    for (const [key, value] of entries(node)) if (!DISPLAY_NAMES.has(key)) collect(value, [], out, depth + 1);
    return;
  }
  const [step, ...rest] = steps;
  const list = step!.endsWith("[]");
  const key = list ? step!.slice(0, -2) : step!;
  const children = key === "*" ? entries(node).map(([, value]) => value) : [own(node, key).value];
  for (const child of children) {
    if (child === undefined) continue;
    if (list) {
      if (Array.isArray(child)) for (const item of child) collect(item, rest, out, depth + 1);
    } else collect(child, rest, out, depth + 1);
  }
}

export function inspectionRedactor(...roots: unknown[]): (text: string) => string {
  const protectedText = new Set<string>();
  const add = (raw: string) => {
    // Match the existing credential redactor: common short command/URL
    // fragments must not rewrite permitted names and descriptions.
    if (raw.length < 8) return;
    protectedText.add(raw);
    protectedText.add(encodeURIComponent(raw));
  };
  const take = (raw: string) => {
    add(raw);
    // A header value is often "Bearer <token>"; the token alone is the secret.
    if (/^Bearer\s+\S+$/i.test(raw)) add(raw.replace(/^Bearer\s+/i, ""));
    // A URL hides its secret in a part: user, password, query or path.
    if (!/^[a-z][\w+.-]*:\/\//i.test(raw)) return;
    try {
      const parsed = new URL(raw);
      const decoded = (text: string) => { try { add(decodeURIComponent(text)); } catch { add(text); } };
      decoded(parsed.username);
      decoded(parsed.password);
      for (const value of parsed.searchParams.values()) add(value);
      for (const part of parsed.pathname.split("/")) if (part) decoded(part);
      if (parsed.hash) decoded(parsed.hash.slice(1));
    } catch { /* not a URL after all; the whole string is already protected */ }
  };
  for (const root of roots) {
    for (const path of [...SECRET_PATHS, ...SECRET_BEARING]) collect(root, path.split("."), take);
  }
  const secrets = [...protectedText].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    // and anything that merely looks like a key nobody stored, as the
    // server's own redactor does
    return out.replace(/\b(sk|ck|ak|gsk|xai)[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
      .replace(/\bblok_live_[0-9a-f]{32}\b/g, "[redacted]");
  };
}
