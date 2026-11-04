// How fast agents' voices play on this device (src/lib/speechSpeed.ts):
// the five speeds, the chip's order, what a stored value may become, and
// the media element fields a speed is written to.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySpeechSpeed,
  createSpeechSpeed,
  nextSpeechSpeed,
  SPEECH_SPEED_KEY,
  SPEECH_SPEEDS,
  speechSpeed,
} from "../src/lib/speechSpeed.ts";

test("the offered speeds, slowest first, with 1x the default", () => {
  assert.deepEqual([...SPEECH_SPEEDS], [0.75, 1, 1.25, 1.5, 2]);
  assert.equal(speechSpeed(undefined), 1);
  assert.equal(speechSpeed(null), 1);
});

test("a stored value is a speed on the list or it is 1x", () => {
  for (const [value, speed] of [["0.75", 0.75], ["1", 1], ["1.25", 1.25], ["1.5", 1.5], ["2", 2], [1.5, 1.5], [" 2 ", 2]] as const) {
    assert.equal(speechSpeed(value), speed);
  }
  for (const value of ["", " ", "fast", "1.3", "3", "0", "-1", "Infinity", "NaN", "2x", "constructor", "__proto__", 16, 0.5, Number.NaN, [], {}, true]) {
    assert.equal(speechSpeed(value), 1, `${String(value)} is not a speed`);
  }
});

test("the chip steps up from normal, then to the slower speed, then back", () => {
  const seen = [1];
  for (let i = 0; i < 5; i++) seen.push(nextSpeechSpeed(seen.at(-1)));
  assert.deepEqual(seen, [1, 1.25, 1.5, 2, 0.75, 1]);
  // a value that is no speed steps as 1x would
  assert.equal(nextSpeechSpeed("garbage"), 1.25);
});

test("a speed is written to the rate, the default rate and the pitch", () => {
  const audio = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false };
  applySpeechSpeed(audio, 1.5);
  assert.deepEqual(audio, { playbackRate: 1.5, defaultPlaybackRate: 1.5, preservesPitch: true });
  applySpeechSpeed(audio, 0.75);
  assert.deepEqual(audio, { playbackRate: 0.75, defaultPlaybackRate: 0.75, preservesPitch: true });
});

test("the choice is kept under its own key and read back", () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) };
  const choice = createSpeechSpeed(storage);
  assert.equal(choice.get(), 1);
  choice.set(1.25);
  assert.deepEqual([...stored], [[SPEECH_SPEED_KEY, "1.25"]]);
  assert.equal(createSpeechSpeed(storage).get(), 1.25);
  // another window changed it
  stored.set(SPEECH_SPEED_KEY, "2");
  choice.sync();
  assert.equal(choice.get(), 2);
  // anything else sent in is 1x, and kept as 1x
  choice.set("7");
  assert.equal(stored.get(SPEECH_SPEED_KEY), "1");
});

test("a store that cannot be read gives 1x, and one that cannot be written keeps the choice for the window", () => {
  const unreadable = createSpeechSpeed({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  assert.equal(unreadable.get(), 1);
  unreadable.set(1.5);
  assert.equal(unreadable.get(), 1.5);
  // a sync must not read the failed write back as 1x
  unreadable.sync();
  assert.equal(unreadable.get(), 1.5);
});
