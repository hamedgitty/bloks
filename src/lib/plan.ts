// The Plan page's sense of things: which plan this is, what its status
// says in a few words, which offers are worth showing, and when to look
// again after somebody went to bloks.dev in their browser.
//
// The answers themselves come from bloks.dev, through the server of the
// workspace the page shows (GET /api/plan, server/plan-account.ts),
// already read defensively there. Nothing in this file holds a price: an
// offer's price is whatever words the site sent, and is drawn as it came.

export type PaidPlan = "cloud" | "team" | "ai";
/** What the site files offers under: no licence is "free", and a bundle
 * (Hosting on Team, say) has a name of its own. */
export type PlanKey = "free" | PaidPlan | "hosted" | "team-hosted" | (string & {});

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
  /** Plans an offer needs underneath it ("cloud", "team"). */
  requires: string[];
  for: string[];
  cta: { label: string; url: string } | null;
  /** False for something not on sale yet: shown, never bought. */
  onSale: boolean;
}

export interface Account {
  plan: PaidPlan;
  bundle: string | null;
  interval: "month" | "year" | null;
  /** What the plan costs, in the site's own words, when it says. Never
   * worked out here: no answer means nothing is shown. */
  price?: { amount: string; per: string } | null;
  status: string;
  renewsAt: number | null;
  cancelsAt: number | null;
  since: number | null;
  /** Masked by the site already. */
  email: string | null;
  bloksAi: { active: boolean; renewsAt: number | null } | null;
  hosting: { tier: string | null; state: string | null } | null;
  sharedRoom: boolean | null;
  topUps: number | null;
}

/** GET /api/plan, as this computer's server answers it. */
export interface PlanSnapshot {
  licence: { present: boolean; masked: string | null; kept: boolean };
  account: Account | null;
  /** live: just asked. cached: the last answer, since bloks.dev could not
   * be reached. refused: bloks.dev does not know this key. none: no key. */
  accountState: "live" | "cached" | "refused" | "unavailable" | "none";
  accountAt: number | null;
  problem: string | null;
  offers: Offer[] | null;
  offersState: "live" | "cached" | "unavailable";
  offersAt: number | null;
  /** Where plans are read about, for the one quiet link when offers
   * could not be had. */
  site: string;
  /** The plan the gates in this workspace go by right now. */
  ownerPlan: "cloud" | "team" | null;
  members: { count: number; limit: number };
  /** Whether this was asked on the computer the workspace runs on. False
   * for the owner's own paired devices, which see the plan and open
   * billing but leave the key, Hosting and the offers to that computer.
   * Absent from an older server, which answered only its own window. */
  sameComputer?: boolean;
}

/** Whether the page may offer what is done only where the key is kept:
 * entering, replacing or removing it, Hosting, and the offers, which go
 * to bloks.dev with that key attached. */
export function keyIsHere(snapshot: Pick<PlanSnapshot, "sameComputer">): boolean {
  return snapshot.sameComputer !== false;
}

/** Why the page has no plan to show: this device is not shown it, or it
 * could not be asked. Never the same as having no plan. */
export interface PlanProblem {
  kind: "refused" | "unreachable";
  words: string;
}

/**
 * What a look at the plan that did not land leaves the page with.
 * `status` is the answer's, or null when nothing answered at all.
 *
 * A refusal clears what was shown: this device is not one the plan is
 * shown to, which an older Bloks on the computer the workspace runs on
 * says to every device but its own window. Anything else keeps the last
 * answer and says it is old, so a reading that went missing never looks
 * like no subscription; with nothing to keep, the page says it could not
 * look.
 */
export function failedLook(
  kept: PlanSnapshot | null,
  status: number | null,
): { snapshot: PlanSnapshot | null; stale: boolean; problem: PlanProblem | null } {
  if (status === 401 || status === 403) {
    return {
      snapshot: null,
      stale: false,
      problem: { kind: "refused", words: "Your plan shows on the computer this workspace runs on. Update Bloks there to see it here too." },
    };
  }
  if (kept) return { snapshot: kept, stale: true, problem: null };
  return { snapshot: null, stale: false, problem: { kind: "unreachable", words: "Bloks couldn't read your plan just now." } };
}

export const PLAN_NAMES: Record<string, string> = {
  free: "Self-hosted",
  cloud: "Bloks Cloud",
  team: "Bloks Team",
  ai: "Bloks AI",
  hosted: "Bloks Hosting",
  "team-hosted": "Bloks Team Hosted",
};

