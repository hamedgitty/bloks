// Imported only by the isolated memory HTTP fixture. No production switch.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const realRead = fs.readFileSync;
const control = process.env.TEST_MEMORY_READ_FAULT;
fs.readFileSync = function (path, ...args) {
  const faults = JSON.parse(realRead(control, "utf8"));
  const code = faults[String(path)];
  if (code) throw Object.assign(new Error("planted memory text"), { code });
  return Reflect.apply(realRead, fs, [path, ...args]);
};
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  fs.appendFileSync(process.env.TEST_MEMORY_RENAMES, JSON.stringify([String(from), String(to)]) + "\n");
  return rename(from, to);
};
syncBuiltinESMExports();
