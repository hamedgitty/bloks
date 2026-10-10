// Hand-written twin of links.mjs, so the tests typecheck against the
// same shapes the main process uses.
export function teamLink(raw: unknown): { kind: "team"; slug: string } | null;
export function linkInArgv(argv: unknown): string | null;
