// The app window stays on the app's own page. Any page on localhost used
// to count as the app, and agents run dev servers, notebooks and desktops
// on localhost, which would then have had the app's bridge.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sameAppOrigin } from "../electron/navigation.mjs";

test("only the app's exact origin is its own page", () => {
  const app = "http://127.0.0.1:8799";
  assert.equal(sameAppOrigin("http://127.0.0.1:8799/?quick=1", app), true);
  assert.equal(sameAppOrigin("http://127.0.0.1:8799/settings", app), true);
  // an agent's dev server, a notebook, a container's desktop
  assert.equal(sameAppOrigin("http://127.0.0.1:3000/", app), false);
  assert.equal(sameAppOrigin("http://localhost:8799/", app), false);
  assert.equal(sameAppOrigin("https://example.com/", app), false);
  assert.equal(sameAppOrigin("not a url", app), false);
});

test("a window showing the startup failure page has no own origin", () => {
  assert.equal(sameAppOrigin("data:text/html,anything", "data:text/html,<p>Bloks could not start</p>"), false);
});
