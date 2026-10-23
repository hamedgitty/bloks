// Your plan, as bloks.dev says it: the membership on the licence this
// computer keeps, the offers worth showing on it, and the way to billing.
//
// Asked from here, never from the page. The licence goes to bloks.dev as a
// bearer, the way Bloks Cloud and the hosting status already take it, and
// nothing that comes back to the window carries it: the page sees the key
// masked, the account as the site describes it (an email it masked
// itself), and offers that are words and links.
//
// Everything bloks.dev sends is read as unknowns and checked one field at
// a time. It is another service's JSON on a bad day, and what survives
// here ends up on a screen, so strings lose control and direction
// characters and are bounded. A price is one of those strings: drawn as it
// came, never worked out or written down here.
//
// A plan that cannot be asked right now is not a plan that changed. The
// last good answers are kept on disk, the account under a fingerprint of
// the key it belongs to (never the key), and shown, dated, when the site
// cannot be reached.
import { createHash } from "node:crypto";

import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";
import { readTime } from "./bloks-ai.ts";
import { CLOUD_KEY } from "./licence.ts";
import { readOwnerLink, requesterKey, type OwnerLink } from "./owner-link.ts";

/** bloks.dev, or wherever BLOKS_SITE_URL points a test or a staging box.
 * No trailing slash. */
export function siteBase(): string {
  return (process.env.BLOKS_SITE_URL || "https://bloks.dev").trim().replace(/\/+$/, "");
}

// ── reading what the site said ─────────────────────────────────────────

// C0 and C1 controls, zero-width and direction marks, and the isolates:
// anything that could hide part of a line or turn it around.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function words(value: unknown, max = 160): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE, "").replace(/\s+/g, " ").trim().slice(0, max);
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A link the page may open: https, or http on this computer's own
 * loopback (a test's stand-in for the site). Null for anything else. */
export function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
  } catch {
    /* not a link */
  }
  return null;
}

export interface OfferPrice {
  amount: string;
  per: string;
  note: string | null;
  yearly: { amount: string; per: string; note: string | null } | null;
}

export interface Offer {
  id: string;
  name: string;
  tagline: string;
  price: OfferPrice | null;
  points: string[];
  requires: string[];
  for: string[];
  cta: { label: string; url: string } | null;
  onSale: boolean;
}

function readPrice(raw: unknown): OfferPrice | null {
  if (!isRecord(raw)) return null;
  const amount = words(raw.amount, 24);
  if (!amount) return null;
  const yearly = isRecord(raw.yearly) && words(raw.yearly.amount, 24)
    ? { amount: words(raw.yearly.amount, 24), per: words(raw.yearly.per, 24) || "year", note: words(raw.yearly.note, 60) || null }
    : null;
  return { amount, per: words(raw.per, 24), note: words(raw.note, 60) || null, yearly };
}

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && ID.test(v)).slice(0, 12) : [];
}

/** One offer, or null for anything short of a whole one. */
export function readOffer(raw: unknown): Offer | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : "";
  const name = words(raw.name, 60);
  if (!id || !name) return null;
  const points = Array.isArray(raw.points) ? raw.points.map((p) => words(p, 120)).filter(Boolean).slice(0, 6) : [];
  const ctaUrl = isRecord(raw.cta) ? safeLink(raw.cta.url) : null;
  const ctaLabel = isRecord(raw.cta) ? words(raw.cta.label, 40) : "";
  return {
    id,
    name,
    tagline: words(raw.tagline, 160),
    price: readPrice(raw.price),
    points,
    requires: ids(raw.requires),
    for: ids(raw.for),
    cta: ctaUrl ? { label: ctaLabel || "Learn more", url: ctaUrl } : null,
    // absent means on sale: an older answer said nothing about it
    onSale: raw.onSale !== false,
  };
}

/** The offers in an answer, or null when it is not an answer at all. */
export function readOffers(text: string): Offer[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.offers)) return null;
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const raw of parsed.offers.slice(0, 24)) {
    const offer = readOffer(raw);
    if (!offer || seen.has(offer.id)) continue;
    seen.add(offer.id);
    out.push(offer);
  }
  return out;
}

export type PaidPlan = "cloud" | "team" | "ai";

export interface Account {
  plan: PaidPlan;
  bundle: string | null;
  interval: "month" | "year" | null;
  /** What the plan costs, as the site words it; null when it says nothing. */
  price: { amount: string; per: string } | null;
  status: string;
  renewsAt: number | null;
  cancelsAt: number | null;
  since: number | null;
  email: string | null;
  bloksAi: { active: boolean; renewsAt: number | null } | null;
  hosting: { tier: string | null; state: string | null } | null;
  sharedRoom: boolean | null;
  topUps: number | null;
}

