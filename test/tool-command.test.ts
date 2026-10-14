import { carryOnText } from "../server/cut-off.ts";
import { commandForms } from "./helpers/command-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCommand, legacyToolTitle } from "../server/tool-command.ts";

const keep = (text: string) => text;

test("command detail preserves multiline text, but rejects empty or malformed input", () => {
  for (const value of [undefined, null, 1, {}, [], "", " \n\t"]) assert.equal(toolCommand(value, keep), undefined);
  const command = "printf 'hello'\nprintf 'world'";
  assert.equal(toolCommand(command, keep), command);
  assert.equal(toolCommand("ls", keep), "ls");
});

test("commands hide Authorization headers and standalone Bearer values", () => {
  for (const command of [
    "curl -H 'Authorization: Bearer fixture_token' https://example.invalid",
    'curl --header="AUTHORIZATION: Basic fixture_token" https://example.invalid',
    'curl -H Authorization:"Bearer fixture_token" https://example.invalid',
    "AUTHORIZATION='Custom fixture_token with spaces' curl https://example.invalid",
    'http --headers \'{"Authorization": "Bearer fixture_token"}\'',
    "curl -H Authorization:Bearer fixture_token https://example.invalid",
    "curl -H Authorization: Custom fixture_token https://example.invalid",
    "tool --token Bearer fixture_token",
    "tool --token bEaReR 'fixture_token with spaces'",
    'curl -H "Authorization: Digest username=\\"demo\\", response=\\"fixture_token\\"" https://example.invalid',
    'tool Bearer "fixture_token with \\"escaped quotes\\""',
    'tool Bearer "fixture_token with an unfinished quote',
    'curl -H "Authorization: Custom fixture_token with an unfinished quote',
    "curl -H 'Authorization: Basic fixture_token with an unfinished quote",
  ]) {
    for (const input of commandForms(command)) {
      const shown = toolCommand(input, keep)!;
      assert.ok(!shown.includes("fixture_token"), shown);
      assert.match(shown, /\[redacted\]/);
    }
  }
  const both = toolCommand("curl -H 'Authorization: Basic first_token' -H 'Other: Bearer second_token'", keep)!;
  assert.ok(!both.includes("first_token") && !both.includes("second_token"));
});

test("a URL keeps its scheme, user and host, but no password", () => {
  for (const [input, expected] of [
    ["curl https://demo:fixture_password@example.invalid/path", "curl https://demo:[redacted]@example.invalid/path"],
    ["curl https://demo:pw:more%40encoded@example.invalid", "curl https://demo:[redacted]@example.invalid"],
    ["curl https://:fixture_password@example.invalid ftp://demo:second_password@example.invalid", "curl https://:[redacted]@example.invalid ftp://demo:[redacted]@example.invalid"],
    ["curl https://example.invalid/path", "curl https://example.invalid/path"],
  ]) {
    commandForms(input).forEach((command, i) => assert.equal(toolCommand(command, keep), commandForms(expected)[i]));
  }
});

test("redaction sees a whole credential crossing the display cut", () => {
  const secret = "stored_fixture_credential";
  commandForms("printf " + secret).forEach((command, i) => assert.equal(toolCommand(command, (text) => text.replaceAll(secret, "[redacted]")), commandForms("printf [redacted]")[i]));
  const before = "x".repeat(2000 - 11) + secret + " trailing";
  const shown = toolCommand(before, (text) => text.replaceAll(secret, "[redacted]"))!;
  assert.ok(!shown.includes("stored_fix"), "clipping before redaction left part of a stored credential");
  assert.match(shown, /\[redacted\]/);
  assert.ok(shown.length <= 2000);
});

test("the display bound is UTF-16, includes its ellipsis and never splits an emoji", () => {
  assert.equal(toolCommand("a".repeat(2000), keep), "a".repeat(2000));
  const shown = toolCommand("a".repeat(1998) + "😀" + "more", keep)!;
  assert.equal(shown, "a".repeat(1998) + "…");
  assert.ok(shown.length <= 2000);
  assert.equal(toolCommand("😀".repeat(2000), keep)!.length, 1999);
});

