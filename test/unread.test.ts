// The one number on the Dock icon.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { unreadCount } from "../src/lib/unread.ts";

describe("unreadCount", () => {
  test("counts unread agents and nothing else", () => {
    assert.equal(
      unreadCount([
        { unread: true },
        { unread: true },
        { unread: false },
        {},
      ]),
      2,
    );
  });

  test("archived agents cannot have news", () => {
    assert.equal(unreadCount([{ unread: true, archivedAt: 1724500000000 }, { unread: true }]), 1);
  });

  test("an empty roster is zero", () => {
    assert.equal(unreadCount([]), 0);
  });
});
