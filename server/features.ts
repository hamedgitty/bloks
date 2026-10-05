// What this server can do for a client on another device, by name.
//
// The phone comes from the App Store and this app updates itself, each on
// its own schedule, so either one can be ahead of the other. /api/health
// carries this list and the version beside it; a phone reads them and
// hides what this Mac cannot do yet, instead of offering a button whose
// answer is a 404 it has to explain.
//
// Names rather than version numbers, because a name means one thing
// however releases are numbered. The rules that keep it honest:
//
//   Add a name in the same change that adds what it names, for anything a
//   phone or another computer calls: a route, a field a route now reads,
//   an event the stream now sends.
//
//   Never take a name out while a phone build that asks for it could still
//   be in use. Removing what it names is a separate, later decision.
export const FEATURES: readonly string[] = [
  // PATCH section on agents and rooms, and the sidebar sections it files into
  "sections",
  // ?before= paging on a transcript, for loading earlier messages
  "earlier",
  // GET /api/bots/:id/exchange/:peer, one agent's messages with another
  "exchange",
  // voice calls: claim, renew, hang up
  "calls",
  // watchers: pages and feeds an agent keeps an eye on
  "watchers",
  // the daily brief and its settings
  "briefs",
  // scheduled work, made, changed and removed from a phone
  "routines",
  // incoming webhooks per agent
  "webhooks",
  // what your agents know about you
  "notes",
];
