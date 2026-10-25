// Where the person is, as their iPhone says (server/location.ts), and the
// place watchers that act on it (server/watchers.ts). The rules here are
// the ones that keep an old or approximate reading from being taken as
// where somebody is right now, and keep it the owner's alone.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_MS,
  CURRENT_MS,
  LATE_MS,
  REPORTS_PER_HOUR,
  SETTLE_MS,
  Whereabouts,
  agoWords,
  cleanReport,
  cleanState,
  crossingWords,
  freshness,
  hearsWhere,
  metresBetween,
  parsePlace,
  placePending,
  placeStep,
  placeWords,
  sideOf,
  type LocationState,
  type SharedLocation,
} from "../server/location.ts";
import { cleanWatcher, watcherTurn, type Watcher } from "../server/watchers.ts";
import { allows, NEVER } from "../server/agent-cli.ts";
import { nextDueAt } from "../server/next-due.ts";
import { leftOutBecause } from "../server/backup.ts";
import { FEATURES } from "../server/features.ts";
import { hostedRefusal } from "../server/hosted.ts";

const NOW = Date.UTC(2026, 9, 20, 14, 0);
const MIN = 60_000;

/** A report as the phone sends it: Toronto at city level, `ago` back. */
const toronto = (ago = 10 * MIN, extra: Record<string, unknown> = {}) => ({
  sharing: "on",
  location: {
    observedAt: NOW - ago,
    place: { locality: "Toronto", region: "Ontario", country: "Canada", timeZone: "America/Toronto" },
    trigger: "moved",
    ...extra,
  },
});

/** The same, with the neighbourhood and an exact position. */
const queenWest = (ago = 2 * MIN) =>
  toronto(ago, {
    place: { area: "Queen West", locality: "Toronto", region: "Ontario", country: "Canada", timeZone: "America/Toronto" },
    coordinate: { latitude: 43.6447123, longitude: -79.4092567, accuracy: 35.4 },
  });

function store(now = NOW, initial: LocationState = { latest: null, devices: {} }) {
  const saved: LocationState[] = [];
  let clock = now;
  const where = new Whereabouts(initial, (s) => saved.push(structuredClone(s)), () => clock);
  return { where, saved, set: (at: number) => (clock = at) };
}

