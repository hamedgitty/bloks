// Hand-written twin of app-browser.mjs: the shared shapes, and the one
// thing that is the app's alone.

export * from "../server/browser-core.mjs";

export function partitionFor(workspaceId: string): string;
