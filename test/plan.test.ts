// The Plan page's sense of things (src/lib/plan.ts): which offers show on
// which plan, how a membership's status is said, when a focus is
// somebody coming back from bloks.dev with a different plan, and what a
// device other than the key's computer, or a look that failed, is shown.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETURN_WINDOW_MS,
  cameBack,
  failedLook,
  hostingOffer,
  hostingWords,
  isHostingOffer,
  keyIsHere,
  ladderFor,
  planChange,
  planKey,
  planName,
  priceWords,
  renewalWords,
  shortDate,
  statusOf,
  type Account,
  type Offer,
  type PlanSnapshot,
} from "../src/lib/plan.ts";

const offer = (id: string, forPlans: string[], over: Partial<Offer> = {}): Offer => ({
  id,
  name: id,
  tagline: "",
  price: null,
  points: [],
  requires: [],
  for: forPlans,
  cta: { label: "Go", url: `https://bloks.dev/${id}` },
  onSale: true,
  ...over,
});

const account = (over: Partial<Account> = {}): Account => ({
  plan: "cloud",
  bundle: null,
  interval: "month",
  status: "active",
  renewsAt: null,
  cancelsAt: null,
  since: null,
  email: null,
  bloksAi: null,
  hosting: null,
  sharedRoom: null,
  topUps: null,
  ...over,
});

const OFFERS = [
  offer("team", ["free", "cloud"]),
  offer("hosting", ["cloud", "team"]),
  offer("ai", ["free", "cloud", "team"]),
  offer("cloud", ["free"]),
  offer("team-hosted", ["team"]),
  offer("everyone", []),
];

test("with no key, Bloks Cloud leads the ladder and the rest follow in the site's order", () => {
  assert.deepEqual(
    ladderFor("free", OFFERS).map((o) => o.id),
    ["cloud", "team", "ai", "everyone"],
  );
});

test("on Cloud: Team, Hosting and Bloks AI, and nothing Cloud already is", () => {
  assert.deepEqual(
    ladderFor("cloud", OFFERS, account()).map((o) => o.id),
    ["team", "hosting", "ai", "everyone"],
  );
});

test("on Team: Hosting, Bloks AI and Team Hosted, never Team again", () => {
  assert.deepEqual(
    ladderFor("team", [...OFFERS, offer("team", ["team"])], account({ plan: "team" })).map((o) => o.id),
    ["hosting", "ai", "team-hosted", "everyone"],
  );
});

test("what the account already has is not offered again", () => {
  const owned = account({ bloksAi: { active: true, renewsAt: null }, hosting: { tier: "standard", state: "running" } });
  assert.deepEqual(
    ladderFor("cloud", OFFERS, owned).map((o) => o.id),
    ["team", "everyone"],
  );
  const lapsed = account({ bloksAi: { active: false, renewsAt: null } });
  assert.ok(ladderFor("cloud", OFFERS, lapsed).some((o) => o.id === "ai"), "Bloks AI that lapsed is offered again");
  const bundled = account({ plan: "team", bundle: "team-hosted" });
  assert.ok(!ladderFor("team-hosted", [offer("team-hosted", ["team-hosted"])], bundled).length, "a bundle is not offered to itself");
});

test("nothing to show is an empty ladder, never a crash", () => {
  assert.deepEqual(ladderFor("cloud", null), []);
  assert.deepEqual(ladderFor("cloud", []), []);
});

test("the plan key is the bundle, then the plan, then what the gates say, and free without a key", () => {
  const snap = (over: Partial<PlanSnapshot>): PlanSnapshot =>
    ({ licence: { present: true, masked: "x", kept: true }, account: null, ownerPlan: null, ...over }) as PlanSnapshot;
  assert.equal(planKey(snap({ licence: { present: false, masked: null, kept: false } })), "free");
  assert.equal(planKey(snap({ account: account({ plan: "team", bundle: "team-hosted" }) })), "team-hosted");
  assert.equal(planKey(snap({ account: account({ plan: "team" }) })), "team");
  assert.equal(planKey(snap({ ownerPlan: "team" })), "team", "offline, the gates' plan stands in");
  assert.equal(planKey(snap({})), "cloud");
  assert.equal(planKey(null), "free");
});