describe("what a phone may say", () => {
  test("a city, its time zone, and no position unless the person chose one", () => {
    const said = cleanReport(toronto(), NOW);
    assert.ok(said.ok);
    if (!said.ok) return;
    assert.equal(said.location?.precision, "city");
    assert.equal(said.location?.locality, "Toronto");
    assert.equal(said.location?.timeZone, "America/Toronto");
    assert.equal(said.location?.latitude, undefined);
    const exact = cleanReport(queenWest(), NOW);
    assert.ok(exact.ok && exact.location);
    if (!exact.ok || !exact.location) return;
    assert.equal(exact.location.precision, "exact");
    // a metre is as close as anyone needs
    assert.equal(exact.location.latitude, 43.64471);
    assert.equal(exact.location.longitude, -79.40926);
    assert.equal(exact.location.accuracy, 35);
    const area = cleanReport(toronto(1, { place: { area: "Queen West", locality: "Toronto" } }), NOW);
    assert.ok(area.ok && area.location?.precision === "area");
  });

  test("nothing from the future, nothing too old, and no place from a phone that is not sharing", () => {
    assert.equal(cleanReport(toronto(-10 * MIN), NOW).ok, false, "a reading from ten minutes ahead");
    assert.ok(cleanReport(toronto(-2 * MIN), NOW).ok, "a clock a little ahead is a clock, not a lie");
    const ahead = cleanReport(toronto(-2 * MIN), NOW);
    assert.ok(ahead.ok && ahead.location!.observedAt === NOW, "never kept as later than it arrived");
    assert.equal(cleanReport(toronto(8 * 24 * 60 * MIN), NOW).ok, false);
    assert.equal(cleanReport({ ...toronto(), sharing: "paused" }, NOW).ok, false);
    assert.equal(cleanReport({ ...toronto(), sharing: "off" }, NOW).ok, false);
    assert.ok(cleanReport({ sharing: "paused" }, NOW).ok);
    assert.equal(cleanReport({ sharing: "maybe" }, NOW).ok, false);
    assert.equal(cleanReport(null, NOW).ok, false);
  });

  test("ugly input is refused or dropped field by field", () => {
    assert.equal(cleanReport(toronto(1, { coordinate: { latitude: 91, longitude: 0, accuracy: 5 } }), NOW).ok, false);
    assert.equal(cleanReport(toronto(1, { coordinate: { latitude: 1, longitude: 2 } }), NOW).ok, false, "a position without its accuracy");
    assert.equal(cleanReport(toronto(1, { coordinate: { latitude: "1", longitude: 2, accuracy: 5 } }), NOW).ok, false);
    assert.equal(cleanReport(toronto(1, { place: {} }), NOW).ok, false, "neither a place nor a position");
    assert.equal(cleanReport({ ...toronto(), request: "short" }, NOW).ok, false);
    const odd = cleanReport(
      toronto(1, { place: { locality: "Tor\u0000onto\n  ", region: "x".repeat(200), country: "Canada", timeZone: "../../etc/passwd" } }),
      NOW,
    );
    assert.ok(odd.ok && odd.location);
    if (!odd.ok || !odd.location) return;
    assert.equal(odd.location.locality, "Tor onto");
    assert.equal(odd.location.region, undefined, "too long to be a name");
    assert.equal(odd.location.timeZone, undefined);
    // a field nobody asked for goes nowhere
    assert.equal((odd.location as Record<string, unknown>).deviceId, undefined);
  });

  test("words for the place and its age", () => {
    assert.equal(placeWords({ area: "Queen West", locality: "Toronto", region: "Ontario", country: "Canada" }), "Queen West, Toronto, Canada");
    assert.equal(placeWords({ region: "Muskoka", country: "Canada" }), "Muskoka, Canada");
    assert.equal(placeWords({ locality: "Singapore", country: "Singapore" }), "Singapore");
    assert.equal(agoWords(20_000), "a moment ago");
    assert.equal(agoWords(10 * MIN), "10 minutes ago");
    assert.equal(agoWords(3 * 60 * MIN), "3 hours ago");
    assert.equal(agoWords(3 * 24 * 60 * MIN), "3 days ago");
    assert.equal(freshness(CURRENT_MS), "current");
    assert.equal(freshness(CURRENT_MS + 1), "recent");
    assert.equal(freshness(CONTEXT_MS + 1), "old");
  });
});

