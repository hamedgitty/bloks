// React and react-dom have to be the same version, exactly.
//
// React checks this at the first render and refuses to draw anything if
// they differ, so a mismatch is not a warning, it is a blank window. 1.7.0
// shipped one: a dependency bump moved react and left react-dom behind,
// every test passed because none of them render the interface, and the
// app opened to nothing. This is the test that would have caught it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("react and react-dom are the same version", () => {
  const react = require("react/package.json").version as string;
  const dom = require("react-dom/package.json").version as string;
  assert.equal(dom, react, `react ${react} with react-dom ${dom} renders a blank window`);
});

test("the ranges in package.json cannot drift apart either", () => {
  const pkg = require("../package.json") as { dependencies: Record<string, string> };
  const floor = (range: string) => range.replace(/^[\^~]/, "");
  assert.equal(
    floor(pkg.dependencies["react-dom"]),
    floor(pkg.dependencies.react),
    "bump react and react-dom together",
  );
});
