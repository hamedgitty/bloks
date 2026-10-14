import { toolLabel } from "../src/lib/tool-summary.ts";
import { previewLine } from "../src/lib/preview.ts";
import { preview } from "../src/lib/threads.ts";
// Tool calls: one line per run of them, and none left spinning.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { kindOf, running, summarize } from "../src/lib/tool-summary.ts";
import { startHarness } from "./helpers/server.ts";

describe("a run of tool calls, counted", () => {
  test("tools are sorted by what they did", () => {
    assert.equal(kindOf("Bash"), "command");
    assert.equal(kindOf("npm test -- --watch=false"), "command", "legacy command labels still count");
    assert.equal(kindOf("Read"), "read");
    assert.equal(kindOf("Grep"), "search");
    assert.equal(kindOf("web_search"), "search");
    assert.equal(kindOf("Edit"), "edit");
    assert.equal(kindOf("edit"), "edit");
    assert.equal(kindOf("Skill"), "other");
    assert.equal(kindOf("mcp__github__create_issue"), "other");
  });

  test("the line says what happened, and never how many failed", () => {
    const tools = [
      { name: "Bash", ok: true },
      { name: "Bash", ok: false },
      { name: "Read", ok: true },
      { name: "Read", ok: true },
      { name: "Grep", ok: true },
      { name: "Edit", ok: true },
      { name: "Skill", ok: true },
    ];
    assert.equal(summarize(tools), "Ran 2 commands, read 2 files, searched once, edited 1 file, used 1 other tool");
    assert.equal(summarize([{ name: "Skill" }, { name: "TodoWrite" }]), "Used 2 tools");
    assert.doesNotMatch(summarize(tools), /fail/i);
  });

  test("a call cut short is not running", () => {
    assert.equal(running([{ name: "Bash", ok: true }, { name: "Bash" }]), true);
    assert.equal(running([{ name: "Bash", ok: true }, { name: "Bash", stopped: true }]), false);
  });

  test("commands count by kind even when their command text names a search or read tool", () => {
    assert.equal(summarize([{ name: "Bash", command: "ls", ok: true }, { name: "shell", command: "cat", ok: false }]), "Ran 2 commands");
    assert.equal(summarize([{ name: "shell", command: "Read" }, { name: "Read" }, { name: "Grep" }, { name: "Edit" }]), "Ran 1 command, read 1 file, searched once, edited 1 file");
    assert.equal(summarize([{ name: "npm test" }, { name: "Bash" }]), "Ran 2 commands", "old no-field rows retain their counts");
  });
});

describe("a call nobody will hear back from", () => {
  test("is settled when the server starts, not left spinning", async () => {
    const home = mkdtempSync(join(tmpdir(), "bloks-tools-home-"));
    try {
      let h = await startHarness({ HOME: home, USERPROFILE: home });
      const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Runner" }) });
      await h.stop();

      // what a quit halfway through a command leaves on disk
      const file = join(home, ".bloks", `messages-${bot.threadId}.json`);
      const before = JSON.parse(readFileSync(file, "utf8"));
      before.push(
        { id: "t1", at: Date.now(), role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
        { id: "t2", at: Date.now(), role: "bot", kind: "activity", tool: { name: "Bash", command: "printf 'demo'" } },
      );
      writeFileSync(file, JSON.stringify(before));

      h = await startHarness({ HOME: home, USERPROFILE: home });
      try {
        const { bots } = await h.json("/api/bots");
        const messages = bots.find((b: any) => b.id === bot.id).messages;
        assert.deepEqual(messages.find((m: any) => m.id === "t1").tool, { name: "Bash", ok: true });
        assert.deepEqual(messages.find((m: any) => m.id === "t2").tool, { name: "Bash", command: "printf 'demo'", stopped: true });
      } finally {
        await h.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("keeping a suggested change to a skill", () => {
  test("shows the diff, and keeps the skill's name, description and everything else", async () => {
    const home = mkdtempSync(join(tmpdir(), "bloks-skill-home-"));
    const { mkdirSync } = await import("node:fs");
    try {
      mkdirSync(join(home, ".bloks", "skills"), { recursive: true });
      const body = "## Tone\nPlain and short.\n\n## Sections\nNew, Fixed, Known issues.\n\n## Reference\nSee docs/style.md.";
      writeFileSync(join(home, ".bloks", "skills", "release-notes.md"), `---\nname: Release notes\ndescription: Writing release notes\n---\n\n${body}\n`);
      writeFileSync(
        join(home, ".bloks", "proposals.json"),
        JSON.stringify([
          {
            id: "p1", kind: "patch", skillId: "release-notes", name: "Release notes", description: "Writing release notes",
            body: "(stale copy)", because: "You asked for issue links.", at: 1, fingerprint: "f", botId: "b", botName: "Scout", threadId: "t",
            edits: [{ find: "New, Fixed, Known issues.", replace: "New, Fixed, Known issues. Link each fix to its issue." }],
          },
        ]),
      );
      const h = await startHarness({ HOME: home, USERPROFILE: home });
      try {
        const { proposals } = await h.json("/api/skills/proposals");
        const p = proposals.find((x: any) => x.id === "p1");
        assert.ok(p.diff.some((l: any) => l.kind === "del" && l.text === "New, Fixed, Known issues."));
        assert.ok(p.diff.some((l: any) => l.kind === "add" && /Link each fix/.test(l.text)));
        assert.ok(!p.stale);

        const kept = await h.json("/api/skills/proposals/p1", { method: "POST", body: "{}" });
        assert.equal(kept.skill.name, "Release notes");
        assert.equal(kept.skill.description, "Writing release notes");
        assert.match(kept.skill.body, /## Tone\nPlain and short\./);
        assert.match(kept.skill.body, /Link each fix to its issue\./);
        assert.match(kept.skill.body, /## Reference\nSee docs\/style\.md\./);
      } finally {
        await h.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("all command labels use the first nonblank line and preserve stable counts", () => {
  for (const tool of [
    { name: "shell", command: "\n  \n/bin/bash -lc 'printf ready'\nprintf later" },
    { name: "Bash", command: "\nprintf ready\nprintf later" },
    { name: "old command", command: undefined },
  ]) {
    const expected = tool.command?.includes("/bin/bash") ? "/bin/bash -lc 'printf ready'" : tool.command ? "printf ready" : tool.name;
    assert.equal(toolLabel(tool), expected);
    const row = { id: "tool", role: "bot", kind: "activity", at: 0, tool } as const;
    assert.equal(previewLine(row), expected);
    assert.equal(preview(row), expected);
  }
  assert.equal(toolLabel({ name: "Bash", command: " \n\t" }), "Bash");
  assert.equal(summarize([{ name: "shell", command: "ls" }, { name: "Bash", command: "read" }]), "Ran 2 commands");
});