test("a status is said calmly, and a payment due asks for the card", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const renews = Date.parse("2026-11-21T00:00:00Z");
  assert.deepEqual(statusOf(account({ renewsAt: renews }), now), { tone: "on", label: "Active", line: null, needsCard: false });
  const due = statusOf(account({ status: "past_due", renewsAt: renews }), now);
  assert.equal(due.label, "Payment due");
  assert.equal(due.needsCard, true);
  assert.equal(due.tone, "issue");
  const cancelling = statusOf(account({ cancelsAt: renews }), now);
  assert.equal(cancelling.label, "Cancels on Nov 21");
  assert.equal(cancelling.needsCard, false);
  assert.equal(cancelling.line, null, "the date is in the status, and the facts say it won't renew");
  assert.equal(statusOf(account({ status: "canceled", cancelsAt: Date.parse("2026-09-01T00:00:00Z") }), now).label, "Ended");
  assert.equal(statusOf(account({ status: "trialing", renewsAt: renews }), now).label, "Trial");
  assert.equal(shortDate(Date.parse("2027-01-05T00:00:00Z"), now), "Jan 5, 2027", "another year says its year");
});

test("when a plan renews is said beside its status, and never for one that ended", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(renewalWords(account({ renewsAt: Date.parse("2026-11-21T00:00:00Z") }), now), "Renews Nov 21");
  assert.equal(renewalWords(account({ renewsAt: Date.parse("2027-10-21T00:00:00Z") }), now), "Renews Oct 21, 2027");
  assert.equal(renewalWords(account({ status: "past_due", renewsAt: Date.parse("2026-10-18T00:00:00Z") }), now), "Was due Oct 18");
  assert.equal(renewalWords(account({ renewsAt: Date.parse("2026-11-21T00:00:00Z"), cancelsAt: Date.parse("2026-11-21T00:00:00Z") }), now), "Won't renew");
  assert.equal(renewalWords(account({ status: "canceled", renewsAt: Date.parse("2026-11-21T00:00:00Z") }), now), null);
  assert.equal(renewalWords(account({ status: "paused", renewsAt: Date.parse("2026-11-21T00:00:00Z") }), now), null);
  assert.equal(renewalWords(account(), now), null, "no date said, none made up");
});

test("a price is drawn as the site wrote it, and nothing without one", () => {
  assert.equal(priceWords({ amount: "P2", per: "month" }), "P2 / month");
  assert.equal(priceWords({ amount: "P2", per: "a month" }), "P2 a month");
  assert.equal(priceWords({ amount: "P2", per: "/mo" }), "P2 /mo");
  assert.equal(priceWords({ amount: "P2", per: "" }), "P2");
  assert.equal(priceWords(null), null);
  assert.equal(priceWords(undefined), null);
  assert.equal(priceWords({ amount: "", per: "month" }), null);
});

test("the way onto Hosting is the site's Hosting offer, on sale first, and none is no claim", () => {
  assert.equal(isHostingOffer({ id: "hosting" }), true);
  assert.equal(isHostingOffer({ id: "hosting-lite" }), true);
  assert.equal(isHostingOffer({ id: "team-hosted" }), true);
  assert.equal(isHostingOffer({ id: "team" }), false);
  assert.equal(isHostingOffer({ id: "ai" }), false);
  const soon = offer("hosting", ["cloud"], { onSale: false });
  const lite = offer("hosting-lite", ["cloud"]);
  assert.equal(hostingOffer([offer("team", ["cloud"]), soon])?.id, "hosting", "not on sale is still the offer, said as coming");
  assert.equal(hostingOffer([soon, lite])?.id, "hosting-lite", "one on sale goes first");
  assert.equal(hostingOffer([offer("hosting", ["cloud"], { cta: null }), lite])?.id, "hosting-lite", "and one with a link before one without");
  assert.equal(hostingOffer([offer("team", ["cloud"])]), null);
  assert.equal(hostingOffer(null), null);
});

test("plans are named the way Bloks names them", () => {
  assert.equal(planName("cloud"), "Bloks Cloud");
  assert.equal(planName("team"), "Bloks Team");
  assert.equal(planName("team-hosted"), "Bloks Team Hosted");
  assert.equal(planName(null), "Self-hosted");
  assert.equal(planName("studio-plus"), "Studio Plus", "a plan the app has not heard of is still said readably");
});