describe("what this computer keeps", () => {
  test("the last reading only, and an older one changes nothing", () => {
    const { where, saved } = store();
    assert.ok(where.report("phone-1", toronto(10 * MIN)).ok);
    const montreal = toronto(30 * MIN, { place: { locality: "Montreal", country: "Canada" } });
    const late = where.report("phone-1", montreal);
    assert.ok(late.ok && !late.changed);
    assert.equal(where.usable()?.locality, "Toronto");
    assert.equal(saved.at(-1)?.latest?.locality, "Toronto");
    // never a trail: one reading is all there is
    assert.deepEqual(Object.keys(saved.at(-1)!), ["latest", "devices"]);
  });

  test("paused withholds it from agents and watchers; off forgets it", () => {
    const { where } = store();
    where.report("phone-1", toronto());
    assert.equal(where.sharing(), "on");
    where.report("phone-1", { sharing: "paused" });
    assert.equal(where.sharing(), "paused");
    assert.equal(where.usable(), null);
    assert.equal(where.snapshot().latest?.locality, "Toronto", "the owner still sees what was said");
    assert.equal(where.contextLine({ name: "Sam" }), null);
    where.report("phone-1", { sharing: "on" });
    assert.equal(where.usable()?.locality, "Toronto");
    where.report("phone-1", { sharing: "off" });
    assert.equal(where.sharing(), "off");
    assert.equal(where.snapshot().latest, null);
  });

  test("a revoked phone, pairing off and Forget each drop it", () => {
    const { where } = store();
    where.report("phone-1", toronto());
    where.forget();
    assert.equal(where.snapshot().latest, null);
    assert.equal(where.sharing(), "on", "Forget is what is kept, not the phone's choice");
    where.report("phone-1", toronto());
    where.forgetDevice("phone-1");
    assert.equal(where.snapshot().latest, null);
    assert.equal(where.sharing(), "off");
    where.report("phone-2", toronto());
    where.forgetDevices();
    assert.deepEqual(where.snapshot(), { latest: null, devices: {} });
  });

  test("a phone that will not stop is heard again later", () => {
    const { where } = store();
    for (let i = 0; i < REPORTS_PER_HOUR; i++) assert.ok(where.report("phone-1", { sharing: "on" }).ok);
    const refused = where.report("phone-1", toronto());
    assert.ok(!refused.ok && refused.status === 429);
    assert.ok(where.report("phone-2", toronto()).ok, "one phone's count is its own");
  });

  test("what is read back from disk is only what reads right", () => {
    const kept = cleanState({
      latest: { locality: "Toronto", precision: "city", observedAt: 1, receivedAt: 2, deviceId: "phone-1" },
      devices: { "phone-1": { sharing: "on", at: 2, background: true }, "bad id!": { sharing: "on", at: 1 }, x: { sharing: "loud", at: 1 } },
    });
    assert.deepEqual(Object.keys(kept.devices), ["phone-1"]);
    assert.equal(kept.latest?.locality, "Toronto");
    // a reading from a phone nobody knows about any more is not kept
    assert.equal(cleanState({ latest: { precision: "city", observedAt: 1, receivedAt: 2, deviceId: "gone" }, devices: {} }).latest, null);
    assert.deepEqual(cleanState("nonsense"), { latest: null, devices: {} });
  });
});