test("every credential shape is fully hidden in direct and both Codex wrappers", () => {
  const cases = [
    ['curl -H "Authorization": "Basic fixture_split_value"', ["fixture_split_value"]],
    ['curl -H "X-Api-Key": "fixture_split_value"', ["fixture_split_value"]],
    ["curl -H 'Cookie': 'session=fixture_split_value'", ["fixture_split_value"]],
    ["curl -H 'Proxy-aUtHoRiZaTiOn: Digest username=\"fixture_user\", response=\"fixture_response\"' https://example.invalid", ["fixture_user", "fixture_response"]],
    ['curl -H "Authorization: Digest username=\\"fixture_user\\", response=\\"fixture_response\\"" https://example.invalid', ["fixture_user", "fixture_response"]],
    ["curl Authorization=Digest username=fixture_user,response=fixture_response", ["fixture_user", "fixture_response"]],
    ["curl prefixAuthorization: Digest username=fixture_user, response=fixture_response", ["fixture_user", "fixture_response"]],
    ['http \'{"Authorization": "Digest fixture_response", "other": "keep"}\'', ["fixture_response"]],
    ['http \'{"value": "Bearer fixture_bearer"}\'', ["fixture_bearer"]],
    ["VALUE='Bearer fixture_bearer' tool", ["fixture_bearer"]],
    ["curl https://demo:fixture_pw@tail@host.invalid/path", ["fixture_pw", "tail"]],
    ["db redis://:fixture_pw@host.invalid postgres://demo:fixture%40pw@host.invalid mongodb+srv://demo:fixture_pw@host.invalid", ["fixture_pw", "fixture%40pw"]],
    ["GITHUB_TOKEN=fixture_token export API_KEY='fixture key' PGPASSWORD=fixture_pw tool --password='fixture pass' --token fixture_flag", ["fixture_token", "fixture key", "fixture_pw", "fixture pass", "fixture_flag"]],
    ["tool --api-key fixture_key --auth-token=fixture_flag --private-key='fixture private'", ["fixture_key", "fixture_flag", "fixture private"]],
    ["curl -H 'X-Api-Key: fixture_key' -H 'X-Auth-Token: fixture_auth' -H 'PRIVATE-TOKEN=fixture_private' -H 'Cookie: session=fixture_cookie; other=fixture_other'", ["fixture_key", "fixture_auth", "fixture_private", "fixture_cookie", "fixture_other"]],
    ["cat <<'EOF'\nAuthorization: Digest username=fixture_user, response=fixture_response\nX-Api-Key: fixture_key\nEOF", ["fixture_user", "fixture_response", "fixture_key"]],
  ] as const;
  for (const [command, values] of cases) {
    for (const input of commandForms(command)) {
      const shown = toolCommand(input, keep)!;
      for (const value of values) assert.ok(!shown.includes(value), "credential survived: " + value + " in " + shown);
      assert.match(shown, /\[redacted\]/);
      if (input.startsWith("/bin/bash")) assert.match(shown, /^\/bin\/bash -lc /);
    }
  }
  const unchanged = "sort -u data.txt; curl -u demo:fixture_pass --user demo:fixture_pass https://fixture_token@host.invalid/?access_token=fixture_query";
  assert.equal(toolCommand(unchanged, keep), unchanged, "excluded credential forms changed");
});

test("all masks see the complete input before the 2000-unit cut", () => {
  for (const tail of ["API_KEY=fixture_credential", "--token fixture_credential", "https://demo:fixture_credential@tail@host.invalid", "'Authorization: Digest fixture_credential with spaces'", "'X-Api-Key: fixture_credential'"]) {
    const input = "x".repeat(1980) + " " + tail;
    for (const command of commandForms(input)) {
      const shown = toolCommand(command, keep)!;
      assert.ok(!shown.includes("fixture_"), shown);
      assert.ok(shown.length <= 2000);
    }
  }
});

test("large repeated unfinished headers have a bounded processing time", () => {
  const input = "Authorization: ".repeat(Math.ceil(1024 * 1024 / 15));
  const began = performance.now();
  const shown = toolCommand(input, keep)!;
  assert.ok(performance.now() - began < 5000, "one MiB redaction exceeded five seconds");
  assert.ok(shown.length <= 2000);
});

test("legacy title consumers retain the sanitized Codex command and Claude Bash", () => {
  const safe = toolCommand('/bin/bash -lc "API_KEY=fixture_key printf ready"', keep)!;
  const codex = legacyToolTitle({ provider: "codex", title: "shell", command: safe });
  assert.equal(codex, safe.slice(0, 80));
  assert.match(codex, /\[redacted\]/);
  assert.ok(carryOnText("restart", { tool: codex }).includes("The step running when it stopped was: " + codex));
  assert.ok(carryOnText("restart", { tool: legacyToolTitle({ provider: "claudeAgent", title: "Bash", command: safe }) }).includes("The step running when it stopped was: Bash"));
  assert.equal(legacyToolTitle({ provider: "claudeAgent", title: "Bash", command: safe }), "Bash");
  assert.equal(legacyToolTitle({ provider: "codex", title: "browser" }), "browser");
  assert.equal(legacyToolTitle({ provider: "codex" }), "tool");
});
