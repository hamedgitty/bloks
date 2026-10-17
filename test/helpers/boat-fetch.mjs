// Test-only loopback substitute. Never send the dummy token externally.
const request = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "api.telegram.org") {
    if (!process.env.BLOKS_TEST_TELEGRAM_URL) throw new Error("No Telegram fixture configured");
    return request(new URL(url.pathname + url.search, process.env.BLOKS_TEST_TELEGRAM_URL), options);
  }
  if (url.hostname === "boat.dev") {
    if (!process.env.BLOKS_TEST_BOAT_URL) throw new Error("No Boat fixture configured");
    return request(new URL(url.pathname + url.search, process.env.BLOKS_TEST_BOAT_URL), options);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("External request refused by test fixture");
  return request(input, options);
};
