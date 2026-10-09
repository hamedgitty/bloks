// A secret an agent asks for is set in every agent's environment, so it
// may not take a name the shell, Node or the engines read for themselves.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reservedEnvName } from "../server/env-names.ts";

test("names that steer what runs, or where traffic goes, are refused", () => {
  for (const name of ["PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "GIT_SSH_COMMAND", "BLOKS_TOKEN", "PYTHONPATH"]) {
    assert.equal(reservedEnvName(name), true, name);
  }
});

test("a name for what a key is for is fine", () => {
  for (const name of ["TRANSISTOR_API_KEY", "STRIPE_SECRET_KEY", "OPENAI_API_KEY", "NOTION_TOKEN", "HOMEPAGE_URL"]) {
    assert.equal(reservedEnvName(name), false, name);
  }
});