test("a hosted machine is named by its tier and its state is said in words", () => {
  assert.equal(hostingWords(null), null);
  const lite = hostingWords({ tier: "lite", state: "provisioning" })!;
  assert.equal(lite.name, "Hosting Lite");
  assert.match(lite.line, /sleeps when idle/);
  assert.deepEqual([lite.label, lite.tone], ["Setting up", "wait"]);
  const standard = hostingWords({ tier: "standard", state: "active" })!;
  assert.equal(standard.name, "Hosting Standard");
  assert.deepEqual([standard.label, standard.tone], ["Running", "on"]);
  assert.deepEqual(
    [hostingWords({ tier: "lite", state: "grace" })!.label, hostingWords({ tier: "lite", state: "grace" })!.tone],
    ["Stops soon", "issue"],
    "a cancelled machine still runs for a while, and says so",
  );
  assert.equal(hostingWords({ tier: "standard", state: "stopped" })!.tone, "off");
  const unknown = hostingWords({ tier: "plus", state: "being_moved" })!;
  assert.deepEqual([unknown.name, unknown.label], ["Hosting", "Being moved"], "something newer is said as it came");
});

test("a focus is a return from bloks.dev only for a while after going there", () => {
  const opened = 1_000_000;
  assert.equal(cameBack(null, opened), false, "nothing was opened");
  assert.equal(cameBack(opened, opened + 5_000), true);
  assert.equal(cameBack(opened, opened + RETURN_WINDOW_MS), true);
  assert.equal(cameBack(opened, opened + RETURN_WINDOW_MS + 1), false, "tomorrow's focus is just a focus");
  assert.equal(cameBack(opened, opened - 1), false);
});

test("a fresh look says a change once, up with a moment and down plainly", () => {
  assert.equal(planChange("cloud", "cloud"), null);
  assert.equal(planChange(null, "team"), null, "a first look is not a change");
  assert.deepEqual(planChange("cloud", "team"), { words: "You're on Bloks Team now", up: true });
  assert.deepEqual(planChange("free", "cloud"), { words: "You're on Bloks Cloud now", up: true });
  assert.equal(planChange("team", "cloud")?.up, false);
  assert.equal(planChange("cloud", "free")?.up, false);
  assert.match(planChange("cloud", "free")!.words, /own keys/);
});

test("the key, Hosting and the offers are offered only where the key is kept (GitHub 357)", () => {
  assert.equal(keyIsHere({ sameComputer: true }), true);
  assert.equal(keyIsHere({ sameComputer: false }), false, "a device elsewhere was offered the key's controls");
  assert.equal(keyIsHere({}), false, "an older answer cannot grant machine controls");
  for (const value of [null, "true", 1, {}]) assert.equal(keyIsHere({ sameComputer: value } as unknown as PlanSnapshot), false);
});

test("a look that did not land never reads as no plan", () => {
  const shown = { licence: { present: true, masked: "x", kept: true }, account: account({ plan: "team" }), ownerPlan: "team" } as PlanSnapshot;
  // the server did not answer, or answered with a failure: what was shown stays, said to be old
  for (const status of [null, 500, 502, 503]) {
    const after = failedLook(shown, status);
    assert.equal(after.snapshot, shown, `the plan shown went away after a ${status ?? "lost"} answer`);
    assert.equal(after.stale, true);
    assert.equal(after.problem, null);
  }
  // with nothing shown yet, the page says it could not look, not that there is no plan
  const first = failedLook(null, null);
  assert.equal(first.snapshot, null);
  assert.equal(first.problem?.kind, "unreachable");
  assert.match(first.problem!.words, /couldn't read your plan/);
  // a refusal is this device not being shown the plan at all
  for (const status of [401, 403]) {
    const refused = failedLook(shown, status);
    assert.equal(refused.snapshot, null);
    assert.equal(refused.stale, false);
    assert.equal(refused.problem?.kind, "refused");
    assert.match(refused.problem!.words, /computer this workspace runs on/);
  }
});
