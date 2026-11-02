// Test children only: no real Telegram or other external request.
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Crash the synthetic server only after the requested transcript marker
// has been atomically installed and before its caller can dispatch input.
if (process.env.BLOKS_TEST_CRASH_PREP && !fs.existsSync(join(process.env.HOME, "prep-crash"))) {
  const write = fs.writeFileSync.bind(fs), rename = fs.renameSync.bind(fs), sync = fs.fsyncSync.bind(fs);
  let armed = false;
  fs.writeFileSync = (file, data, ...rest) => {
    if (process.env.BLOKS_TEST_CRASH_STAGE === "joined" && typeof data === "string" &&
        data.includes(process.env.BLOKS_TEST_CRASH_PREP) && data.includes('"state": "joined"')) {
      write(join(process.env.HOME, "prep-crash"), "1");
      process.kill(process.pid, "SIGKILL");
    }
    const result = write(file, data, ...rest);
    const stage = process.env.BLOKS_TEST_CRASH_STAGE;
    const marker = stage === "dismissed" || stage === "fail-dismiss" ? '"dismissed": true' : '"state": "dispatching"';
    if (stage !== "joined" && typeof data === "string" && data.includes(process.env.BLOKS_TEST_CRASH_PREP) && data.includes(marker)) armed = true;
    return result;
  };
  fs.fsyncSync = (fd) => {
    if (armed && ["fail-dispatch", "fail-dismiss"].includes(process.env.BLOKS_TEST_CRASH_STAGE)) {
      armed = false;
      write(join(process.env.HOME, "prep-write-failed"), "1");
      throw Object.assign(new Error("synthetic fsync failure"), { code: "EIO" });
    }
    return sync(fd);
  };
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (armed && !["fail-dispatch", "fail-dismiss"].includes(process.env.BLOKS_TEST_CRASH_STAGE) && String(to).includes("/messages-")) {
      armed = false;
      write(join(process.env.HOME, "prep-crash"), "1");
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
  syncBuiltinESMExports();
}

const request = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://api.telegram.org") {
    if (!process.env.BLOKS_TEST_TELEGRAM_URL) throw new Error("No Telegram stub configured");
    return request(new URL(url.pathname + url.search, process.env.BLOKS_TEST_TELEGRAM_URL), options);
  }
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/audio/transcriptions" && process.env.BLOKS_TEST_SPEECH_URL) {
    return request(new URL(url.pathname, process.env.BLOKS_TEST_SPEECH_URL), options);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("External request refused by test fixture");
  return request(input, options);
};

// A crash after listening but before queue recovery, so two complete
// startups can leave a request waiting without starting its engine.
if (process.env.BLOKS_TEST_STOP_BEFORE_RECOVERY === "1") {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    const result = write(...args);
    if (String(args[0]).includes("bloks server on http://")) process.kill(process.pid, "SIGSTOP");
    return result;
  };
}
