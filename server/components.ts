// Answers that are not paragraphs.
//
// An agent asked for last quarter's numbers writes a markdown table, and
// the person reads a markdown table. That is the whole of the interface
// most of the time, and it is a waste of an app: we have a real window,
// real type, and a design system, and the answer arrives as monospace
// pipes because prose is the only shape the model has.
//
// So there is a small gallery, and an agent can answer with one of them
// instead. Four decisions.
//
//   The set is small and closed. Six shapes that cover what an answer
//   usually is: numbers, rows, a recommendation, a sequence, something
//   worth quoting, and something refused. An open set would mean an agent
//   inventing components, which is a design system nobody is maintaining.
//
//   A component renders what it was given and reads nothing. Letting one
//   fetch for itself would mean granting it the right to query, and a
//   permission model for the inside of a chat bubble. Here the thing
//   that rendered is the same thing that fetched, so the question never
//   arises: a much smaller surface, and the right trade for a workspace
//   rather than a dashboard.
//
//   Everything is validated here before it reaches a screen. What arrives
//   is JSON an agent wrote, which makes it the least trustworthy input in
//   the product. A component that renders whatever it is handed is one
//   malformed number away from a broken chat.
//
//   A refusal says what was wrong. The caller is a model: "invalid" sends
//   it round again with the same mistake, and naming the field does not.
/** The whole gallery. Closed on purpose. */
export type ComponentKind = "chart" | "table" | "decision" | "steps" | "quote" | "refused";

export const KINDS: ComponentKind[] = ["chart", "table", "decision", "steps", "quote", "refused"];

/** What each one is for, in the words the agent is told. */
export const CATALOG: Array<{ kind: ComponentKind; takes: string; when: string }> = [
  {
    kind: "chart",
    takes: `{"title": "…", "bars": [{"label": "…", "value": 12}], "note": "…"}`,
    when: "comparing a handful of numbers",
  },
  {
    kind: "table",
    takes: `{"title": "…", "columns": ["…"], "rows": [["…"]], "note": "…"}`,
    when: "rows and columns, instead of pipes and dashes",
  },
  {
    kind: "decision",
    takes: `{"question": "…", "options": [{"label": "…", "detail": "…", "pick": true}], "because": "…"}`,
    when: "recommending one of several things, and saying why",
  },
  {
    kind: "steps",
    takes: `{"title": "…", "steps": [{"label": "…", "state": "done|doing|todo|failed", "detail": "…"}]}`,
    when: "what you did, or what you are about to do, in order",
  },
  {
    kind: "quote",
    takes: `{"text": "…", "from": "…", "where": "…"}`,
    when: "a passage worth reading exactly, from something you found",
  },
  {
    kind: "refused",
    takes: `{"what": "…", "because": "…"}`,
    when: "you could not do something and want it to be visible rather than buried in a paragraph",
  },
];

export const MAX_ROWS = 40;
export const MAX_COLUMNS = 8;
export const MAX_BARS = 24;
export const MAX_STEPS = 24;
export const MAX_TEXT = 2_000;
export const MAX_LABEL = 120;

export interface Bar {
  label: string;
  value: number;
}
export interface Option {
  label: string;
  detail?: string;
  pick?: boolean;
}
export interface Step {
  label: string;
  state: "done" | "doing" | "todo" | "failed";
  detail?: string;
}

export type Component =
  | { kind: "chart"; title?: string; note?: string; bars: Bar[] }
  | { kind: "table"; title?: string; note?: string; columns: string[]; rows: string[][] }
  | { kind: "decision"; question: string; because?: string; options: Option[] }
  | { kind: "steps"; title?: string; steps: Step[] }
  | { kind: "quote"; text: string; from?: string; where?: string }
  | { kind: "refused"; what: string; because?: string };

export type Parsed = { ok: true; component: Component } | { ok: false; error: string };

const text = (value: unknown, max = MAX_LABEL): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * One component, checked into shape, or why it is not one.
 *
 * Every refusal names the field, because the caller is a model and a bare
 * "invalid" sends it round again to make the same mistake.
 */
