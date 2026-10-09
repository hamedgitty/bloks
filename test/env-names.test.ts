// A secret an agent asks for is set in every agent's environment, so it
// may not take a name the shell, Node or the engines read for themselves.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reservedEnvName, usableSecrets } from "../server/env-names.ts";

test("names that steer what runs, or where traffic goes, are refused", () => {
  for (const name of ["PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "GIT_SSH_COMMAND", "BLOKS_TOKEN", "PYTHONPATH", "JAVA_TOOL_OPTIONS", "PERL5OPT", "LESSOPEN", "DOCKER_HOST", "PIP_INDEX_URL"]) {
    assert.equal(reservedEnvName(name), true, name);
  }
});

test("a name for what a key is for is fine", () => {
  for (const name of ["TRANSISTOR_API_KEY", "STRIPE_SECRET_KEY", "OPENAI_API_KEY", "NOTION_TOKEN", "HOMEPAGE_URL", "PYTHONANYWHERE_TOKEN"]) {
    assert.equal(reservedEnvName(name), false, name);
  }
});

test("a secret saved under such a name before they were checked never reaches an agent", () => {
  assert.deepEqual(usableSecrets({ HTTPS_PROXY: "http://evil:8080", TRANSISTOR_API_KEY: "tk" }), { TRANSISTOR_API_KEY: "tk" });
  assert.deepEqual(usableSecrets(undefined), {});
});
