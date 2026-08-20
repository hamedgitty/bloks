// Answers that are not paragraphs, and what stops one breaking a chat.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  KINDS,
  MAX_BARS,
  MAX_COLUMNS,
  MAX_ROWS,
  galleryPrompt,
  mayRender,
  parseComponent,
} from "../server/components.ts";

const ok = <T extends { ok: boolean }>(parsed: T) => {
  assert.equal(parsed.ok, true, "ok" in parsed && !parsed.ok ? (parsed as never as { error: string }).error : "");
  return parsed as Extract<T, { ok: true }>;
};

describe("the gallery is closed", () => {
  test("a kind nobody shipped is refused, and the refusal lists the ones there are", () => {
    // the caller is a model: "invalid" sends it round to make the same
    // mistake, and naming the options does not
    const parsed = parseComponent("dashboard", {});
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.error.includes("chart"));
  });

  test("six shapes, and they are the ones the catalog describes", () => {
    assert.equal(KINDS.length, 6);
  });
});

describe("a chart", () => {
  test("bars with labels and numbers", () => {
    const parsed = ok(parseComponent("chart", { title: "Q4", bars: [{ label: "North", value: 12 }] }));
    assert.equal(parsed.component.kind, "chart");
    assert.deepEqual(parsed.component.kind === "chart" && parsed.component.bars, [{ label: "North", value: 12 }]);
  });

  test("a bar with no number is dropped rather than drawn as nothing", () => {
    const parsed = ok(
      parseComponent("chart", {
        bars: [{ label: "Good", value: 3 }, { label: "Bad", value: "lots" }, { label: "", value: 9 }],
      }),
    );
    assert.equal(parsed.component.kind === "chart" && parsed.component.bars.length, 1);
  });

  test("negative and zero are real numbers and stay", () => {
    const parsed = ok(parseComponent("chart", { bars: [{ label: "Down", value: -4 }, { label: "Flat", value: 0 }] }));
    assert.equal(parsed.component.kind === "chart" && parsed.component.bars.length, 2);
  });

  test("no usable bars at all is refused, and says what it needs", () => {
    const parsed = parseComponent("chart", { title: "Empty" });
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && /label and a number/.test(parsed.error));
  });

  test("more bars than anybody can read are cut", () => {
    const many = Array.from({ length: MAX_BARS + 20 }, (_, i) => ({ label: `b${i}`, value: i }));
    const parsed = ok(parseComponent("chart", { bars: many }));
    assert.equal(parsed.component.kind === "chart" && parsed.component.bars.length, MAX_BARS);
  });

  test("infinity is not a number a bar can be", () => {
    const parsed = parseComponent("chart", { bars: [{ label: "Huge", value: Infinity }] });
    assert.equal(parsed.ok, false);
  });
});

describe("a table", () => {
  test("columns and rows", () => {
    const parsed = ok(
      parseComponent("table", { columns: ["Region", "Margin"], rows: [["North", "42%"], ["South", "18%"]] }),
    );
    assert.equal(parsed.component.kind === "table" && parsed.component.rows.length, 2);
  });

  test("a short row is padded rather than refused", () => {
    // a missing cell is a gap in the answer, not a reason to send the
    // whole thing back
    const parsed = ok(parseComponent("table", { columns: ["A", "B", "C"], rows: [["one"]] }));
    assert.deepEqual(parsed.component.kind === "table" && parsed.component.rows[0], ["one", "", ""]);
  });

  test("a long row is cut to the columns it has", () => {
    const parsed = ok(parseComponent("table", { columns: ["A"], rows: [["one", "two", "three"]] }));
    assert.deepEqual(parsed.component.kind === "table" && parsed.component.rows[0], ["one"]);
  });

  test("no columns, or no rows, is refused with what is missing", () => {
    assert.ok(!parseComponent("table", { rows: [["x"]] }).ok);
    const noRows = parseComponent("table", { columns: ["A"] });
    assert.ok(!noRows.ok && /rows/.test(noRows.error));
  });

  test("more than fits is cut both ways", () => {
    const parsed = ok(
      parseComponent("table", {
        columns: Array.from({ length: MAX_COLUMNS + 5 }, (_, i) => `c${i}`),
        rows: Array.from({ length: MAX_ROWS + 20 }, () => ["x"]),
      }),
    );
    assert.equal(parsed.component.kind === "table" && parsed.component.columns.length, MAX_COLUMNS);
    assert.equal(parsed.component.kind === "table" && parsed.component.rows.length, MAX_ROWS);
  });

  test("a cell that is not text becomes nothing rather than [object Object]", () => {
    const parsed = ok(parseComponent("table", { columns: ["A"], rows: [[{ nested: true }]] }));
    assert.deepEqual(parsed.component.kind === "table" && parsed.component.rows[0], [""]);
  });
});