export function planName(key: string | null | undefined): string {
  if (!key) return PLAN_NAMES.free;
  return PLAN_NAMES[key] ?? key.replace(/(^|-)([a-z])/g, (_, gap: string, c: string) => `${gap ? " " : ""}${c.toUpperCase()}`);
}

/** The plan the site files this account under: its bundle when it has
 * one, its plan otherwise, and "free" with no key at all. `appPlan` is
 * the plan the desktop app keeps for every workspace on this computer
 * (electron/account-plan.mjs), for a workspace too new to know its own. */
export function planKey(
  snapshot: Pick<PlanSnapshot, "account" | "licence" | "ownerPlan"> | null | undefined,
  appPlan?: "cloud" | "team" | null,
): PlanKey {
  if (!snapshot?.licence.present) return "free";
  if (snapshot.account) return snapshot.account.bundle ?? snapshot.account.plan;
  // a key the site could not be asked about: what the gates go by, else
  // what the app heard from another workspace; "cloud" only as a last guess
  return snapshot.ownerPlan ?? appPlan ?? "cloud";
}

/** Whether something already owned is what this offer sells. */
function owned(offer: Offer, account: Account | null): boolean {
  if (!account) return false;
  const id = offer.id.toLowerCase();
  if (id === account.plan || (account.bundle && id === account.bundle.toLowerCase())) return true;
  if (account.bloksAi?.active && (id === "ai" || id === "bloks-ai")) return true;
  const tier = account.hosting?.tier?.toLowerCase();
  if (tier && (id === "hosting" || id === "hosted" || id === tier || id === `hosting-${tier}`)) return true;
  return false;
}

/**
 * The offers worth showing on this plan, in the order the site gave
 * them. The site already chose them for the plan it was asked about;
 * this only takes away what the person already has (Bloks AI, Hosting,
 * the plan itself), and anything filed for other plans, in case an older
 * answer was kept. With no key, Bloks Cloud leads: it is the first step.
 */
export function ladderFor(key: PlanKey, offers: readonly Offer[] | null | undefined, account: Account | null = null): Offer[] {
  if (!offers?.length) return [];
  const shown = offers.filter((o) => (o.for.length === 0 || o.for.includes(key)) && !owned(o, account));
  if (key !== "free") return shown;
  const cloud = shown.findIndex((o) => o.id === "cloud");
  return cloud > 0 ? [shown[cloud]!, ...shown.slice(0, cloud), ...shown.slice(cloud + 1)] : shown;
}

/** Whether an offer is a way onto Hosting: Hosting itself, a tier of it,
 * or a plan that comes hosted ("team-hosted"). */
export function isHostingOffer(offer: Pick<Offer, "id">): boolean {
  const id = offer.id.toLowerCase();
  return id === "hosting" || id === "hosted" || id.startsWith("hosting-") || id.endsWith("-hosted");
}

/**
 * The way onto Hosting for a licence that has none, as the offers say it:
 * the first Hosting offer on sale with a link, else the first on sale,
 * else the first at all. Null when the site offered none for this plan,
 * which says nothing about whether it is on sale.
 */
