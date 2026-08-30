// URL folding for a pasted OpenAI-compatible host, and how several keys
// on that host become one live instance.
import { test } from "node:test";
import assert from "node:assert/strict";

import { activeCustomKey, customInstanceId, instanceConfigs, type AppConfig } from "../server/config.ts";
import { CUSTOM_SPEC, normalizeCompatUrl } from "../server/providers.ts";

test("a trailing slash and a completions path fold to the same root", () => {
  assert.equal(normalizeCompatUrl("https://api.example.test/v1/"), "https://api.example.test/v1");
  assert.equal(
    normalizeCompatUrl("https://api.example.test/v1/chat/completions"),
    "https://api.example.test/v1",
  );
  assert.equal(
    normalizeCompatUrl("https://api.example.test/v1/completions"),
    "https://api.example.test/v1",
  );
});

test("only http(s) URLs without embedded credentials are kept", () => {
  assert.equal(normalizeCompatUrl("not-a-url"), undefined);
  assert.equal(normalizeCompatUrl("ftp://api.example.test/v1"), undefined);
  assert.equal(normalizeCompatUrl("https://user:secret@api.example.test/v1"), undefined);
  assert.equal(normalizeCompatUrl(""), undefined);
});

test("the active key is the named one, or the first that still has a value", () => {
  const keys = [
    { id: "a", key: "one" },
    { id: "b", label: "backup", key: "two" },
  ];
  assert.equal(activeCustomKey({ id: "e", name: "E", url: "https://x", keys, activeKeyId: "b" })?.id, "b");
  assert.equal(activeCustomKey({ id: "e", name: "E", url: "https://x", keys })?.id, "a");
  assert.equal(
    activeCustomKey({
      id: "e",
      name: "E",
      url: "https://x",
      keys: [{ id: "a", key: "" }, { id: "b", key: "two" }],
    })?.id,
    "b",
  );
});

test("a custom host becomes one instance that carries the active key", () => {
  const cfg: AppConfig = {
    custom: [
      {
        id: "host1",
        name: "Together",
        url: "https://api.together.xyz/v1",
        keys: [
          { id: "k1", label: "work", key: "sk-work" },
          { id: "k2", label: "home", key: "sk-home" },
        ],
        activeKeyId: "k2",
      },
    ],
  };
  const map = instanceConfigs(cfg);
  const instance = map[customInstanceId("host1")];
  assert.ok(instance);
  assert.equal(instance.driver, CUSTOM_SPEC.kind);
  assert.equal(instance.displayName, "Together");
  assert.deepEqual(instance.config, { url: "https://api.together.xyz/v1" });
  assert.equal(instance.environment?.[`${CUSTOM_SPEC.kind.toUpperCase()}_API_KEY`], "sk-home");
  assert.ok(
    !Object.values(map).some((entry) => entry.environment?.[`${CUSTOM_SPEC.kind.toUpperCase()}_API_KEY`] === "sk-work"),
    "the unused key must not be injected into any instance",
  );
});
