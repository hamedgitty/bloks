// The app's identity, which two files have to agree on.
//
// electron-builder stamps appId into the packaged bundle. electron/cua.mjs
// tells the computer-use daemon which bundle holds the TCC grants. If those
// drift, the daemon attributes Screen Recording and Accessibility to a
// bundle that does not exist, every grant silently fails to apply, and the
// symptom is a feature that does nothing rather than an error anyone can
// read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const packagedId = () => read("../electron-builder.yml").match(/^appId:\s*(\S+)/m)?.[1];
const cuaHostId = () => read("../electron/cua.mjs").match(/HOST_BUNDLE_ID\s*=\s*"([^"]+)"/)?.[1];

test("the packaged app and the computer-use host claim the same bundle id", () => {
  const packaged = packagedId();
  const host = cuaHostId();
  assert.ok(packaged, "electron-builder.yml has no appId");
  assert.ok(host, "electron/cua.mjs has no HOST_BUNDLE_ID");
  assert.equal(host, packaged);
});

test("the bundle id sits under the domain we own", () => {
  // Every other identifier in the tree is dev.bloks.something: the iOS
  // bundle, the app group, the keychain service, the APNs topic, the VM
  // labels. A com.bloks.something id would claim reverse DNS on a domain
  // that is not ours, and would disagree with all of them.
  assert.match(packagedId()!, /^dev\.bloks\./);
});
