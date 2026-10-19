import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeInputs, CLAUDE_COMPLETION_WAIT_MS as WAIT } from "../server/drivers/claude-inputs.ts";

function clock() {
  let now = 0;
  return { inputs: new ClaudeInputs(() => now), advance: (ms: number) => { now += ms; } };
}
let sequence = 0;
function result(id: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return { type: "result", uuid: `result-${++sequence}`, user_message_uuid: id,
    subtype: "success", is_error: false, result: "", num_turns: 0, duration_api_ms: 0, ...extra };
}
function requesting(id: string, extra: Record<string, unknown> = {}) {
  return { type: "system", subtype: "status", status: "requesting", uuid: `request-${++sequence}`,
    user_message_uuids: [id], ...extra };
}
function terminal(id: string, state = "completed") {
  return { type: "command_lifecycle", command_uuid: id, state };
}
const emptyPoll = { expired: [], answeredFallback: [] };

test("resumed housekeeping, observed request and retries preserve silent model work beyond fifteen minutes", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.result(result("A"));
  advance(WAIT - 1);
  inputs.requesting(requesting("A"));
  advance(WAIT * 3);
  assert.equal(inputs.nextWaitMs, null);
  assert.deepEqual(inputs.poll(), emptyPoll);
  inputs.requesting(requesting("A")); // a new model round/retry stays active
  inputs.result(result("A", { result: "Done", num_turns: 2, duration_api_ms: 17 }));
  inputs.terminal(terminal("A"));
  assert.equal(inputs.ready, true);
  assert.equal(inputs.selectedResult?.result, "Done");
});

test("zero-only missing completion and silent pre-request preparation expire independently of tool stall", () => {
  for (const zero of [true, false]) {
    const { inputs, advance } = clock();
    inputs.register("A");
    if (zero) inputs.result(result("A"));
    advance(WAIT);
    assert.deepEqual(inputs.poll(), { expired: ["A"], answeredFallback: [] });
    assert.deepEqual(inputs.poll(), emptyPoll);
    assert.equal(inputs.ready, false);
  }
});

test("A's answered metadata fallback cannot stop B's silent active request", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.requesting(requesting("A"));
  inputs.result(result("A", { result: "A answered", total_cost_usd: 1 }));
  inputs.register("B");
  inputs.requesting(requesting("B"));
  advance(WAIT * 2);
  assert.deepEqual(inputs.poll(), { expired: [], answeredFallback: ["A"] });
  assert.equal(inputs.ready, false);
  assert.equal(inputs.pendingCount, 1);
  advance(WAIT * 2);
  assert.deepEqual(inputs.poll(), emptyPoll);
  inputs.result(result("B", { result: "B answered", total_cost_usd: 2 }));
  inputs.terminal(terminal("B"));
  assert.equal(inputs.ready, true);
  assert.equal(inputs.selectedResult?.result, "B answered");
  assert.equal(inputs.selectedResult?.total_cost_usd, 2);
});

test("an unanswered B expires while A's own answer and original outcome survive", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.result(result("A", { result: "Already delivered" }));
  inputs.terminal(terminal("A"));
  inputs.register("B");
  advance(WAIT);
  assert.deepEqual(inputs.poll(), { expired: ["B"], answeredFallback: [] });
  assert.equal(inputs.selectedResult?.result, "Already delivered");
  assert.equal(inputs.ready, false);
});

test("duplicates, foreign IDs, frame UUIDs, child output and new input do not renew A", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  const zero = result("A");
  inputs.result(zero);
  advance(WAIT - 1);
  inputs.register("A");
  inputs.register("B");
  assert.equal(inputs.result(zero), false);
  inputs.result(result("A"));
  inputs.result(result("foreign", { uuid: "A", result: "foreign answer" }));
  inputs.requesting(requesting("A", { parent_tool_use_id: "child" }));
  inputs.terminal({ ...terminal("A"), parent_tool_use_id: "child" });
  inputs.terminal(terminal("foreign"));
  inputs.requesting(requesting("foreign"));
  advance(1);
  assert.deepEqual(inputs.poll(), { expired: ["A"], answeredFallback: [] });
  assert.equal(inputs.pendingCount, 1);
});

test("an ask pauses only the remaining budget, and repeated asks do not replenish it", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  advance(WAIT - 7);
  inputs.setAsking(true);
  advance(WAIT * 2);
  inputs.setAsking(true);
  assert.equal(inputs.nextWaitMs, null);
  assert.deepEqual(inputs.poll(), emptyPoll);
  inputs.setAsking(false);
  assert.equal(inputs.nextWaitMs, 7);
  advance(7);
  assert.deepEqual(inputs.poll(), { expired: ["A"], answeredFallback: [] });
});

test("request result starts metadata wait once; duplicates cannot refresh or reopen it", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  const start = requesting("A");
  inputs.requesting(start);
  advance(WAIT * 2);
  const answer = result("A", { result: "answer" });
  inputs.result(answer);
  advance(WAIT - 1);
  inputs.requesting(start);
  inputs.result(answer);
  inputs.result(result("A", { result: "answer" }));
  assert.equal(inputs.nextWaitMs, 1);
  advance(1);
  assert.deepEqual(inputs.poll(), { expired: [], answeredFallback: ["A"] });
});

