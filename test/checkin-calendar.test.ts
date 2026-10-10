// Check-ins in the routine editor and on the calendar: the editor says no
// to what the server would refuse, a check-in is one band with a tick per
// run rather than a card per run, and a stretch of quiet runs is one row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkInBand, checkInProblem, everyMinutes, foldQuietRuns, intervalShort } from "../src/lib/checkIns.ts";
import { checkInsOn } from "../server/routines.ts";

test("the editor reads an interval in minutes or hours, within the server's bounds", () => {
  assert.equal(everyMinutes("30", "min"), 30);
  assert.equal(everyMinutes("2", "hour"), 120);
  assert.equal(everyMinutes("1.5", "hour"), 90);
  assert.equal(everyMinutes("", "min"), null);
  assert.equal(everyMinutes("soon", "min"), null);
  assert.equal(everyMinutes("-5", "min"), null);

  assert.equal(checkInProblem(30, { from: "09:00", to: "18:00" }), null);
  assert.equal(checkInProblem(1440, null), null);
  assert.match(checkInProblem(10, null) ?? "", /15 minutes/);
  assert.match(checkInProblem(25 * 60, null) ?? "", /24 hours/);
  assert.match(checkInProblem(null, null) ?? "", /15 minutes/);
  assert.match(checkInProblem(30, { from: "18:00", to: "09:00" }) ?? "", /end after they start/);
  assert.match(checkInProblem(30, { from: "09:00", to: "09:00" }) ?? "", /end after they start/);
});

test("a check-in is one band over its hours, with a tick for each run the column draws", () => {
  const halfHourly = { every: 30, activeHours: { from: "09:00", to: "18:00" } };
  const band = checkInBand(halfHourly, 6, 23)!;
  assert.equal(band.top, 3 * 60, "starts three hours below a 6:00 top");
  assert.equal(band.height, 9 * 60);
  assert.equal(band.ticks.length, 19);
  assert.equal(band.ticks[0], 0);
  assert.equal(band.ticks[18], 9 * 60);

  // its ticks are the server's own slots, so the calendar and the
  // scheduler never disagree about when it runs
  const day = new Date(2026, 2, 17);
  const slots = checkInsOn({ ...halfHourly, days: [] }, day).map((at) => at.getHours() * 60 + at.getMinutes() - 9 * 60);
  assert.deepEqual(band.ticks, slots);

  // all day is clipped to what the column draws
  const allDay = checkInBand({ every: 120 }, 6, 23)!;
  assert.equal(allDay.top, 0);
  assert.equal(allDay.height, 17 * 60);
  assert.deepEqual(allDay.ticks, [0, 120, 240, 360, 480, 600, 720, 840, 960]);

  // hours the column does not draw leave nothing to draw
  assert.equal(checkInBand({ every: 30, activeHours: { from: "01:00", to: "05:00" } }, 6, 23), null);
  assert.equal(checkInBand({}, 6, 23), null, "a time of day is a card, not a band");
});

test("an interval fits a month cell in a few characters", () => {
  assert.equal(intervalShort(30), "30m");
  assert.equal(intervalShort(90), "90m");
  assert.equal(intervalShort(120), "2h");
  assert.equal(intervalShort(1440), "24h");
});

test("a stretch of quiet runs is one row in the history, between the runs that said something", () => {
  const runs = [
    { id: "a", quiet: true },
    { id: "b", quiet: true },
    { id: "c" },
    { id: "d", quiet: true },
    { id: "e" },
    { id: "f" },
  ];
  assert.deepEqual(
    foldQuietRuns(runs).map((row) => ("quiet" in row ? row.quiet.map((r) => r.id).join("") : row.run.id)),
    ["ab", "c", "d", "e", "f"],
  );
  assert.deepEqual(foldQuietRuns([]), []);
});
