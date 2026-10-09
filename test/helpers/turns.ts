// A stand-in provider and the small reads the turn-recovery tests share
// (test/restart-recovery.test.ts, test/drain.test.ts).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import type { Harness } from "./server.ts";

export const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 15_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

export const PICKUP = "Bloks stopped in the middle of your last step";

/** A provider that answers on cue: every call is kept, and held until the
 * test lets it go, unless `answerAtOnce` is set. */
export async function fakeProvider(t: { after: (fn: () => unknown) => void }) {
  const state = {
    calls: [] as string[],
    held: [] as Array<() => void>,
    answerAtOnce: false,
    /** A turn whose body has this in it gets a question back, once. */
    askOn: "",
    /** Asked to summarise a conversation (a fold), answer like any other
     * call; or fail, so the fold changes nothing; or hold it in `folds`
     * until the test lets it go, and then fail. A fold failed or held is
     * kept apart from `calls` and `held`. */
    folding: "answer" as "answer" | "fail" | "hold",
    folds: [] as Array<() => void>,
  };
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      if (state.folding !== "answer" && /Summarise this part of a conversation|Here is a summary of a conversation so far/.test(body)) {
        const fail = () => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: "not now" } }));
        };
        if (state.folding === "hold") state.folds.push(fail);
        else fail();
        return;
      }
      state.calls.push(body);
      if (state.askOn && body.includes(state.askOn) && !body.includes(PICKUP) && !body.includes('"role":"tool"')) {
        return res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "ask_user", arguments: JSON.stringify({ question: "Ship it?", choices: ["Yes", "No"] }) },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (state.answerAtOnce) finish();
      else state.held.push(finish);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    state.held.forEach((f) => f());
    state.folds.forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
  });
  const port = (provider.address() as { port: number }).port;
  return {
    state,
    port,
    sent: (marker: string) => state.calls.filter((c) => c.includes(marker)).length,
  };
}

export async function agentOn(h: Harness, port: number, name: string) {
  await h.json("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "test-key", url: `http://127.0.0.1:${port}` }) });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  return bot as { id: string; threadId: string };
}

export const messagesOf = async (h: Harness, bot: { id: string; threadId: string }) =>
  (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages as any[];

export const idle = (h: Harness, bot: { id: string }) =>
  waitFor(async () => {
    const { bots } = await h.json("/api/bots");
    const found = bots.find((b: any) => b.id === bot.id);
    return found && !found.busy ? found : null;
  });

export const inFlight = (home: string) => {
  try {
    return JSON.parse(readFileSync(join(home, ".bloks", "turns-in-flight.json"), "utf8")) as any[];
  } catch {
    return [];
  }
};
