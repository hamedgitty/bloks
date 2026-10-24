// What the app says about Bloks AI and about a hosted workspace, held to
// what the server sends: the composer's notice after a used-up allowance
// and the Settings card's meter, top-ups and team rows (src/lib/credits.ts),
// the computer choices both doors offer (src/lib/hosted.ts), and the keys
// a moved workspace asks for again (src/lib/backups.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEAM_SIGN_IN_WARNING,
  allowanceNote,
  meterLine,
  memberRows,
  parseCap,
  refusalToShow,
  renewsLine,
  runsOnCredits,
  teamSignInWarning,
  topUpsLine,
} from "../src/lib/credits.ts";
import { computerOptions, offersThisComputer } from "../src/lib/hosted.ts";
import { keysToEnter, kindLabel } from "../src/lib/backups.ts";
import { computerChoices } from "../server/hosted.ts";
import { CREDITS_KIND } from "../server/credits.ts";

const instances = [
  { instanceId: "claude", driverKind: "claudeAgent" },
  { instanceId: "bloks", driverKind: "bloks" },
  { instanceId: "codex", driverKind: "codex" },
];

test("an agent spends Bloks AI on the Bloks engine, and on nothing else", () => {
  assert.equal(runsOnCredits({ modelSelection: { instanceId: CREDITS_KIND } }, instances), true, "the engine id is the server's");
  assert.equal(runsOnCredits({ modelSelection: { instanceId: "claude" } }, instances), false, "Claude Code is on its own plan or key");
  assert.equal(runsOnCredits({ modelSelection: { instanceId: "codex" } }, instances), false);
  assert.equal(runsOnCredits({ modelSelection: null }, instances), false);
});

test("the composer's notice shows a standing refusal to an agent on credits, until it is put away", () => {
  const refused = { at: 1_000, message: "Bloks AI is used up for now." };
  assert.deepEqual(refusalToShow(refused, true, null), refused);
  assert.equal(refusalToShow(refused, false, null), null, "an agent on its own sign-in was not refused");
  assert.equal(refusalToShow(null, true, null), null, "nothing standing, nothing said");
  assert.equal(refusalToShow(refused, true, 1_000), null, "put away");
  assert.deepEqual(refusalToShow({ ...refused, at: 2_000 }, true, 1_000), { ...refused, at: 2_000 }, "a later refusal is a new one");
});

test("what is left is said as a share of the month, with top-ups and the renewal, and never an amount", () => {
  assert.equal(meterLine({ monthlyLeftPercent: 62, leftPercent: 80 }), "62% of this month left");
  assert.equal(meterLine({ monthlyLeftPercent: null, leftPercent: 40.4 }), "40% of this month left", "all that is left, when not split");
  assert.equal(meterLine({ monthlyLeftPercent: 0.3, leftPercent: 0.3 }), "under 1% of this month left");
  assert.equal(meterLine({ monthlyLeftPercent: 0, leftPercent: 0 }), "Nothing left this month");
  assert.equal(topUpsLine(1), "plus 1 top-up");
  assert.equal(topUpsLine(2.5), "plus 2.5 top-ups");
  assert.equal(topUpsLine(0), null);
  const renews = Date.parse("2026-11-19T12:00:00Z");
  assert.equal(renewsLine(renews, "en-US"), "renews Nov 19");
  assert.equal(allowanceNote({ topUps: 1, renewsAt: renews, low: false }, "en-US"), "Plus 1 top-up · renews Nov 19");
  assert.equal(allowanceNote({ topUps: 0, renewsAt: null, low: true }), "Running low.");
  for (const line of [meterLine({ monthlyLeftPercent: 62, leftPercent: 62 }), allowanceNote({ topUps: 1.5, renewsAt: renews, low: true }, "en-US")]) {
    assert.ok(!/[$€£]|\d+\.\d\d\b|usd|token/i.test(line ?? ""), line ?? "");
  }
});

test("Settings lists a team's members by name, with their use and an optional daily cap", () => {
  const rows = memberRows([
    { member: "m_aaaaaaaaaaaaaaaaaaaaaaaa", name: "Ada", usedPercent: 12, dailyCapPercent: 5 },
    { member: "m_bbbbbbbbbbbbbbbbbbbbbbbb", name: null, usedPercent: 0.2, dailyCapPercent: null },
  ]);
  assert.deepEqual(rows, [
    { member: "m_aaaaaaaaaaaaaaaaaaaaaaaa", name: "Ada", used: "12% used this month", cap: "Up to 5% a day", capPercent: 5 },
    { member: "m_bbbbbbbbbbbbbbbbbbbbbbbb", name: "Someone no longer in a room", used: "under 1% used this month", cap: "No daily cap", capPercent: null },
  ]);
  assert.deepEqual(memberRows(null), []);
  assert.equal(parseCap("10"), 10);
  assert.equal(parseCap(" 7.5 % "), 7.5);
  assert.equal(parseCap(""), null, "empty is no cap");
  assert.equal(parseCap("0"), undefined);
  assert.equal(parseCap("150"), undefined);
  assert.equal(parseCap("$5"), undefined, "a cap is a share, not an amount");
});

test("the team warning shows on a hosted team for agents on a personal sign-in, and nowhere else", () => {
  const claudeOwn = { modelSelection: { instanceId: "claude" } };
  const codex = { modelSelection: { instanceId: "codex" } };
  const ai = { modelSelection: { instanceId: "bloks" } };
  const say = (hosted: boolean, team: boolean | null, agents: object[]) => teamSignInWarning({ hosted, team, agents, instances });
  assert.equal(say(true, true, [claudeOwn]), TEAM_SIGN_IN_WARNING);
  assert.equal(say(true, true, [codex, ai]), TEAM_SIGN_IN_WARNING);
  assert.equal(say(true, true, [ai]), null, "Bloks AI is for a team");
  assert.equal(say(false, true, [claudeOwn]), null, "a Mac is one person's");
  assert.equal(say(true, false, [claudeOwn]), null);
  assert.equal(say(true, null, [claudeOwn]), null, "not until the server knows");
  assert.equal(TEAM_SIGN_IN_WARNING, "A personal Claude or ChatGPT sign-in is for one person. For a team, use an API key or Bloks AI.");
});

test("both doors offer the computers the server says, and a Mac's four otherwise", () => {
  assert.deepEqual(computerOptions(computerChoices(true)).map(([id]) => id), ["local", "off"]);
  assert.deepEqual(computerOptions(computerChoices(false, "darwin")), computerOptions(undefined), "the app's own list is the server's for a Mac");
  assert.equal(offersThisComputer(computerChoices(false, "darwin")), true);
  assert.equal(offersThisComputer(computerChoices(false, "win32")), false, "a PC's own screen is not offered, so Automatic does not promise it");
  assert.equal(offersThisComputer(computerChoices(true, "linux")), true, "a hosted machine is its own computer");
  assert.deepEqual(computerOptions([]).map(([id]) => id), ["cloud", "sandbox", "local", "off"], "an older server sends none");
});

test("a moved workspace names the keys to enter again, each once", () => {
  assert.equal(keysToEnter([]), "No saved keys were left behind.");
  assert.equal(keysToEnter(["OpenRouter key"]), "Keys stay behind. Enter this again where it lands: OpenRouter key.");
  assert.equal(
    keysToEnter(["OpenRouter key", "Saved secret A", "OpenRouter key", "Slack bot token"]),
    "Keys stay behind. Enter these again where it lands: OpenRouter key, Saved secret A and Slack bot token.",
  );
  assert.equal(kindLabel("move"), "For moving");
});
