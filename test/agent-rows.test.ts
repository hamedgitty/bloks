// The sidebar's agent rows: two lines with a face, one with a small face,
// or one with none (GitHub 508). The shape is the only thing compact
// rows change, so these pin which shape each pair of choices gives, and
// what a bare row still says once its face is gone.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENT_ROW_HEIGHT,
  COMPACT_ROWS_KEY,
  agentRowShape,
  bareTrailing,
  readCompactRows,
  writeCompactRows,
} from "../src/lib/agentRows.ts";

describe("agent row shape", () => {
  test("the list stays as it was until compact rows are switched on", () => {
    assert.equal(agentRowShape({ compact: false, conversations: false }), "full");
    assert.equal(agentRowShape({ compact: false, conversations: true }), "line");
  });

  test("compact rows take the face away in both list views", () => {
    // nested conversations are the other switch's, not a price of a
    // shorter row: compact is bare with them shown or hidden
    assert.equal(agentRowShape({ compact: true, conversations: false }), "bare");
    assert.equal(agentRowShape({ compact: true, conversations: true }), "bare");
  });

  test("a bare row is the shortest, and still a comfortable target", () => {
    assert.ok(AGENT_ROW_HEIGHT.bare < AGENT_ROW_HEIGHT.line);
    assert.ok(AGENT_ROW_HEIGHT.line < AGENT_ROW_HEIGHT.full);
    assert.ok(AGENT_ROW_HEIGHT.bare >= 32);
  });
});

describe("what a bare row says after the name", () => {
  test("a spinner only while the agent works", () => {
    assert.equal(bareTrailing({ state: "working" }), "working");
    assert.notEqual(bareTrailing({ state: "idle" }), "working");
  });

  test("waiting outranks unread, and unread outranks the time", () => {
    // the face used to carry none of this, so dropping it loses nothing;
    // the marks that said it stay
    assert.equal(bareTrailing({ state: "needs-you", unread: true }), "waiting");
    assert.equal(bareTrailing({ state: "idle", unread: true }), "unread");
    assert.equal(bareTrailing({ state: "idle" }), "time");
  });

  test("an agent with no conversation yet says nothing", () => {
    assert.equal(bareTrailing(undefined), null);
  });
});

describe("the choice, kept on this device", () => {
  const memory = (refuse = false) => {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (refuse) throw new Error("quota");
        kept.set(key, value);
      },
    };
  };

  test("off by default, and on once switched on", () => {
    const storage = memory();
    assert.equal(readCompactRows(storage), false);
    writeCompactRows(storage, true);
    assert.equal(storage.kept.get(COMPACT_ROWS_KEY), "on");
    assert.equal(readCompactRows(storage), true);
    writeCompactRows(storage, false);
    assert.equal(readCompactRows(storage), false);
  });

  test("a store that refuses the write, or is missing, is no error", () => {
    assert.doesNotThrow(() => writeCompactRows(memory(true), true));
    assert.equal(readCompactRows(undefined), false);
  });
});
