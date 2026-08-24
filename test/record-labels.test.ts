// Every kind of entry has words a person can read.
//
// The record is the one screen where a raw identifier is worst: it is
// meant to be the plain account of what happened, and a row reading
// "workflow.ran" is the surface admitting it did not expect this entry.
// The map lives in the panel because it is copy rather than data, so
// nothing else can notice when a new kind is added without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("every ledger kind has a label in the record panel", () => {
  const declared = source("../server/ledger.ts").match(/export type LedgerKind =([\s\S]*?);/);
  assert.ok(declared, "LedgerKind is not where this test expects it");
  const kinds = [...declared[1].matchAll(/"([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 8, "no kinds were found, so this test proves nothing");

  const labels = source("../src/components/RecordPanel.tsx").match(
    /const LABEL: Record<string, string> = \{([\s\S]*?)\};/,
  );
  assert.ok(labels, "the LABEL map is not where this test expects it");
  const known = new Set([...labels[1].matchAll(/"?([\w.]+)"?:\s*"/g)].map((m) => m[1]));

  const missing = kinds.filter((kind) => !known.has(kind));
  assert.deepEqual(missing, [], `these would show as raw identifiers: ${missing.join(", ")}`);
});

// The editor names a step as soon as it has words, so an earlier answer
// can be referenced before the workflow has ever been saved. It has to
// name it the way the server would, or the reference it offers would be
// refused on save.
test("the editor's step naming agrees with the server's", () => {
  const client = source("../src/components/Workflows.tsx").match(
    /function stepId\(text: string, taken: string\[\]\): string \{([\s\S]*?)\n\}/,
  );
  const server = source("../server/workflows.ts").match(
    /export function slug\(text: string, taken: string\[\] = \[\]\): string \{([\s\S]*?)\n\}/,
  );
  assert.ok(client, "the editor's stepId is not where this test expects it");
  assert.ok(server, "the server's slug is not where this test expects it");

  // the shape both have to share: what a name is made of, and the cap
  const rule = /\.toLowerCase\(\)[\s\S]*?replace\(\/\[\^a-z0-9\]\+\/g, "-"\)[\s\S]*?replace\(\/\^-\+\|-\+\$\/g, ""\)[\s\S]*?slice\(0, 24\) \|\| "step"/;
  assert.match(client[1], rule, "the editor stopped naming steps the way the server does");
  assert.match(server[1], rule, "the server changed how it names steps");
});
