// The one live endpoint on an otherwise static site.
//
// POST /api/waitlist stores an email against a timestamp, once. That
// list is the entire market research budget for Bloks Cloud, so it is
// stored in KV where `wrangler kv key list` can read it back out, and
// nowhere else. No analytics anywhere on the site; this field is the
// only thing that phones home, and only when someone asks it to.
interface Env {
  ASSETS: Fetcher;
  WAITLIST: KVNamespace;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // one canonical host; www is a doorway, not an address
    if (url.hostname === "www.bloks.dev") {
      url.hostname = "bloks.dev";
      return Response.redirect(url.toString(), 301);
    }

    // Download links that outlive a version number. The buttons point
    // here; here points at whatever the latest release actually is, so
    // shipping 0.1.4 never leaves a dead button behind. GitHub resolves
    // /releases/latest/download/<name> against the newest release, but
    // the file NAME carries the version, so the redirect is built from
    // the release the API reports rather than guessed.
    if (url.pathname.startsWith("/download/")) {
      const want = url.pathname.slice("/download/".length);
      const picks: Record<string, RegExp> = {
        mac: /\.dmg$/,
        windows: /^Bloks-[\d.]+\.exe$/,
        // the portable one: runs anywhere without a package manager
        linux: /x86_64\.AppImage$/,
        "linux-arm": /arm64\.AppImage$/,
        "linux-deb": /amd64\.deb$/,
        "linux-deb-arm": /arm64\.deb$/,
      };
      const match = picks[want];
      if (!match) return new Response("no such download", { status: 404 });
      try {
        const res = await fetch(
          "https://api.github.com/repos/hamedgitty/bloks/releases/latest",
          { headers: { "user-agent": "bloks.dev", accept: "application/vnd.github+json" } },
        );
        if (!res.ok) throw new Error(String(res.status));
        const release = (await res.json()) as {
          assets?: Array<{ name: string; browser_download_url: string }>;
        };
        const asset = (release.assets ?? []).find((a) => match.test(a.name));
        if (!asset) throw new Error("no asset");
        return Response.redirect(asset.browser_download_url, 302);
      } catch {
        // Never a dead end: fall back to the releases page, where every
        // installer is listed and a person can pick for themselves.
        return Response.redirect("https://github.com/hamedgitty/bloks/releases/latest", 302);
      }
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      let email = "";
      try {
        const body = (await request.json()) as { email?: unknown };
        email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      } catch {
        /* not JSON; falls through to the same refusal */
      }
      if (!EMAIL.test(email) || email.length > 254) {
        return Response.json({ error: "that does not look like an email" }, { status: 400 });
      }
      // idempotent: signing up twice is enthusiasm, not an error
      await env.WAITLIST.put(email, new Date().toISOString());
      return Response.json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
