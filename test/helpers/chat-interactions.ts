import { createServer } from "node:http";
import { startHarness } from "./server.ts";

export async function waitFor<T>(check: () => T | Promise<T>, timeout = 5_000): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = await check();
    if (found) return found as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not become true");
}

/** Hold model replies until the test releases them, so queue checks never race a timer. */
export async function chatHarness(extraEnv: Record<string, string> = {}) {
  const calls: Array<{ body: any; finish: () => void }> = [];
  let closing = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const finish = () => res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Finished this request." } }],
      }));
      calls.push({ body: JSON.parse(body), finish });
      if (closing) finish();
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const h = await startHarness(extraEnv);
  const post = (path: string, body: unknown) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  await post("/api/providers/grok/connect", { key: "test-key", url: `http://127.0.0.1:${port}` });
  const { bot } = await post("/api/bots", { name: "QueueAgent" });
  const { bot: other } = await post("/api/bots", { name: "OtherAgent" });
  await h.json(`/api/bots/${bot.id}`, {
    method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }),
  });
  const { blok } = await post("/api/bloks", { name: "Queue test", memberIds: [bot.id, other.id] });
  return {
    h, calls, bot, blok, post,
    async messages() {
      const { bloks } = await h.json("/api/bloks");
      return bloks.find((b: any) => b.id === blok.id).messages as any[];
    },
    async stop() {
      closing = true;
      calls.forEach((call) => call.finish());
      await h.stop();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    },
  };
}

export const decision = {
  kind: "decision",
  data: {
    question: "Which approach should we use?",
    options: [
      { label: "Quick review", detail: "Review the existing draft and send comments.", pick: true },
      { label: "Full rewrite", detail: "Rewrite the document and check all supporting details." },
    ],
  },
};