function interval(value: unknown): Account["interval"] {
  const said = words(value, 12).toLowerCase();
  if (said === "month" || said === "monthly") return "month";
  if (said === "year" || said === "yearly" || said === "annual") return "year";
  return null;
}

/** The account in an answer, or null when it names no plan Bloks knows. */
export function readAccount(text: string): Account | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const plan = raw.plan === "cloud" || raw.plan === "team" || raw.plan === "ai" ? raw.plan : null;
  if (!plan) return null;
  const bundle = typeof raw.bundle === "string" && ID.test(raw.bundle) ? raw.bundle : null;
  const status = words(raw.status, 24).toLowerCase().replace(/[^a-z_]/g, "") || "active";
  const ai = isRecord(raw.bloksAi) ? { active: raw.bloksAi.active === true, renewsAt: readTime(raw.bloksAi.renewsAt) } : null;
  const hosting = isRecord(raw.hosting)
    ? { tier: words(raw.hosting.tier, 32) || null, state: words(raw.hosting.state, 32) || null }
    : null;
  const price = isRecord(raw.price) && words(raw.price.amount, 24) ? { amount: words(raw.price.amount, 24), per: words(raw.price.per, 24) } : null;
  const topUps = typeof raw.topUps === "number" && Number.isInteger(raw.topUps) && raw.topUps >= 0 ? Math.min(raw.topUps, 9999) : null;
  return {
    plan,
    bundle,
    interval: interval(raw.interval),
    price,
    status,
    renewsAt: readTime(raw.renewsAt),
    cancelsAt: readTime(raw.cancelsAt),
    since: readTime(raw.since),
    // masked by the site; anything that still looks like a whole address
    // is masked again here rather than shown
    email: maskEmail(words(raw.email, 120)),
    bloksAi: ai,
    hosting,
    sharedRoom: typeof raw.sharedRoom === "boolean" ? raw.sharedRoom : null,
    topUps,
  };
}

function maskEmail(said: string): string | null {
  if (!said) return null;
  const at = said.indexOf("@");
  if (at < 1) return said;
  const name = said.slice(0, at);
  if (/[*•…]/.test(name)) return said;
  return `${name[0]}${"•".repeat(Math.min(4, Math.max(1, name.length - 1)))}${said.slice(at)}`;
}

/** Where billing is managed: the portal the site opened, or Link's page
 * when Link took the payment. */
export function readManage(text: string): { url: string; manageAt: "portal" | "link" } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const url = safeLink(raw.url);
  if (!url) return null;
  return { url, manageAt: raw.manageAt === "link" ? "link" : "portal" };
}

/** "blok_live_••••3f9a": enough to tell two keys apart, never the key. */
export function maskLicence(key: string | null | undefined): string | null {
  if (!key || !CLOUD_KEY.test(key)) return null;
  return `blok_live_••••${key.slice(-4)}`;
}

/** The fingerprint a cached account is kept under. */
function fingerprint(key: string): string {
  return createHash("sha256").update(`bloks-plan:${key}`).digest("hex").slice(0, 24);
}

/** The plan key the site files offers under. */
const PLAN_KEY = /^[a-z][a-z-]{1,23}$/;

// ── asking, and keeping the last answers ──────────────────────────────

type Fetch = typeof fetch;

interface Saved {
  offers?: Record<string, { list: unknown; at: number }>;
  account?: { id: string; value: unknown; at: number };
}

const OFFERS_FRESH_MS = 10 * 60_000;
const ACCOUNT_FRESH_MS = 2 * 60_000;
const TIMEOUT_MS = 8_000;

export interface AccountAnswer {
  account: Account | null;
  state: "live" | "cached" | "refused" | "unavailable";
  at: number | null;
  problem: string | null;
}

export interface OffersAnswer {
  offers: Offer[] | null;
  state: "live" | "cached" | "unavailable";
  at: number | null;
}

export class PlanAccount {
  private readonly file: string;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly site: () => string;
  private saved: Saved;
  /** When each was last asked live, so a page opened twice in a minute
   * does not ask the site twice. */
  private askedOffers = new Map<string, number>();
  private askedAccount: { id: string; at: number } | null = null;

  constructor(opts: { file: string; fetch?: Fetch; now?: () => number; site?: () => string }) {
    this.file = opts.file;
    this.fetch = opts.fetch ?? ((...args) => fetch(...args));
    this.now = opts.now ?? Date.now;
    this.site = opts.site ?? siteBase;
    this.saved = readSaved<Saved>(this.file, {}, isRecord);
  }

