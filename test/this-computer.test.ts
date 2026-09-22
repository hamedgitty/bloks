// The word for the machine, which is not always "Mac".
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deviceWord, thisComputer, yourComputer } from "../src/lib/thisComputer.ts";

describe("deviceWord", () => {
  test("a Mac is a Mac", () => {
    assert.equal(deviceWord("MacIntel"), "Mac");
    assert.equal(thisComputer("MacIntel"), "this Mac");
    assert.equal(yourComputer("MacIntel"), "your Mac");
  });

  test("Windows is a PC, which is what the issue was about", () => {
    assert.equal(deviceWord("Win32"), "PC");
    assert.equal(thisComputer("Win32"), "this PC");
    assert.equal(yourComputer("Win32"), "your PC");
  });

  test("Linux gets the neutral word rather than a wrong one", () => {
    assert.equal(deviceWord("Linux x86_64"), "computer");
    assert.equal(thisComputer("X11; Ubuntu"), "this computer");
  });

  test("an unknown platform is never guessed as a Mac", () => {
    assert.equal(deviceWord("Something else entirely"), "computer");
    assert.equal(deviceWord(""), "computer");
  });
});
