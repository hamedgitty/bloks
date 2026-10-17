import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SETTINGS_PAGE_ROWS = 20;
export const SETTINGS_PAGE_BYTES = 32_768;
export const SETTINGS_CATEGORIES = [
  ["workspace.general", "General"], ["workspace.profile", "About you"],
  ["workspace.import", "Bring your setup"], ["workspace.engines", "Engines"],
  ["workspace.agentDefaults", "New agents"], ["workspace.policy", "Rules and approvals"],
  ["workspace.security", "Security checkup"], ["workspace.voices", "Voices"],
  ["workspace.apps", "Apps and keys"], ["workspace.devices", "Phone and devices"],
  ["workspace.channels", "Chat and email"], ["workspace.cloud", "Bloks Cloud"],
  ["workspace.computers", "Computers"], ["workspace.record", "Record"],
  ["workspace.backups", "Backups"], ["workspace.about", "About and updates"],
  ["workspace.launch", "Server launch"], ["agent", "Agent settings"],
  ["room", "Room settings and sharing"], ["automations", "Routines, watchers, workflows, webhooks and goals"],
  ["projects.skills", "Projects, skills and sidebar"], ["device.browser", "Browser observations"],
  ["device.native", "Native desktop observations"], ["device.navigation", "Navigation and lifecycle data"],
  ["device.iphone", "iPhone dependency"],
] as const;
export type SettingsCategory = typeof SETTINGS_CATEGORIES[number][0];
type RecordInput = { id: string; visible: boolean; project: () => object };
export type SettingsPage = { status: number; body: object };
const limits = [
  "Public server and desktop slice; ALL settings coverage remains open.",
  "Private iPhone client contract is unavailable; issue 303 remains open.",
  "Device values are authenticated client observations, not independently attested current UI.",
  "Freshness expires 60 seconds after server issuance even for an idle open window. Last values remain dated observations.",
  "Live collection pages use stable opaque references within this server boot. Insertions before the cursor can be missed; deletions disappear. Restart invalidates continuations.",
];

/** Per-boot references conceal secret-bearing owner ids. Continuations bind
 * caller, category and selection, not a persistent snapshot or read grant. */
export class SettingsPages {
  private readonly secret = randomBytes(32);
  private mac(text: string) { return createHmac("sha256", this.secret).update(text).digest("base64url"); }
  reference(category: SettingsCategory, id: string) { return this.mac(JSON.stringify([category, id])); }
  private cursor(caller: string, category: SettingsCategory, id: string, after: string) {
    const value = Buffer.from(JSON.stringify([this.mac(caller), category, id, after])).toString("base64url");
    return `${value}.${this.mac(value)}`;
  }
  private after(token: string, caller: string, category: SettingsCategory, id: string): string | null {
    if (token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
    const [value, sig] = token.split(".");
    const expected = this.mac(value);
    if (sig!.length !== expected.length || !timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))) return null;
    try {
      const row = JSON.parse(Buffer.from(value!, "base64url").toString("utf8"));
      return Array.isArray(row) && row.length === 4 && row[0] === this.mac(caller) && row[1] === category && row[2] === id &&
        typeof row[3] === "string" && /^[\w-]{43}$/.test(row[3]) ? row[3] : null;
    } catch { return null; }
  }
  read(query: URLSearchParams, caller: string, records: (category: SettingsCategory) => RecordInput[]): SettingsPage {
    const fail = () => ({ status: 400, body: { error: "invalid settings selection" } });
    if ([...query.keys()].some((key) => !["category", "id", "cursor"].includes(key)) ||
      ["category", "id", "cursor"].some((key) => query.getAll(key).length > 1)) return fail();
    const category = query.get("category");
    if (!category) return query.size ? fail() : { status: 200, body: {
      categories: SETTINGS_CATEGORIES.map(([id, control]) => ({ id, control })), limits,
    } };
    if (!SETTINGS_CATEGORIES.some(([id]) => id === category)) return fail();
    const selected = category as SettingsCategory;
    const id = query.get("id") ?? "";
    if (id && !/^[\w-]{43}$/.test(id)) return fail();
    const cursor = query.get("cursor");
    const after = cursor ? this.after(cursor, caller, selected, id) : "";
    if (after === null) return fail();
    // Filtering precedes refs, totals, continuation and projection. A later
    // page re-evaluates membership; a cursor never preserves an old grant.
    const available = records(selected).filter((row) => row.visible)
      .map((row) => ({ ...row, ref: this.reference(selected, row.id) }))
      .filter((row) => !id || row.ref === id).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
    if (id && !available.length) return { status: 404, body: { error: "settings selection unavailable" } };
    const remaining = available.filter((row) => row.ref > after);
    const rows: object[] = [];
    let last = after;
    for (const item of remaining.slice(0, SETTINGS_PAGE_ROWS)) {
      let projected: object;
      try { projected = item.project(); } catch { projected = { status: "unknown", reason: "owner_observation_unavailable" }; }
      let row = { reference: item.ref, observation: projected };
      if (Buffer.byteLength(JSON.stringify(row)) > SETTINGS_PAGE_BYTES / 2) {
        row = { reference: item.ref, observation: { status: "omitted", reason: "size_limit" } };
      }
      const proposed = [...rows, row];
      if (Buffer.byteLength(JSON.stringify(proposed)) > SETTINGS_PAGE_BYTES - 4096) break;
      rows.push(row); last = item.ref;
    }
    return { status: 200, body: { category: selected, rows, total: available.length,
      continuation: rows.length < remaining.length ? this.cursor(caller, selected, id, last) : null,
      limits,
    } };
  }
}
