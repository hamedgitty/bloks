// Test children only: no real Telegram or other external request.
const request = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://api.telegram.org") {
    if (!process.env.BLOKS_TEST_TELEGRAM_URL) throw new Error("No Telegram stub configured");
    return request(new URL(url.pathname + url.search, process.env.BLOKS_TEST_TELEGRAM_URL), options);
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
