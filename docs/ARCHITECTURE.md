# Architecture

Three pieces, one rule.

| Layer | Location | Responsibility |
| --- | --- | --- |
| React app | `src/` | Chat, rooms, agent roster, panels, avatars |
| Harness server | `server/` | HTTP API, one SSE stream, provider registry, persistence, approvals |
| Electron shell | `electron/` | macOS window, packaged server, speech and computer bridges |

**The client holds no transports.** The React app never opens a
connection to a model provider. It dispatches typed commands over HTTP
and folds a single server-sent event stream into reducer state. Every
provider process runs inside the harness.

Everything below follows from that.

## A turn, end to end

1. `StoreProvider` loads `/api/bots`, `/api/bloks`, `/api/instances`,
   `/api/providers` and `/api/config`, then opens `/api/events`.
2. You send a message. The client dispatches `send`, which POSTs to
   `/api/bots/:id/messages`.
3. `startTurn` in `server/index.ts` builds the persona (role, skills,
   your profile, house style, and in a room the roster plus recent
   transcript), then calls the driver's `sendTurn`.
4. The driver translates its provider's native output into the canonical
   events in `server/contracts.ts`.
5. The bus subscriber folds those events into the transcript, persists
   them, and broadcasts to every connected client.
6. The reducer folds the same events into messages, streaming text, busy
   flags and approval cards.

The canonical event stream is the source of truth. The persisted
transcript and every client view are projections of it.

## Drivers

A driver turns one provider into the contract in `server/contracts.ts`.
There are three shapes:

**CLI over a native protocol.** `claude.ts` and `codex.ts` drive their
official CLIs headless over the protocols those CLIs expose. They carry
tool calls and permission requests.

**CLI over the Agent Client Protocol.** `acp.ts` is generic: ACP is a
JSON-RPC protocol that agent CLIs speak so editors can drive them, so one
implementation serves any agent that speaks it. Gemini CLI is the first.
Adding another is an entry in `ACP_SPECS`.

**OpenAI-compatible HTTP.** `openai-compat.ts` is generic too. Nearly
every lab now answers `/chat/completions`, so providers are data in
`server/providers.ts` rather than code. These are transcript-replay: the
harness hands them the folded history each turn. They stream text but
they do not run tools.

The registry (`server/harness/registry.ts`) turns a config map into live
instances. An unknown driver or a bad config becomes an unavailable
shadow entry rather than a startup failure, so a config written by a
newer build downgrades safely.

## Rooms

A room is a transcript with several agents in it. Two things make it work
like a workspace rather than a group chat with echoes:

**One speaker at a time.** `postToRoom` runs members sequentially in
ascending seniority, so each one sees what the last actually said and the
most senior speaks last. Handoffs raised mid-round queue rather than
interrupting, then drain in further rounds, bounded by `MAX_AGENT_HOPS`.

**Sessions belong to agents, not rooms.** An agent's provider session is
keyed to its own thread id. `activeRoom` redirects that agent's events
into whichever room it is currently speaking in. That is why an agent
remembers a room conversation when you DM it afterwards.

Team formation (`server/teams.ts`) sits on top: a senior agent can emit a
fenced plan, which becomes an approval card. Only your yes creates the
agents and the room.

## Persistence

Plain JSON under `~/.bloks`, written synchronously. No database.

| Path | Contents |
| --- | --- |
| `bots.json` | Agent records, model selection, resume cursors |
| `bloks.json` | Rooms and members |
| `messages-<id>.json` | One transcript per agent or room, same key space |
| `config.json` | Connected providers and keys, `0600` |
| `skills/*.md` | Installed skills |
| `events/`, `native/` | Canonical events, and raw provider traffic |

Room ids and agent thread ids share one key space, which is why a room
transcript and a solo transcript are the same kind of file.

## Boundaries worth knowing

- `server/http-guard.ts` checks `Origin` and `Host` on every request.
  Loopback is not a boundary in a browser.
- `server/limits.ts` holds every input cap in one place.
- `redactSecrets` scrubs stored keys and key-shaped strings from anything
  returned to the client.
- Approval requests block the turn. The driver holds the provider's
  request open until `respondToRequest` resolves it.