  private keep() {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.saved), 0o600);
    } catch {
      /* kept in memory for this run */
    }
  }

  /** The offers for a plan, as the site files them. */
  async offers(planKey: string, fresh = false): Promise<OffersAnswer> {
    const key = PLAN_KEY.test(planKey) ? planKey : "free";
    const kept = this.saved.offers?.[key];
    const cached = (): OffersAnswer => {
      const list = kept ? readOffers(JSON.stringify({ offers: kept.list })) : null;
      return list ? { offers: list, state: "cached", at: kept!.at } : { offers: null, state: "unavailable", at: null };
    };
    const asked = this.askedOffers.get(key);
    if (!fresh && kept && asked && this.now() - asked < OFFERS_FRESH_MS) {
      const list = readOffers(JSON.stringify({ offers: kept.list }));
      if (list) return { offers: list, state: "live", at: kept.at };
    }
    let res: Response;
    try {
      res = await this.fetch(`${this.site()}/api/cloud/offers?plan=${encodeURIComponent(key)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return cached();
    }
    const text = await res.text().catch(() => "");
    const list = res.ok ? readOffers(text) : null;
    if (!list) return cached();
    const at = this.now();
    this.askedOffers.set(key, at);
    this.saved.offers = { ...(this.saved.offers ?? {}), [key]: { list: list, at } };
    this.keep();
    return { offers: list, state: "live", at };
  }

  /** The membership on a licence. */
  async account(licence: string, fresh = false): Promise<AccountAnswer> {
    const id = fingerprint(licence);
    const kept = this.saved.account?.id === id ? this.saved.account : null;
    const cached = (problem: string): AccountAnswer => {
      const account = kept ? readAccount(JSON.stringify(kept.value)) : null;
      return account ? { account, state: "cached", at: kept!.at, problem } : { account: null, state: "unavailable", at: null, problem };
    };
    if (!fresh && kept && this.askedAccount?.id === id && this.now() - this.askedAccount.at < ACCOUNT_FRESH_MS) {
      const account = readAccount(JSON.stringify(kept.value));
      if (account) return { account, state: "live", at: kept.at, problem: null };
    }
    let res: Response;
    try {
      res = await this.fetch(`${this.site()}/api/cloud/account`, {
        method: "POST",
        headers: { authorization: `Bearer ${licence}`, "content-type": "application/json", accept: "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // never the thrown message: a failed fetch can quote its request
      return cached("Couldn't reach bloks.dev just now.");
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 404) {
      // a key the site does not know is an answer, and the old account
      // under it is not shown as if it still stood
      if (this.saved.account?.id === id) {
        delete this.saved.account;
        this.keep();
      }
      return { account: null, state: "refused", at: this.now(), problem: "bloks.dev doesn't know this key. Check it against your confirmation email." };
    }
    if (res.status === 429) return cached("bloks.dev asked for a moment. Try again shortly.");
    const account = res.ok ? readAccount(text) : null;
    if (!account) return cached(res.ok ? "bloks.dev answered in a way Bloks doesn't understand." : `bloks.dev answered HTTP ${res.status}.`);
    const at = this.now();
    this.askedAccount = { id, at };
    this.saved.account = { id, value: account, at };
    this.keep();
    return { account, state: "live", at, problem: null };
  }

  /** Where to manage billing, asked only when somebody presses for it:
   * the portal's link is short-lived. */
  async manage(licence: string): Promise<{ url: string; manageAt: "portal" | "link" } | { error: string; status: number }> {
    let res: Response;
    try {
      res = await this.fetch(`${this.site()}/api/cloud/manage`, {
        method: "POST",
        headers: { authorization: `Bearer ${licence}`, "content-type": "application/json", accept: "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { error: "Couldn't reach bloks.dev. Check the connection and try again.", status: 502 };
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 404) return { error: "bloks.dev doesn't know this key.", status: 409 };
    const said = res.ok ? readManage(text) : null;
    if (!said) return { error: "bloks.dev couldn't open billing just now. Try again in a moment.", status: 502 };
    return said;
  }

  /**
   * A pairing link to the hosted workspace on this licence (Hosting, on
   * the Plan page): asked of bloks.dev with the key, carried to the
   * workspace by Bloks Cloud, and sealed there for a one-time key made
   * here (server/owner-link.ts), so it is readable on this computer and
   * nowhere on the way. Asked only when somebody presses for it, never
   * kept: the link works once, for fifteen minutes.
   */
  async hostedLink(licence: string): Promise<OwnerLink | { error: string; status: number; waking?: boolean }> {
    const asker = requesterKey();
    let res: Response;
    try {
      res = await this.fetch(`${this.site()}/api/hosting/link`, {
        method: "POST",
        headers: { authorization: `Bearer ${licence}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ key: asker.key }),
        // a sleeping workspace is woken first, which bloks.dev waits for
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { error: "Couldn't reach bloks.dev. Check the connection and try again.", status: 502 };
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const said = isRecord(body) ? words(body.error, 300) : "";
      const waking = isRecord(body) && body.waking === true;
      return {
        error: said || `bloks.dev answered HTTP ${res.status}.`,
        status: res.status === 503 || res.status === 429 ? res.status : res.status >= 500 ? 502 : 409,
        ...(waking ? { waking: true } : {}),
      };
    }
    const link = readOwnerLink(asker.open(isRecord(body) ? body.sealed : null));
    if (!link) return { error: "The link from your hosted workspace could not be opened here. Try again.", status: 502 };
    return link;
  }

  /** Forget the account kept for a key that is gone. */
  forgetAccount() {
    this.askedAccount = null;
    if (!this.saved.account) return;
    delete this.saved.account;
    this.keep();
  }
}

