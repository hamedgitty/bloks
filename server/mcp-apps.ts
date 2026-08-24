// An MCP server's own interface, rendered as an app.
//
// A connector is a list of functions until something draws it. The
// convention that has settled around MCP is that a server publishes a
// resource whose body is a whole HTML document, named under a ui: scheme
// or simply typed as HTML, and the host frames it and listens for
// messages back. That is enough to turn a set of tool signatures into
// something with buttons.
//
// The document comes from someone else's server, so it is treated the way
// a downloaded page is treated rather than the way our own code is:
//
//   It is framed with no origin of its own, so it cannot read our cookies,
//   our storage or anything else the app holds.
//
//   A content policy goes in ahead of its own markup, and it allows no
//   network of any kind. A panel that could call home would be a way to
//   move whatever it can see off this machine, and there is no version of
//   that which is worth the convenience.
//
//   It is told the app's colours, so it belongs on the screen it is on,
//   and that is the only thing we inject into it.
//
// Everything here is pure. The client that fetches from a server is in
// server/mcp-client.ts, and the routes are in server/index.ts.
import type { McpResource, McpResourceContents, McpTool } from "./mcp-client.ts";

/** One thing a server can draw. */
export interface McpApp {
  uri: string;
  name: string;
  description: string;
}

/** How big a document we will frame. */
export const MAX_APP_BYTES = 1024 * 1024;

/**
 * Is this resource an interface rather than a document.
 *
 * Two ways a server says so, and both are honoured: the scheme, which is
 * the convention that grew up around this, and the media type, which is
 * what it actually is.
 */
export function isApp(resource: Pick<McpResource, "uri" | "mimeType">): boolean {
  if (typeof resource?.uri !== "string") return false;
  if (resource.uri.startsWith("ui://")) return true;
  return resource.mimeType === "text/html" || resource.mimeType === "text/html+skybridge";
}