export function hostingOffer(offers: readonly Offer[] | null | undefined): Offer | null {
  const hosting = (offers ?? []).filter(isHostingOffer);
  return hosting.find((o) => o.onSale && o.cta) ?? hosting.find((o) => o.onSale) ?? hosting[0] ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 21", or "Nov 21, 2027" when it is not this year. Read in UTC, as
 * the site writes its dates, so a renewal never lands a day early. */
export function shortDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day}, ${d.getUTCFullYear()}`;
}

/** "March 2026", for how long somebody has been a member. */
export function monthYear(at: number): string {
  const d = new Date(at);
  const long = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${long[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export type StatusTone = "on" | "wait" | "issue" | "off";

/**
 * The membership's state, as the calm pill beside the plan's name says
 * it, and the one line under it. Payment due is the one that asks for
 * something: the card on file needs updating, and the page offers the
 * way. When it renews is said apart (renewalWords), beside the pill.
 */
export function statusOf(account: Account, now = Date.now()): { tone: StatusTone; label: string; line: string | null; needsCard: boolean } {
  const status = account.status;
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return { tone: "issue", label: "Payment due", line: "The last payment didn't go through. Update your card to keep your plan.", needsCard: true };
  }
  if (status === "canceled" || status === "cancelled" || status === "incomplete_expired") {
    return { tone: "off", label: "Ended", line: account.cancelsAt ? `Ended on ${shortDate(account.cancelsAt, now)}.` : null, needsCard: false };
  }
  if (account.cancelsAt && account.cancelsAt > now) {
    return { tone: "wait", label: `Cancels on ${shortDate(account.cancelsAt, now)}`, line: null, needsCard: false };
  }
  if (status === "paused") return { tone: "off", label: "Paused", line: null, needsCard: false };
  return { tone: "on", label: status === "trialing" ? "Trial" : "Active", line: null, needsCard: false };
}

/** When the plan next renews, for beside its status: "Renews Nov 21",
 * "Was due Oct 18" for a payment that did not go through, or "Won't
 * renew" beside a cancel, whose date the status already says. Null for a
 * plan that has ended or paused, or a date the site did not say. */
export function renewalWords(account: Account, now = Date.now()): string | null {
  if (statusOf(account, now).tone === "off") return null;
  if (account.cancelsAt && account.cancelsAt > now) return "Won't renew";
  if (!account.renewsAt) return null;
  return `${account.renewsAt < now ? "Was due" : "Renews"} ${shortDate(account.renewsAt, now)}`;
}

/** A price as the site wrote it: "<amount> / month", or "<amount> a
 * month" when its own words already join them. */
export function priceWords(price: { amount: string; per: string } | null | undefined): string | null {
  if (!price?.amount) return null;
  if (!price.per) return price.amount;
  return /^(a|an|per)\b/i.test(price.per) || price.per.startsWith("/") ? `${price.amount} ${price.per}` : `${price.amount} / ${price.per}`;
}

export function intervalWords(interval: Account["interval"]): string | null {
  return interval === "month" ? "Monthly" : interval === "year" ? "Yearly" : null;
}

/** Hosting's tiers, as the row names them and says what each one is. */
const HOSTING_TIERS: Record<string, { name: string; line: string }> = {
  lite: { name: "Hosting Lite", line: "Your own machine. It sleeps when idle and wakes for a message, a routine or a watcher." },
  standard: { name: "Hosting Standard", line: "Your own machine, always on." },
};

/** What bloks.dev says is happening to the machine, in a word or two. A
 * state this build has not heard of is said as it came. */
const HOSTING_STATES: Record<string, { label: string; tone: StatusTone }> = {
  provisioning: { label: "Setting up", tone: "wait" },
  active: { label: "Running", tone: "on" },
  grace: { label: "Stops soon", tone: "issue" },
  stopped: { label: "Stopped", tone: "off" },
};

/** Hosting's row: the tier by name, a line about it, and the machine's
 * state with its tone. */
export function hostingWords(hosting: Account["hosting"]): { name: string; line: string; label: string; tone: StatusTone } | null {
  if (!hosting) return null;
  const tier = HOSTING_TIERS[hosting.tier?.toLowerCase() ?? ""];
  const known = HOSTING_STATES[hosting.state?.toLowerCase() ?? ""];
  const said = hosting.state ? hosting.state.replace(/[_-]+/g, " ") : null;
  return {
    name: tier?.name ?? "Hosting",
    line: tier?.line ?? "A machine that runs your workspace for you.",
    label: known?.label ?? (said ? said.charAt(0).toUpperCase() + said.slice(1) : "Setting up"),
    tone: known?.tone ?? (said ? "off" : "wait"),
  };
}

// ── coming back from the browser ───────────────────────────────────────

/** How long after opening bloks.dev a return to the window still counts
 * as coming back from it. Long enough for a checkout with a card found
 * in a drawer; short enough that tomorrow's focus is just a focus. */
export const RETURN_WINDOW_MS = 45 * 60_000;

/** Whether this focus is somebody coming back from bloks.dev. */
export function cameBack(openedAt: number | null, now = Date.now()): boolean {
  return openedAt !== null && now >= openedAt && now - openedAt <= RETURN_WINDOW_MS;
}

const RANK: Record<string, number> = { free: 0, ai: 1, cloud: 2, hosted: 3, team: 4, "team-hosted": 5 };

/**
 * What to say when a fresh look finds a different plan, or null when
 * nothing moved. Going up is news worth a small moment; going down is
 * said plainly and without one.
 */
export function planChange(before: PlanKey | null, after: PlanKey): { words: string; up: boolean } | null {
  if (before === null || before === after) return null;
  const up = (RANK[after] ?? 2) >= (RANK[before] ?? 0);
  if (after === "free") return { words: "Your plan has ended. Bloks keeps working with your own keys.", up: false };
  return { words: `You're on ${planName(after)} now`, up };
}
