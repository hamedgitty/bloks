// Room @mention runs shared by the composer and every transcript bubble
// (src/lib/roomMentions.ts). Keeps composer marks, sent user bubbles,
// bot replies, and server routing agreeing on which spans are mentions.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addressees } from "../server/bloks.ts";
import { namedIn } from "../src/components/room/reach.ts";
import { mentionRuns } from "../src/lib/roomMentions.ts";

describe("mentionRuns", () => {
  test("picks out single and multiple @mentions while keeping surrounding text", () => {
    assert.deepEqual(mentionRuns("Hello @Super Nova and @Nova", ["Super Nova", "Nova"]), [
      { text: "Hello ", mention: false },
      { text: "@Super Nova", mention: true },
      { text: " and ", mention: false },
      { text: "@Nova", mention: true },
    ]);
  });

  test("matches longest name first regardless of list order", () => {
    const expected = [
      { text: "Ask ", mention: false },
      { text: "@Nova Pro", mention: true },
      { text: " and ", mention: false },
      { text: "@Nova", mention: true },
      { text: " please", mention: false },
    ];
    assert.deepEqual(mentionRuns("Ask @Nova Pro and @Nova please", ["Nova", "Nova Pro"]), expected);
    assert.deepEqual(mentionRuns("Ask @Nova Pro and @Nova please", ["Nova Pro", "Nova"]), expected);

    assert.deepEqual(mentionRuns("Hey @Bobby Tables", ["Bo", "Bobby Tables"]), [
      { text: "Hey ", mention: false },
      { text: "@Bobby Tables", mention: true },
    ]);
  });

  test("matches case-insensitively and preserves the typed casing", () => {
    assert.deepEqual(mentionRuns("ping @super nova and @NOVA!", ["Super Nova", "Nova"]), [
      { text: "ping ", mention: false },
      { text: "@super nova", mention: true },
      { text: " and ", mention: false },
      { text: "@NOVA", mention: true },
      { text: "!", mention: false },
    ]);
  });

  test("marks repeated mentions of the same participant", () => {
    assert.deepEqual(mentionRuns("@Nova ask @Nova again", ["Nova"]), [
      { text: "@Nova", mention: true },
      { text: " ask ", mention: false },
      { text: "@Nova", mention: true },
      { text: " again", mention: false },
    ]);
  });

  test("handles regex metacharacters and emoji names literally", () => {
    assert.deepEqual(mentionRuns("Try @C++ and @Bot (v2) and @🚀 Nova", ["C++", "Bot (v2)", "🚀 Nova"]), [
      { text: "Try ", mention: false },
      { text: "@C++", mention: true },
      { text: " and ", mention: false },
      { text: "@Bot (v2)", mention: true },
      { text: " and ", mention: false },
      { text: "@🚀 Nova", mention: true },
    ]);
  });

  test("returns plain text or empty list when nothing matches", () => {
    assert.deepEqual(mentionRuns("", ["Nova"]), []);
    assert.deepEqual(mentionRuns("Hello @Someone", []), [{ text: "Hello @Someone", mention: false }]);
    assert.deepEqual(mentionRuns("Hello @Someone", ["", "Nova", "Nova"]), [
      { text: "Hello @Someone", mention: false },
    ]);
  });

  test("agrees with server addressees and composer reach on overlapping names", () => {
    const members = [
      { id: "bo", name: "Bo" },
      { id: "bobby", name: "Bobby Tables" },
      { id: "nova", name: "Nova" },
      { id: "super", name: "Super Nova" },
    ];
    const message = "Hand this to @Bobby Tables and @Super Nova, not @Ghost.";
    const runs = mentionRuns(message, members.map((m) => m.name));
    assert.equal(runs.map((r) => r.text).join(""), message);
    assert.deepEqual(
      runs.filter((r) => r.mention).map((r) => r.text),
      ["@Bobby Tables", "@Super Nova"],
    );
    assert.deepEqual(namedIn(message, members), ["bobby", "super"]);
    assert.deepEqual(addressees(message, members), { ids: ["bobby", "super"], mentioned: true });
  });
});