describe("what an agent is told", () => {
  test("a line ahead of the owner's turn only while it is on and recent", () => {
    const { where, set } = store();
    where.report("phone-1", toronto(10 * MIN));
    const line = where.contextLine({ name: "Sam", cli: "bloks" });
    assert.equal(
      line,
      "(Sam is in Toronto, Canada, approximately, as of 10 minutes ago, from their iPhone. `bloks location` says how exact that is, and `bloks location --fresh` asks the phone for a new reading.)",
    );
    assert.match(where.contextLine({}) ?? "", /^\(The person you work for is in Toronto/);
    assert.doesNotMatch(where.contextLine({ name: "Sam" }) ?? "", /bloks/, "no command for an engine without one");
    where.report("phone-1", queenWest(1 * MIN));
    assert.doesNotMatch(where.contextLine({ name: "Sam" }) ?? "", /approximately/);
    set(NOW + CONTEXT_MS);
    assert.equal(where.contextLine({ name: "Sam" }), null, "an old place is not said as where they are");
  });

  test("bloks location: the age, how exact, and what it is good for", () => {
    const { where, set } = store();
    assert.match(String(where.forAgent({}).note), /off/);
    where.report("phone-1", { sharing: "on", background: false });
    assert.match(String(where.forAgent({}).note), /has not said where it is yet/);
    where.report("phone-1", toronto(5 * MIN));
    const now = where.forAgent({ cli: "bloks" }) as any;
    assert.equal(now.sharing, "on");
    assert.equal(now.location.freshness, "current");
    assert.equal(now.location.ageMinutes, 5);
    assert.equal(now.location.latitude, undefined, "no position the person did not choose to share");
    assert.equal(now.sharesWithBloksClosed, false);
    assert.match(now.note, /not for directions or a pickup point/);
    assert.match(now.note, /only while Bloks is open/);
    set(NOW + 2 * 60 * MIN);
    const later = where.forAgent({ cli: "bloks" }) as any;
    assert.equal(later.location.freshness, "recent");
    assert.match(later.note, /bloks location --fresh/);
    set(NOW + 2 * 24 * 60 * MIN);
    assert.match(String((where.forAgent({}) as any).note), /too old to treat as where they are now/);
    where.report("phone-1", { sharing: "paused" });
    const paused = where.forAgent({}) as any;
    assert.equal(paused.location, null, "paused tells an agent nothing of where");
    assert.match(paused.note, /paused/);
  });

  test("a fresh reading is one taken after the ask, never the one already kept", async () => {
    const { where, set } = store();
    where.report("phone-1", toronto(20 * MIN));
    const frames: unknown[] = [];
    const ask = where.ask((frame) => frames.push(frame));
    assert.equal(frames.length, 1);
    assert.equal(where.ask((frame) => frames.push(frame)), ask, "a second ask a moment later joins the first");
    // the phone answering with what it already had is not an answer
    where.report("phone-1", { ...toronto(20 * MIN), request: ask.id });
    assert.equal(await where.wait(ask, 10), null);
    set(NOW + 1_000);
    const waiting = where.wait(ask, 5_000);
    const answer = where.report("phone-1", { ...queenWest(0), location: { ...queenWest(0).location, observedAt: NOW + 900 }, request: ask.id });
    assert.ok(answer.ok && answer.answered);
    const got = await waiting;
    assert.equal(got?.area, "Queen West");
    // nobody answers: the wait ends and says so, with nothing made up
    set(NOW + 60 * MIN);
    const unanswered = where.ask(() => {});
    assert.notEqual(unanswered, ask);
    assert.equal(await where.wait(unanswered, 20), null);
  });
});

describe("places", () => {
  const reading = (over: Partial<SharedLocation>): SharedLocation => ({
    locality: "Toronto",
    region: "Ontario",
    country: "Canada",
    precision: "city",
    observedAt: NOW,
    receivedAt: NOW,
    deviceId: "phone-1",
    ...over,
  });

  test("a name matches the phone's names, in any case and without accents", () => {
    const montreal = parsePlace("Montréal, Canada")!;
    assert.deepEqual(montreal, { kind: "name", parts: ["montreal", "canada"] });
    assert.equal(sideOf(montreal, 500, reading({ locality: "Montreal", region: "Quebec" })), "in");
    assert.equal(sideOf(montreal, 500, reading({ locality: "MONTRÉAL" })), "in");
    assert.equal(sideOf(montreal, 500, reading({})), "out");
    assert.equal(sideOf(parsePlace("Paris, France")!, 500, reading({ locality: "Paris", region: "Texas", country: "United States" })), "out");
    assert.equal(sideOf(parsePlace("Queen West")!, 500, reading({ area: "Queen West" })), "in");
    assert.equal(sideOf(montreal, 500, reading({ locality: undefined, region: undefined, country: undefined, latitude: 1, longitude: 1, accuracy: 5, precision: "exact" })), null);
    assert.equal(parsePlace(" , "), null);
    assert.equal(parsePlace("91,10"), null, "no latitude past 90, and not a name either");
  });

  test("a point needs a position accurate enough to tell, and a margin to leave", () => {
    const airport = parsePlace("43.6777,-79.6248")!;
    assert.equal(airport.kind, "point");
    const at = (metresNorth: number, accuracy = 30) =>
      reading({ precision: "exact", latitude: 43.6777 + metresNorth / 111_195, longitude: -79.6248, accuracy });
    assert.ok(Math.abs(metresBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }) - 111_195) < 10);
    assert.equal(sideOf(airport, 500, at(400)), "in");
    assert.equal(sideOf(airport, 500, at(600)), null, "between the radius and the margin: undecided");
    assert.equal(sideOf(airport, 500, at(800)), "out");
    assert.equal(sideOf(airport, 500, at(100, 5_000)), null, "a fix this loose cannot tell");
    assert.equal(sideOf(airport, 500, reading({})), null, "no position at all");
  });

  test("arriving fires once, a wobble on the line does not fire again, and a late crossing is not acted on", () => {
    // home at nine, the first side seen
    let step = placeStep(undefined, "out", NOW - 60 * MIN, NOW - 60 * MIN, "arrive");
    assert.equal(step.fire, false);
    assert.deepEqual(step.next, { side: "out", since: NOW - 60 * MIN, base: true });
    // a few minutes later, there: the side it left was where it started
    step = placeStep(step.next, "in", NOW - 55 * MIN, NOW - 55 * MIN, "arrive");
    assert.equal(step.fire, true);
    // the fix wobbles out and back in a minute later: not a second arrival
    step = placeStep(step.next, "out", NOW - 54 * MIN, NOW - 54 * MIN, "arrive");
    assert.equal(step.fire, false);
    step = placeStep(step.next, "in", NOW - 53 * MIN, NOW - 53 * MIN, "arrive");
    assert.equal(step.fire, false);
    // gone for a while and back: a repeat watcher acts on the next visit
    step = placeStep(step.next, "out", NOW - 40 * MIN, NOW - 40 * MIN, "arrive");
    step = placeStep(step.next, "in", NOW - 40 * MIN + SETTLE_MS, NOW - 40 * MIN + SETTLE_MS, "arrive");
    assert.equal(step.fire, true);
    // an old reading arriving now changes nothing it has already seen
    const kept = step.next;
    step = placeStep(kept, "out", NOW - 50 * MIN, NOW, "arrive");
    assert.equal(step.next, kept);
    assert.equal(step.fire, false);
    // a crossing heard too late moves the side and is never acted on
    step = placeStep({ side: "out", since: NOW - 3 * 60 * MIN }, "in", NOW - LATE_MS - MIN, NOW, "arrive");
    assert.equal(step.fire, false);
    assert.equal(step.late, true);
    assert.equal(step.next?.side, "in");
    // a watcher for leaving waits for the other side
    assert.equal(placeStep({ side: "in", since: NOW - 60 * MIN }, "out", NOW, NOW, "leave").fire, true);
    assert.equal(placeStep({ side: "out", since: NOW - 60 * MIN }, "in", NOW, NOW, "leave").fire, false);
    // undecided changes nothing
    assert.equal(placeStep(kept, null, NOW, NOW, "arrive").next, kept);
  });

  test("only a reading that would change a watcher's side is worth looking at", () => {
    const here = reading({});
    assert.equal(placePending("Toronto", undefined, undefined, here), true, "the first side");
    assert.equal(placePending("Toronto", undefined, JSON.stringify({ side: "in", since: NOW - MIN }), here), false);
    assert.equal(placePending("Toronto", undefined, JSON.stringify({ side: "out", since: NOW - MIN }), here), true);
    assert.equal(placePending("Toronto", undefined, JSON.stringify({ side: "out", since: NOW + MIN }), here), false, "older than what it saw");
    assert.equal(placePending("Toronto", undefined, undefined, null), false, "nothing shared");
  });

  test("a place watcher is a place, arriving or leaving, with a radius only for a point", () => {
    const ok = (id: string) => id === "b1";
    const named = cleanWatcher({ kind: "place", target: "Toronto", botId: "b1", instruction: "Send the hotel address", radius: 5 }, ok, NOW);
    assert.ok(named.ok);
    if (named.ok) {
      assert.equal(named.value.when, "arrive");
      assert.equal(named.value.radius, undefined, "a name has no radius");
      assert.equal(named.value.name, "Arriving at Toronto");
    }
    const point = cleanWatcher({ kind: "place", target: "43.6777,-79.6248", when: "leave", radius: 5, once: true, until: "2026-10-24T18:00:00Z", botId: "b1", instruction: "x" }, ok, NOW);
    assert.ok(point.ok);
    if (point.ok) {
      assert.equal(point.value.radius, 100, "never tighter than a phone can tell");
      assert.equal(point.value.when, "leave");
      assert.equal(point.value.once, true);
      assert.equal(point.value.until, Date.UTC(2026, 9, 24, 18));
      assert.equal(point.value.name, "Leaving 43.6777,-79.6248");
    }
    assert.equal(cleanWatcher({ kind: "place", target: "", botId: "b1", instruction: "x" }, ok, NOW).ok, false);
    assert.equal(cleanWatcher({ kind: "place", target: "Toronto", when: "stay", botId: "b1", instruction: "x" }, ok, NOW).ok, false);
    assert.equal(cleanWatcher({ kind: "place", target: "Toronto", until: "2020-01-01", botId: "b1", instruction: "x" }, ok, NOW).ok, false, "a time already past");
    assert.equal(cleanWatcher({ kind: "place", target: "Toronto", until: "soonish", botId: "b1", instruction: "x" }, ok, NOW).ok, false);
    // Place geometry stays local to places; lifetime is common.
    const page = cleanWatcher({ kind: "page", target: "https://x.y", when: "leave", once: true, botId: "b1", instruction: "x" }, ok, NOW);
    assert.ok(page.ok && page.value.when === undefined && page.value.once === true);
  });

  test("the agent is told who crossed, where the phone said, how long ago, and how exactly", () => {
    assert.equal(crossingWords("Toronto", undefined, "arrive"), "has arrived in Toronto");
    assert.equal(crossingWords("Toronto", undefined, "leave"), "has left Toronto");
    assert.equal(crossingWords("43.6777,-79.6248", 2_000, "arrive"), "is now within 2 km of 43.6777, -79.6248");
    const said = watcherTurn(
      { kind: "place", target: "Toronto", instruction: "Send the hotel address.", name: "Landing", once: true },
      "Sam has arrived in Toronto. Their iPhone placed them in Toronto, Canada 3 minutes ago.",
    );
    assert.match(said, /^Your watcher "Landing": Sam has arrived in Toronto\./);
    assert.match(said, /Send the hotel address\./);
    assert.match(said, /act once, so it is done after this turn/);
    assert.match(said, /say so in one line and stop/);
  });

  test("a place watcher wakes nothing on a schedule of its own", () => {
    const place = { id: "w", botId: "b", kind: "place", every: 5, enabled: true, lastCheck: 0 } as Watcher;
    assert.equal(nextDueAt({ routines: [], watchers: [place], suspended: () => false, now: NOW }), null);
  });
});