describe("a decision", () => {
  test("a question and its options", () => {
    const parsed = ok(
      parseComponent("decision", {
        question: "Which host?",
        because: "cheapest that meets the need",
        options: [{ label: "A", detail: "cheap" }, { label: "B", pick: true }],
      }),
    );
    assert.equal(parsed.component.kind === "decision" && parsed.component.options[1].pick, true);
  });

  test("one recommendation at most", () => {
    // two picks is not a recommendation, it is the question again
    const parsed = ok(
      parseComponent("decision", {
        question: "Which?",
        options: [{ label: "A", pick: true }, { label: "B", pick: true }, { label: "C", pick: true }],
      }),
    );
    const picks = parsed.component.kind === "decision" ? parsed.component.options.filter((o) => o.pick) : [];
    assert.equal(picks.length, 1);
    assert.equal(picks[0].label, "A");
  });

  test("recommending nothing is allowed", () => {
    const parsed = ok(parseComponent("decision", { question: "Which?", options: [{ label: "A" }, { label: "B" }] }));
    assert.equal(parsed.component.kind === "decision" && parsed.component.options.some((o) => o.pick), false);
  });

  test("one option is not a decision", () => {
    const parsed = parseComponent("decision", { question: "Which?", options: [{ label: "Only" }] });
    assert.ok(!parsed.ok && /at least two/.test(parsed.error));
  });

  test("no question is not a decision", () => {
    assert.ok(!parseComponent("decision", { options: [{ label: "A" }, { label: "B" }] }).ok);
  });
});

describe("steps", () => {
  test("each with a state", () => {
    const parsed = ok(
      parseComponent("steps", {
        title: "Deploy",
        steps: [{ label: "Build", state: "done" }, { label: "Ship", state: "doing" }],
      }),
    );
    assert.equal(parsed.component.kind === "steps" && parsed.component.steps[1].state, "doing");
  });

  test("a state nobody defined becomes todo rather than breaking the row", () => {
    const parsed = ok(parseComponent("steps", { steps: [{ label: "Something", state: "vibing" }] }));
    assert.equal(parsed.component.kind === "steps" && parsed.component.steps[0].state, "todo");
  });

  test("a step with no label is not a step", () => {
    const parsed = parseComponent("steps", { steps: [{ state: "done" }] });
    assert.ok(!parsed.ok && /label/.test(parsed.error));
  });
});

describe("a quote and a refusal", () => {
  test("a quote keeps its attribution", () => {
    const parsed = ok(parseComponent("quote", { text: "It shipped on Friday.", from: "the changelog" }));
    assert.equal(parsed.component.kind === "quote" && parsed.component.from, "the changelog");
  });

  test("a quote with nothing in it is refused", () => {
    assert.ok(!parseComponent("quote", { from: "somewhere" }).ok);
  });

  test("a refusal says what could not be done", () => {
    const parsed = ok(parseComponent("refused", { what: "send the invoice", because: "a rule refuses it" }));
    assert.equal(parsed.component.kind === "refused" && parsed.component.what, "send the invoice");
  });

  test("a refusal with no what is not one", () => {
    assert.ok(!parseComponent("refused", { because: "reasons" }).ok);
  });
});

describe("nothing an agent writes reaches a screen unchecked", () => {
  test("junk in place of the whole payload is refused rather than rendered", () => {
    for (const junk of [null, "a string", 42, [], true]) {
      assert.equal(parseComponent("chart", junk).ok, false, JSON.stringify(junk));
    }
  });

  test("junk in place of a list is treated as no list", () => {
    assert.equal(parseComponent("table", { columns: "A,B", rows: "x" }).ok, false);
  });

  test("a very long label is cut rather than rendered whole", () => {
    const parsed = ok(parseComponent("chart", { bars: [{ label: "x".repeat(5_000), value: 1 }] }));
    assert.ok(parsed.component.kind === "chart" && parsed.component.bars[0].label.length <= 120);
  });

  test("a very long quote is cut", () => {
    const parsed = ok(parseComponent("quote", { text: "y".repeat(9_000) }));
    assert.ok(parsed.component.kind === "quote" && parsed.component.text.length <= 2_000);
  });
});

describe("which agent may use which", () => {
  test("everything, until something is withheld", () => {
    assert.equal(mayRender("chart", undefined), true);
    assert.equal(mayRender("chart", []), true);
  });

  test("withholding one leaves the rest", () => {
    assert.equal(mayRender("decision", ["decision"]), false);
    assert.equal(mayRender("chart", ["decision"]), true);
  });
});

describe("what the agent is told", () => {
  test("the line lists what it may use, and how", () => {
    const prompt = galleryPrompt([], "run `bloks show <kind> <json>`")!;
    assert.match(prompt, /chart, for comparing a handful of numbers/);
    assert.match(prompt, /bloks show/);
    assert.match(prompt, /Do not repeat the component's own contents in prose/);
  });

  test("what is withheld is not offered", () => {
    const prompt = galleryPrompt(["decision", "chart"], "how")!;
    assert.doesNotMatch(prompt, /- chart,/);
    assert.doesNotMatch(prompt, /- decision,/);
    assert.match(prompt, /- table,/);
  });

  test("an agent allowed none of them is told nothing at all", () => {
    assert.equal(galleryPrompt([...KINDS], "how"), null);
  });
});