/** A name a person can read, from whatever the server gave us. */
export function appFrom(resource: McpResource): McpApp {
  const tail = resource.uri.split(/[/?#]/).filter(Boolean).pop() ?? resource.uri;
  const fallback = tail.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim();
  return {
    uri: resource.uri,
    name: (resource.name || fallback || resource.uri).slice(0, 80),
    description: (resource.description ?? "").slice(0, 200),
  };
}

export function appsIn(resources: McpResource[]): McpApp[] {
  return resources.filter(isApp).map(appFrom);
}

/**
 * The document out of a resource read, whichever way it was sent.
 *
 * Returns null rather than throwing for anything that is not a document
 * we can frame, because "this server has no interface" is an ordinary
 * answer and not an error.
 */
export function documentIn(parts: McpResourceContents[]): string | null {
  for (const part of parts) {
    if (typeof part.text === "string" && part.text.trim()) {
      return part.text.slice(0, MAX_APP_BYTES);
    }
    if (typeof part.blob === "string" && part.blob) {
      const decoded = Buffer.from(part.blob, "base64");
      if (decoded.length && decoded.length <= MAX_APP_BYTES) return decoded.toString("utf8");
    }
  }
  return null;
}

/**
 * The policy the framed document runs under.
 *
 * `default-src 'none'` is the whole point: no fetch, no image from
 * anywhere, no font, no frame, no websocket. Styles and scripts are
 * allowed only from inside the document itself, which is what makes it an
 * app rather than a picture, and data: images are allowed because a chart
 * drawn into a canvas has to land somewhere.
 */
export const APP_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "media-src data: blob:; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "frame-src 'none'; " +
  "connect-src 'none'";

/** The colours a framed app is told about, so it can match the app it is
 * sitting in without being able to read anything else about it. */
export interface AppTheme {
  scheme: "dark" | "light";
  background: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
}

const CSS_COLOR = /^[#a-zA-Z0-9(),.%\s/-]{0,64}$/;

/** A colour from a client is put into a stylesheet, so it is checked
 * rather than trusted: anything with a brace or a semicolon in it could
 * close the rule and open something else. */
function safeColor(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && CSS_COLOR.test(text) ? text : fallback;
}

export function themeFrom(value: unknown): AppTheme {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const dark = v.scheme === "dark";
  return {
    scheme: dark ? "dark" : "light",
    background: safeColor(v.background, dark ? "#17171a" : "#ffffff"),
    foreground: safeColor(v.foreground, dark ? "#ededf0" : "#18181b"),
    muted: safeColor(v.muted, dark ? "#8f8f99" : "#68686f"),
    border: safeColor(v.border, dark ? "#2a2a30" : "#e6e6e9"),
    // The ink rather than the plain brand, and a different value per
    // scheme. This is the one accent handed to markup we do not control,
    // so we have to assume it will be used as a fill with words on it,
    // and the lighter blue does not carry words. The dark default used
    // to be the light blue, which was simply a copied line.
    accent: safeColor(v.accent, dark ? "#7c8aff" : "#4a59e6"),
  };
}

/**
 * Wrap a server's document so it is framed under our terms.
 *
 * The policy and the colours go in front of everything the document says,
 * because a meta policy only counts if it is the first thing the parser
 * meets, and because a document that sets its own colours should win over
 * the defaults we hand it rather than the other way round.
 */
export function frameDocument(html: string, theme: AppTheme): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="color-scheme" content="${theme.scheme}">`,
    "<style>",
    ":root{",
    `color-scheme:${theme.scheme};`,
    `--bloks-bg:${theme.background};`,
    `--bloks-fg:${theme.foreground};`,
    `--bloks-muted:${theme.muted};`,
    `--bloks-border:${theme.border};`,
    `--bloks-accent:${theme.accent};`,
    "}",
    "html,body{margin:0;padding:0;",
    `background:${theme.background};color:${theme.foreground};`,
    'font:14px/1.5 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;}',
    "</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

/**
 * What a framed app is allowed to ask for.
 *
 * A message arrives from a document we did not write, so it is parsed
 * into one of a handful of shapes and anything else is dropped. The
 * shapes are the ones the convention settled on: run a tool, say
 * something to the agent, tell the person something, open a link.
 */
export type AppMessage =
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "prompt"; text: string }
  | { kind: "notify"; text: string }
  | { kind: "link"; href: string }
  | { kind: "size"; height: number };

export const MAX_PROMPT_CHARS = 4_000;

export function parseAppMessage(value: unknown): AppMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, any>;
  const type = typeof v.type === "string" ? v.type : "";
  const payload = (typeof v.payload === "object" && v.payload !== null ? v.payload : v) as Record<string, any>;

  if (type === "tool") {
    const tool = typeof payload.toolName === "string" ? payload.toolName : payload.name;
    if (typeof tool !== "string" || !tool.trim()) return null;
    const args = typeof payload.params === "object" && payload.params !== null
      ? payload.params
      : typeof payload.arguments === "object" && payload.arguments !== null
        ? payload.arguments
        : {};
    return { kind: "tool", tool: tool.slice(0, 120), args: args as Record<string, unknown> };
  }
  if (type === "prompt" || type === "intent") {
    const text = typeof payload.prompt === "string" ? payload.prompt : payload.text;
    if (typeof text !== "string" || !text.trim()) return null;
    return { kind: "prompt", text: text.slice(0, MAX_PROMPT_CHARS) };
  }
  if (type === "notify") {
    const text = typeof payload.message === "string" ? payload.message : payload.text;
    if (typeof text !== "string" || !text.trim()) return null;
    return { kind: "notify", text: text.slice(0, 300) };
  }
  if (type === "link") {
    const href = typeof payload.url === "string" ? payload.url : payload.href;
    // http and https only: a framed document does not get to hand the
    // system a file:// path or a scheme that opens another application
    if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return null;
    return { kind: "link", href: href.slice(0, 2_000) };
  }
  if (type === "size" || type === "ui-size-change") {
    const height = Number(payload.height);
    if (!Number.isFinite(height)) return null;
    return { kind: "size", height: Math.max(120, Math.min(4_000, Math.round(height))) };
  }
  return null;
}

/** Whatever a tool call gave back, as something to show. */
export function textOf(result: unknown): string {
  const content = (result as any)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .slice(0, 4_000);
}

/** Only what the server actually published may be called: an app is not
 * permitted to name a tool the server did not offer. */
export function allowsTool(tools: McpTool[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}
