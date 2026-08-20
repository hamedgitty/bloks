// Speech helper lifecycle, main-process side. The Swift helper is spawned
// from HERE (never the harness server) so the Microphone + Speech
// Recognition permission prompts attribute to the app. Each recording
// session is one helper process.
import { spawn } from "node:child_process";
import { nativeHelper } from "./native-helper.mjs";

let child = null;

export function startSpeech(win) {
  stopSpeech();
  const proc = spawn(nativeHelper("speech-helper"), [], { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        if (!win.isDestroyed()) win.webContents.send("speech:transcript", JSON.parse(line));
      } catch {
        /* non-JSON noise on stdout, ignore */
      }
    }
  });
  proc.on("close", (code) => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code });
  });
  proc.on("error", () => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code: 1 });
  });
}

export function stopSpeech() {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  child = null;
}