describe("whose it is", () => {
  test("only the owner's own turn, in a conversation only the owner reads, hears where they are", () => {
    const own = { owner: true, member: false, outsider: false, othersRead: false };
    assert.equal(hearsWhere(own), true);
    // a member asking, or the owner's turn on a member's own agent
    assert.equal(hearsWhere({ ...own, member: true }), false);
    // a Telegram person, a stranger's mail
    assert.equal(hearsWhere({ ...own, outsider: true }), false);
    // the owner talking where members read: a team conversation, a
    // member's private one, a shared room
    assert.equal(hearsWhere({ ...own, othersRead: true }), false);
    assert.equal(hearsWhere({ ...own, owner: false }), false);
  });

  test("an agent may read where the person is, and never report, change or forget it", () => {
    assert.ok(allows("b1", "GET", "/api/agent/location").ok);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(allows("b1", method, "/api/agent/location").ok, false);
    assert.ok(NEVER.includes("/api/location"));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(allows("b1", method, "/api/location").ok, false, method);
    assert.ok(allows("b1", "POST", "/api/watchers").ok, "a place watcher is filed the way any watcher is");
  });

  test("a phone can tell a computer that takes it, and a hosted workspace takes none", () => {
    assert.ok(FEATURES.includes("location"));
    for (const path of ["/api/location", "/api/agent/location"]) assert.equal(hostedRefusal("POST", path)?.status, 409);
  });

  test("not in a backup, and not carried to another computer", () => {
    assert.ok(leftOutBecause("location.json", false, false));
    assert.equal(leftOutBecause("bots/location.json", false, false), null, "only the workspace's own file");
  });
});