export function parseComponent(kind: string, data: unknown): Parsed {
  if (!KINDS.includes(kind as ComponentKind)) {
    return { ok: false, error: `there is no "${kind}". The ones there are: ${KINDS.join(", ")}` };
  }
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

  switch (kind as ComponentKind) {
    case "chart": {
      const bars = list(raw.bars)
        .map((entry) => {
          const bar = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          const value = Number(bar.value);
          return { label: text(bar.label), value: Number.isFinite(value) ? value : NaN };
        })
        .filter((bar) => bar.label && Number.isFinite(bar.value))
        .slice(0, MAX_BARS);
      if (!bars.length) {
        return { ok: false, error: "chart needs bars, each with a label and a number: {label, value}" };
      }
      return {
        ok: true,
        component: { kind: "chart", title: text(raw.title), note: text(raw.note, 300), bars },
      };
    }

    case "table": {
      const columns = list(raw.columns).map((c) => text(c)).filter(Boolean).slice(0, MAX_COLUMNS);
      if (!columns.length) return { ok: false, error: "table needs columns, as a list of headings" };
      const rows = list(raw.rows)
        .map((row) =>
          list(row)
            .slice(0, columns.length)
            .map((cell) => text(cell, 300)),
        )
        .filter((row) => row.length)
        // short rows are padded rather than refused: a missing cell is a
        // gap in the answer, not a reason to send the whole thing back
        .map((row) => [...row, ...Array(Math.max(0, columns.length - row.length)).fill("")])
        .slice(0, MAX_ROWS);
      if (!rows.length) return { ok: false, error: "table needs rows, each a list of cells" };
      return {
        ok: true,
        component: { kind: "table", title: text(raw.title), note: text(raw.note, 300), columns, rows },
      };
    }

    case "decision": {
      const question = text(raw.question, 300);
      if (!question) return { ok: false, error: "decision needs a question: what is being decided" };
      const options = list(raw.options)
        .map((entry) => {
          const option = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          return {
            label: text(option.label),
            detail: text(option.detail, 300) || undefined,
            pick: option.pick === true,
          };
        })
        .filter((option) => option.label)
        .slice(0, 6);
      if (options.length < 2) {
        return { ok: false, error: "decision needs at least two options, each with a label" };
      }
      // Exactly one recommendation, or none. Two picks is not a
      // recommendation, it is the question again.
      let seen = false;
      for (const option of options) {
        if (option.pick && seen) option.pick = false;
        if (option.pick) seen = true;
      }
      return {
        ok: true,
        component: { kind: "decision", question, because: text(raw.because, 500) || undefined, options },
      };
    }

    case "steps": {
      const steps = list(raw.steps)
        .map((entry) => {
          const step = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          const state = String(step.state ?? "todo");
          return {
            label: text(step.label),
            state: (["done", "doing", "todo", "failed"].includes(state) ? state : "todo") as Step["state"],
            detail: text(step.detail, 300) || undefined,
          };
        })
        .filter((step) => step.label)
        .slice(0, MAX_STEPS);
      if (!steps.length) {
        return { ok: false, error: "steps needs steps, each with a label and a state of done, doing, todo or failed" };
      }
      return { ok: true, component: { kind: "steps", title: text(raw.title), steps } };
    }

    case "quote": {
      const body = text(raw.text, MAX_TEXT);
      if (!body) return { ok: false, error: "quote needs text: the passage itself" };
      return {
        ok: true,
        component: {
          kind: "quote",
          text: body,
          from: text(raw.from) || undefined,
          where: text(raw.where, 300) || undefined,
        },
      };
    }

    case "refused": {
      const what = text(raw.what, 300);
      if (!what) return { ok: false, error: "refused needs what: the thing that could not be done" };
      return { ok: true, component: { kind: "refused", what, because: text(raw.because, 500) || undefined } };
    }
  }
}

// ── which agent may use which ──────────────────────────────────────────

/**
 * May this agent render this.
 *
 * By exclusion rather than by grant: withholding one component from one
 * agent should not touch anybody else, and a list of everything
 * permitted goes stale the moment the gallery grows.
 *
 * There is no separate published state here. A component that exists in
 * this build is published by definition; a half finished one would not
 * have shipped.
 */
export function mayRender(kind: ComponentKind, without: string[] | undefined): boolean {
  return !(without ?? []).includes(kind);
}

/** The line an agent is told, listing what it may answer with. */
export function galleryPrompt(without: string[] | undefined, howToShow: string): string | null {
  const allowed = CATALOG.filter((entry) => mayRender(entry.kind, without));
  if (!allowed.length) return null;
  return [
    "Instead of describing something in prose, you can answer with one of these. Prefer them whenever the answer is really numbers, rows, a recommendation, a sequence or a passage: they render as proper interface in the chat rather than as markdown.",
    "",
    ...allowed.map((entry) => `- ${entry.kind}, for ${entry.when}\n  ${entry.takes}`),
    "",
    howToShow,
    "Say a sentence alongside it if there is something to add. Do not repeat the component's own contents in prose.",
  ].join("\n");
}

/** Kept for the settings screen, which needs a name for each. */
export const KIND_LABEL: Record<ComponentKind, string> = {
  chart: "Charts",
  table: "Tables",
  decision: "Decisions",
  steps: "Step lists",
  quote: "Quotes",
  refused: "Refusals",
};

/**
 * Components an engine wrote into its own answer.
 *
 * The CLI is the route for engines that run a process. An API model has
 * no shell, so it needs a way to send a component that is just text, and
 * a fenced block is the one shape every model already emits reliably:
 *
 *     ```bloks
 *     { "kind": "chart", "bars": [...] }
 *     ```
 *
 * Anything that parses becomes a component; anything that does not is
 * left exactly where it was, because a malformed fence is more useful to
 * a reader as visible text than as a silent deletion.
 */
export function extractComponents(text: string): {
  components: Component[];
  text: string;
  /** Fences that looked like ours and did not parse, for the log. */
  rejected: number;
} {
  const components: Component[] = [];
  let rejected = 0;
  const fence = /^[ \t]*```[ \t]*bloks[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  const remaining = text.replace(fence, (whole, body: string) => {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      rejected++;
      return whole;
    }
    const kind = (data as { kind?: unknown })?.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as ComponentKind)) {
      rejected++;
      return whole;
    }
    const parsed = parseComponent(kind, data);
    if (!parsed.ok) {
      rejected++;
      return whole;
    }
    components.push(parsed.component);
    return "";
  });
  // Collapse the blank run a lifted fence leaves behind, so the sentence
  // above and the one below do not end up separated by a hole.
  return { components, text: remaining.replace(/\n{3,}/g, "\n\n").trim(), rejected };
}