// ── the local routes ───────────────────────────────────────────────────

export interface PlanRouteDeps {
  /** The licence this workspace uses, or null. */
  licence(): string | null;
  /** Whether that licence is the one the app keeps for every workspace
   * (so the app can copy it). */
  kept(): boolean;
  /** The plan the gates go by right now. */
  ownerPlan(): "cloud" | "team" | null;
  /** The site's word on the plan, for the gates. Null when it says
   * nothing they can use (no plan, an ended one, Bloks AI alone). */
  heard(plan: "cloud" | "team" | null, fresh: boolean): Promise<void>;
  members(): { count: number; limit: number };
  /** Forgets the licence here; answers why not, or null. */
  forget(): Promise<string | null>;
}

const ENDED = new Set(["canceled", "cancelled", "incomplete_expired", "unpaid"]);

/**
 * GET /api/plan, POST /api/plan/manage, POST /api/plan/hosting/link and
 * DELETE /api/plan/licence. The caller has already made sure it is the
 * owner asking, never an agent's credential or a member's: the plan, the
 * way to billing and the way into a hosted workspace are the owner's. The
 * first two answer the owner's own paired devices as well; the way into a
 * hosted workspace and forgetting the key answer this computer's own
 * window only.
 */
export async function planRoute(
  method: string,
  path: string,
  query: URLSearchParams,
  deps: PlanRouteDeps,
  plan: PlanAccount,
  localWindow: boolean,
): Promise<{ status: number; body: unknown } | null> {
  if (path === "/api/plan" && method === "GET") {
    const fresh = query.get("fresh") === "1";
    const licence = deps.licence();
    const answer: AccountAnswer | null = licence ? await plan.account(licence, fresh) : null;
    const account = answer?.account ?? null;
    if (answer?.state === "live" && account) {
      const gated = ENDED.has(account.status) ? null : account.plan === "team" || account.plan === "cloud" ? account.plan : null;
      await deps.heard(gated, fresh).catch(() => {});
    } else if (fresh) {
      await deps.heard(null, true).catch(() => {});
    }
    const key = !licence ? "free" : account ? (account.bundle ?? account.plan) : (deps.ownerPlan() ?? "cloud");
    const offers = await plan.offers(key, fresh);
    return {
      status: 200,
      body: {
        licence: { present: Boolean(licence), masked: maskLicence(licence), kept: localWindow && Boolean(licence) && deps.kept() },
        account,
        accountState: answer?.state ?? "none",
        accountAt: answer?.at ?? null,
        problem: answer?.problem ?? null,
        offers: offers.offers,
        offersState: offers.state,
        offersAt: offers.at,
        site: siteBase(),
        ownerPlan: deps.ownerPlan(),
        members: deps.members(),
      },
    };
  }
  if (path === "/api/plan/manage" && method === "POST") {
    const licence = deps.licence();
    if (!licence) return { status: 409, body: { error: "There is no Bloks key on this computer." } };
    const said = await plan.manage(licence);
    return "error" in said ? { status: said.status, body: { error: said.error } } : { status: 200, body: said };
  }
  if (path === "/api/plan/hosting/link" && method === "POST") {
    const licence = deps.licence();
    if (!licence) return { status: 409, body: { error: "There is no Bloks key on this computer." } };
    const said = await plan.hostedLink(licence);
    return "error" in said
      ? { status: said.status, body: { error: said.error, ...(said.waking ? { waking: true } : {}) } }
      : { status: 200, body: said };
  }
  if (path === "/api/plan/licence" && method === "DELETE") {
    if (!deps.licence()) return { status: 200, body: { removed: false } };
    const problem = await deps.forget();
    if (problem) return { status: 502, body: { error: problem } };
    plan.forgetAccount();
    return { status: 200, body: { removed: true } };
  }
  if (path === "/api/plan" || path.startsWith("/api/plan/")) return { status: 405, body: { error: "GET /api/plan, POST /api/plan/manage, POST /api/plan/hosting/link or DELETE /api/plan/licence" } };
  return null;
}
