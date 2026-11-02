// Fetching a page or feed a watcher looks at.
//
// A watcher's address comes from the person, or from an agent filing one,
// and the page at it is somebody else's. Followed blindly, that page can
// answer with a redirect to this very server: a loopback request with no
// token is the person at the keyboard (http-guard.ts), so a page could
// have the watcher read webhook addresses or search every conversation,
// and hand the result to the agent as "what changed". Or to a cloud
// machine's metadata address, or to an admin page on the home network.
//
// So every hop is checked where it actually connects, not where its name
// says it goes (a name can resolve one way when checked and another when
// fetched):
//   - never this server's own ports, on any address of this machine;
//   - never link-local (169.254.x.x, the cloud metadata address among
//     them), unspecified or multicast addresses;
//   - a private or loopback address only when the watcher was pointed at
//     one on purpose. A page out on the internet never redirects inward.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

export interface WatchedFetchOptions {
  /** This server's own ports, never fetched whatever the address. */
  ownPorts: number[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

type Reach = "public" | "private" | "loopback" | "never";

/** What kind of place an address is. */
export function reachOf(address: string): Reach {
  const raw = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = raw.startsWith("::ffff:") && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  if (isIP(mapped) === 4) {
    const [a, b] = mapped.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 0 || a >= 224 || (a === 169 && b === 254)) return "never";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  if (isIP(mapped) === 6) {
    if (mapped === "::1") return "loopback";
    if (mapped === "::" || /^fe[89ab]/.test(mapped) || mapped.startsWith("ff")) return "never";
    if (/^f[cd]/.test(mapped)) return "private";
    return "public";
  }
  return "never";
}

/** How far in the watcher's own address lets it go: a public page stays
 * public; one pointed at the home network or this machine may stay there. */
export function allowedFrom(first: Reach): Set<Reach> {
  if (first === "loopback") return new Set(["public", "private", "loopback"]);
  if (first === "private") return new Set(["public", "private"]);
  return new Set(["public"]);
}

class Refused extends Error {}

/** The first address a name resolves to, refused unless it is allowed. */
function guardedLookup(allowed: Set<Reach>) {
  return (hostname: string, options: object, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !allowed.has(reachOf(a.address)));
      if (bad || !list.length) return callback(new Refused(`the address ${hostname} leads somewhere a watcher does not look`), "");
      if ((options as { all?: boolean }).all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

/** A name's place before connecting: an address literal is what it is;
 * a name is checked again as it connects. */
async function reachOfHost(hostname: string): Promise<Reach> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return reachOf(bare);
  if (bare === "localhost" || bare.endsWith(".localhost")) return "loopback";
  return new Promise((resolve) =>
    lookup(bare, { all: true }, (err, addresses) => {
      if (err || !addresses.length) return resolve("public");
      const kinds = addresses.map((a) => reachOf(a.address));
      resolve(kinds.includes("never") ? "never" : kinds.includes("loopback") ? "loopback" : kinds.includes("private") ? "private" : "public");
    }),
  );
}

/** The page's text, after at most a few redirects, every one checked. */
export async function fetchWatchedPage(address: string, o: WatchedFetchOptions): Promise<string> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const maxBytes = o.maxBytes ?? 2_000_000;
  const deadline = Date.now() + timeoutMs;
  let url = new URL(address);
  const first = await reachOfHost(url.hostname);
  if (first === "never") throw new Error("a watcher does not look at that address");
  const allowed = allowedFrom(first);
  for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("a watcher follows only http and https");
    if (url.username || url.password) throw new Error("a watcher does not send names and passwords in an address");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    // an address written out is judged before anything is sent to it; a
    // name is judged as it resolves and again as it connects
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal)) {
      const where = reachOf(literal);
      if (!allowed.has(where)) throw new Error("a watcher does not look at that address");
      if ((where === "loopback" || where === "private") && o.ownPorts.includes(port)) throw new Error("a watcher does not look at this server itself");
    }
    const answer = await once(url, port, allowed, o.ownPorts, Math.max(1, deadline - Date.now()), maxBytes);
    if (answer.location === null) {
      if (answer.status < 200 || answer.status >= 300) throw new Error(`the address answered ${answer.status}`);
      return answer.text;
    }
    url = new URL(answer.location, url);
  }
  throw new Error("the address redirected too many times");
}

function once(
  url: URL,
  port: number,
  allowed: Set<Reach>,
  ownPorts: number[],
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; location: string | null; text: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "GET",
        lookup: guardedLookup(allowed) as never,
        // a fresh connection each time, so every one is checked as it opens
        agent: false,
        headers: {
          "user-agent": "Bloks watcher (https://bloks.dev)",
          accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,*/*",
        },
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, text: "" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) res.destroy();
        });
        const done = () => resolve({ status, location: null, text: Buffer.concat(chunks).toString("utf8").slice(0, maxBytes) });
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      },
    );
    // checked where it connected: an address literal skips the lookup above
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        const at = socket.remoteAddress ?? "";
        const where = reachOf(at);
        if (!allowed.has(where) || ((where === "loopback" || where === "private") && ownPorts.includes(port))) {
          req.destroy(new Refused("a watcher does not look at this server itself, or anywhere its address does not lead"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("the address did not answer in time")));
    req.on("error", (e) => reject(e instanceof Refused ? new Error(e.message) : e));
    req.end();
  });
}
