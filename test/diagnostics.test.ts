// Nothing secret leaves in a bug report.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { diagnosticsReport, scrubSecrets } from "../server/diagnostics.ts";

describe("scrubSecrets", () => {
  test("credential-shaped tokens are masked wherever they sit", () => {
    for (const token of [
      "sk-abcdefghijklmnop1234",
      "xai-ABCDEFGHIJKLMNOP",
      "ck_1234567890abc",
      "ak_1234567890abc",
      "ghp_abcdefghijklmnopqrst",
      "github_pat_abcdefghijklmnopqrst",
      "xoxb-1234567890-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "npm_abcdefghijklmnopqrst",
    ]) {
      const out = scrubSecrets(`engine said: ${token} rejected`);
      assert.ok(!out.includes(token), `${token} survived`);
    }
  });

  test("keyed values are masked whatever the key looks like", () => {
    const out = scrubSecrets('api_key=hunter2 password: "letmein" token=\'abc\'');
    assert.ok(!out.includes("hunter2"));
    assert.ok(!out.includes("letmein"));
    assert.ok(!out.includes("'abc'"));
  });

  test("bearer headers are masked", () => {
    const out = scrubSecrets("authorization: Bearer eyJhbGciOiJIUzI1NiJ9");
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
  });

  test("ordinary text passes through untouched", () => {
    const line = "the composer sent 3 messages and the engine answered";
    assert.equal(scrubSecrets(line), line);
  });
});

describe("diagnosticsReport", () => {
  const facts = {
    version: "1.0.1",
    platform: "darwin",
    arch: "arm64",
    node: "v22.1.0",
    uptimeSeconds: 61.4,
    config: { composioConnect: true, box: false },
    engines: [
      { name: "Claude Code", connected: true, agentic: true },
      { name: "Grok", connected: false, agentic: false },
    ],
    counts: { agents: 4, rooms: 1, skills: 7 },
  };

  test("reads as an issue body with the facts in it", () => {
    const report = diagnosticsReport(facts);
    assert.ok(report.startsWith("## Bloks diagnostics"));
    assert.match(report, /Version: 1\.0\.1/);
    assert.match(report, /Claude Code: connected/);
    assert.match(report, /Grok: not connected \(chat only\)/);
    assert.match(report, /Agents: 4, rooms: 1, skills: 7/);
    assert.match(report, /"composioConnect": true/);
  });

  test("even a poisoned fact cannot carry a credential out", () => {
    const poisoned = { ...facts, version: "1.0.1 sk-abcdefghijklmnop1234" };
    assert.ok(!diagnosticsReport(poisoned).includes("sk-abcdefghijklmnop1234"));
  });
});