test("a genuine next request can suspend the metadata wait for its next result", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.requesting(requesting("A"));
  inputs.result(result("A", { result: "first result" }));
  advance(WAIT - 1);
  inputs.requesting(requesting("A"));
  advance(WAIT * 2);
  assert.deepEqual(inputs.poll(), emptyPoll);
  inputs.result(result("A", { result: "second result" }));
  assert.equal(inputs.nextWaitMs, WAIT);
});

test("legitimate empty completed input succeeds, including completion/result order", () => {
  for (const completionFirst of [false, true]) {
    const { inputs, advance } = clock();
    inputs.register("A");
    if (completionFirst) inputs.terminal(terminal("A"));
    assert.equal(inputs.ready, false);
    inputs.result(result("A"));
    if (!completionFirst) inputs.terminal(terminal("A"));
    advance(WAIT * 2);
    assert.deepEqual(inputs.poll(), emptyPoll);
    assert.equal(inputs.ready, true);
    assert.equal(inputs.selectedResult?.result, "");
  }
});

test("terminal alone does not manufacture success or leave missing result unbounded", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.requesting(requesting("A"));
  inputs.terminal(terminal("A"));
  assert.equal(inputs.ready, false);
  advance(WAIT);
  assert.deepEqual(inputs.poll(), { expired: ["A"], answeredFallback: [] });
});

test("provider errors preserve their outcome on metadata fallback, and failures stay distinct", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  const error = result("A", { is_error: true, subtype: "error_during_execution", errors: ["provider failed"] });
  inputs.result(error);
  inputs.result(result("A"));
  advance(WAIT);
  assert.deepEqual(inputs.poll(), { expired: [], answeredFallback: ["A"] });
  assert.equal(inputs.selectedResult?.is_error, true);
  assert.deepEqual(inputs.selectedResult?.errors, ["provider failed"]);
  for (const state of ["failed", "cancelled", "discarded", "refused"]) {
    const ledger = clock().inputs;
    ledger.register("B");
    ledger.terminal(terminal("B", state));
    assert.match(ledger.failedTerminal!, new RegExp(state));
    assert.equal(ledger.ready, false);
  }
});

test("deadline races select once, results are snapshots, and failed writes leave no phantom input", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  inputs.register("failed-write");
  inputs.forget("failed-write");
  assert.equal(inputs.pendingCount, 1);
  advance(WAIT);
  const frame = result("A", { result: "answer", usage: { output_tokens: 4 } });
  inputs.result(frame);
  inputs.terminal(terminal("A"));
  frame.usage.output_tokens = 100;
  assert.deepEqual(inputs.poll(), emptyPoll);
  assert.equal(inputs.ready, true);
  assert.equal(inputs.selectedResult?.usage.output_tokens, 4);
  const copy = inputs.selectedResult!;
  copy.usage.output_tokens = 101;
  assert.equal(inputs.selectedResult?.usage.output_tokens, 4);
  assert.equal(inputs.terminal(terminal("A")), false);
  const other = clock();
  other.inputs.register("B");
  other.advance(WAIT);
  other.inputs.poll();
  assert.equal(other.inputs.result(result("B", { result: "too late" })), false);
});

test("an answer without a model request keeps its original preparation budget", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  advance(WAIT - 3);
  inputs.result(result("A", { result: "Local command output", local_command: "cost" }));
  assert.equal(inputs.nextWaitMs, 3);
  advance(3);
  assert.deepEqual(inputs.poll(), { expired: [], answeredFallback: ["A"] });
  assert.equal(inputs.ready, true);
});

test("child results and partial requesting shapes cannot supply an answer or active-work signal", () => {
  const { inputs, advance } = clock();
  inputs.register("A");
  assert.equal(inputs.result(result("A", { parent_tool_use_id: "child", result: "Child answer" })), false);
  assert.equal(inputs.requesting({ ...requesting("A"), type: "stream_event" }), false);
  assert.equal(inputs.result({ type: "assistant", user_message_uuid: "A", result: "Earlier prose" }), false);
  advance(WAIT);
  assert.deepEqual(inputs.poll(), { expired: ["A"], answeredFallback: [] });
  assert.equal(inputs.selectedResult, null);
});

test("a failed lifecycle retains an own provider error and never rewrites the result as success", () => {
  const { inputs } = clock();
  inputs.register("A");
  inputs.result(result("A", { result: "Partial answer", is_error: true, errors: ["request refused"] }));
  inputs.terminal(terminal("A", "refused"));
  assert.match(inputs.failedTerminal!, /refused/);
  assert.equal(inputs.ready, false);
  assert.equal(inputs.selectedResult?.is_error, true);
  assert.deepEqual(inputs.selectedResult?.errors, ["request refused"]);
});
