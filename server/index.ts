// Bloks server: the harness host.
//
// The one rule the whole shape follows: clients hold no transports. The
// React app dispatches typed commands over HTTP and folds one SSE event
// stream, and every provider process runs here.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { extname, join, resolve, sep } from "node:path";

import * as attachments from "./attachments.ts";
import * as box from "./box.ts";
import * as diagnostics from "./diagnostics.ts";
import * as scout from "./scout.ts";
import {
  ArtifactCommentStore,
  describeAnchor,
  MAX_COMMENT_CHARS,
  parseAnchor,
} from "./artifact-comments.ts";
import * as composio from "./composio.ts";
import {
  APP_VERSION,
  DATA_DIR,
  activeCustomKey,
  connectedProviders,
  customInstanceId,
  disconnectProvider,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  saveConfig,
  AVATARS_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
  type AppConfig,
  type CustomEndpoint,
  type CustomKey,
} from "./config.ts";
import { RelayLink, relayDeviceFor } from "./relay-link.ts";
import { CLI_PROVIDERS, PROVIDER_SPECS, normalizeCompatUrl, specFor } from "./providers.ts";
import { callbackPage, finishOAuth, startOAuth, supportsOAuth } from "./oauth.ts";
import type { RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { MAX_TASKS, Store, type BotRecord, type Message, type NewBotProfile } from "./store.ts";
import { addressees, BlokStore, MAX_MEMBERS, type BlokRecord } from "./bloks.ts";
import { extractTeamPlan, MAX_HIRES, normalizePlan, TEAM_PROTOCOL, type TeamPlan } from "./teams.ts";
import { houseStyle, HOUSE_STYLE } from "./house-style.ts";
import { bearerToken, isLocalRequest, isSameOrigin } from "./http-guard.ts";
import {
  bindHost,
  cancelPairing,
  claimPairing,
  deviceForToken,
  noteBound,
  pairingStatus,
  revokeAll,
  revokeDevice,
  remoteEnabled,
  setRemoteEnabled,
  startPairing,
} from "./pairing.ts";
import {
  clamp,
  clampList,
  MAX_BODY_BYTES,
  MAX_CUSTOM_ENDPOINTS,
  MAX_CUSTOM_KEYS,
  MAX_DESCRIPTION_CHARS,
  MAX_KEY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_NAME_CHARS,
  MAX_SKILL_CHARS,
  MAX_SKILLS,
  MAX_SSE_CLIENTS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from "./limits.ts";
import {
  describeAgentFile,
  fileNameFor,
  packAgent,
  parseAgentDocument,
  parseAgentFile,
  profileFromFile,
} from "./agent-transfer.ts";
import { deleteSkill, disclose, getSkills, installSkill, listSkills, skillsPrompt } from "./skills.ts";
import {
  CATALOG_TTL_MS,
  MAX_CATALOG_BYTES,
  REGISTRY_URL,
  listing,
  markFor,
  parseCatalog,
  updateCount,
  type RegistryEntry,
  hashBody,
} from "./skill-registry.ts";
import { AgentTokens, allows, capabilities, cliBriefing, runsAProcess } from "./agent-cli.ts";
import {
  COMPACT_AT,
  compactionNotice,
  contextLimitFor,
  isContextError,
  planCompaction,
  pressure,
  absorbPrompt,
  assembleTranscript,
  defragPrompt,
  needsDefrag,
  planMicro,
  shouldCompact,
  summaryPrompt,
  type Turn,
} from "./context.ts";
import { JobStore, nextFor, offerText, readClaim, type Candidate, type Job } from "./jobs.ts";
import { identityFor, forget as forgetIdentity, signAs, statementOf } from "./identity.ts";
import { assemble as assembleActivity, blockedOn } from "./activity.ts";
import { splitArgs } from "./argv.ts";
import { draftPrompt, parseDraft } from "./draft.ts";
import { cookieStores, readCookies } from "./cookie-import.ts";
import * as telegram from "./telegram.ts";
import { launch, listTargets, Session as CdpSession } from "./cdp.ts";
import { attribution, clamped, Ledger } from "./ledger.ts";
import {
  KINDS as COMPONENT_KINDS,
  extractComponents,
  galleryPrompt,
  mayRender,
  parseComponent,
  type ComponentKind,
} from "./components.ts";
import {
  FIELDS as POLICY_FIELDS,
  OPS as POLICY_OPS,
  PolicyStore,
  cleanRule,
  decide,
  describe as describeRule,
  Wheel,
  heldRefusal,
  pausedMessage,
  refusal,
  targetOf,
} from "./policy.ts";
import {
  ProposalStore,
  fingerprintOf,
  parseProposal,
  reviewPrompt,
  worthReviewing,
} from "./proposals.ts";
import {
  ProjectStore,
  briefFor,
  missingFolderMessage,
  workingFolder,
  type Project,
  type ProjectStanding,
} from "./projects.ts";
import { McpClient } from "./mcp-client.ts";
import {
  allowsTool,
  appsIn,
  documentIn,
  frameDocument,
  parseAppMessage,
  textOf,
  themeFrom,
} from "./mcp-apps.ts";
import { MAX_INPUT_BYTES, TerminalStore, clampCols, clampRows } from "./terminal.ts";
import { WebhookStore, webhookMessage } from "./webhooks.ts";
import {
  WorkflowStore,
  clean as cleanWorkflow,
  describe as describeWorkflow,
  fill as fillTemplate,
  firesOn,
  nextMove,
  problems as workflowProblems,
  scopeOf,
  timedOut,
  waitUntil,
  whereToAsk,
  type Workflow,
  type WorkflowRun,
} from "./workflows.ts";
import {
  destroySandbox,
  execInSandbox,
  provisionSandbox,
  sandboxStatus,
  stopSandbox,
} from "./local-sandbox.ts";
import {
  claimVm,
  configureVmLease,
  currentVmLease,
  releaseVm,
  touchVmIdle,
  vmCreate,
  vmMcpContract,
  vmPrepare,
  vmRemove,
  vmRunArgs,
  vmScreenshot,
  vmStatus,
  vmStop,
} from "./local-vm.ts";
import { widenPath } from "./path.ts";
import { describe as describeRoutine, MAX_ROUTINES, normalize as normalizeRoutine, nextScheduledAfter, RoutineStore } from "./routines.ts";
import { engineIsFresh, freshTurnText } from "./turn-context.ts";
import { summarize, UsageStore } from "./usage.ts";
import { TeamLibrary } from "./team-library.ts";
import * as artifacts from "./artifacts.ts";
import * as workspace from "./workspace.ts";
import * as speech from "./speech.ts";
import { speakable } from "./speech-text.ts";

const PORT = Number(process.env.BLOKS_PORT || 8799);
const STATIC_DIR = process.env.BLOKS_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// Sent with the packaged UI. Agents render text they were given by a
// model or a web page, so the page is pinned to its own origin: no
// remote script, no remote frame, and nothing to exfiltrate to.
// connect-src keeps the app's own API and its event stream.
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    // Vite inlines a small style block, and the theme sets colors inline
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Before anything spawns a CLI: a Finder-launched app inherits a PATH
// that has never heard of npm. See server/path.ts.
widenPath();
ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// What a brand new agent thinks with: whichever engine is actually
// usable, preferring Claude when there is a choice.
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
  return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
const bloks = new BlokStore();
const webhooks = new WebhookStore();
const artifactComments = new ArtifactCommentStore();
// Consequential actions, hash-chained. Nothing waits on it and nothing
// fails because of it: a record is worth having and never worth losing
// an action over.
const ledger = new Ledger();
// Shells, one per agent, in the folder that agent works in. Local only:
// see the route.
const terminals = new TerminalStore();
// Our own connection to a registered MCP server, for the app's sake
// rather than a turn's: an engine calls these servers during a turn and
// never shows us either side of it.
const mcp = new McpClient();
setInterval(() => mcp.sweep(Date.now()), 60_000).unref?.();
setInterval(() => terminals.sweep(Date.now()), 10 * 60 * 1000).unref?.();
const record = (draft: Parameters<Ledger["append"]>[0]) => void ledger.append(draft).catch(() => {});

/**
 * The same entry, with the agent's own signature on it.
 *
 * Unsigned when the key cannot be read, because an entry nobody signed is
 * still worth more than a missing entry: the record's job is to say what
 * happened, and the signature is the part that says who says so.
 */
function signed(botId: string, draft: Parameters<Ledger["append"]>[0]): Parameters<Ledger["append"]>[0] {
  try {
    // clamped first, because what gets written is the clamped entry and a
    // signature over the unclamped one would not hold over it
    const cut = clamped(draft);
    const { fingerprint } = identityFor(botId);
    const signature = signAs(botId, statementOf(cut));
    return signature ? { ...cut, by: { fingerprint, signature } } : cut;
  } catch {
    return draft;
  }
}
const jobs = new JobStore();
const projects = new ProjectStore();
const workflows = new WorkflowStore();
const proposals = new ProposalStore();
const policy = new PolicyStore();
const wheel = new Wheel();

/** A project with the disk's opinion of its folders attached. */
function standingOf(project: Project): ProjectStanding {
  const folderStates = project.folders.map((path) => ({ path, state: workspace.folderState(path) }));
  return { ...project, folderStates, broken: folderStates.some((f) => f.state !== "ok") };
}
// One credential per turn, so an agent can act on the workspace as
// itself. See server/agent-cli.ts for what that means and what it does
// not mean.
const agentTokens = new AgentTokens();
setInterval(() => agentTokens.sweep(Date.now()), 5 * 60_000).unref?.();
const AGENT_CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** The agent browser's debugging port. One browser serves every agent
 * that has one; profiles keep their sessions apart. */
const BROWSER_PORT = Number(process.env.BLOKS_BROWSER_PORT || 9222);

/**
 * The skill catalog, fetched and kept for a while.
 *
 * Held rather than re-fetched per request because browsing means several
 * requests in a row, and a registry that is asked forty times to render
 * one screen is a registry that will eventually be rate limited.
 */
let catalog: { at: number; entries: RegistryEntry[] } | null = null;

async function loadCatalog(force: boolean): Promise<RegistryEntry[]> {
  if (!force && catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries;
  const response = await fetch(process.env.BLOKS_SKILLS_URL || REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`the catalog answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error("that catalog is too large");
  const entries = parseCatalog(JSON.parse(text));
  catalog = { at: Date.now(), entries };
  return entries;
}

/** Installed skills, keyed for comparison against the catalog. */
function installedMarks() {
  const map = new Map<
    string,
    { body: string; source: "builtin" | "user"; registry?: string; version?: string; sha256?: string }
  >();
  for (const skill of listSkills()) {
    map.set(skill.id, {
      body: skill.body,
      source: skill.source,
      registry: skill.registry,
      version: skill.version,
      sha256: skill.sha256,
    });
  }
  return map;
}
const routines = new RoutineStore();
routines.settleOrphanRuns();
const usage = new UsageStore();
const teamLibrary = new TeamLibrary();
bootSelection = await defaultSelection();
store.seedIfEmpty();

/** An agent record as clients are allowed to see it. The resume cursors
 * are provider session identifiers: the server needs them to continue a
 * conversation, and nothing that renders a chat has any business holding
 * them. Once phones connect through the relay, anything in this shape
 * travels; keep it to what the interface actually draws. */
/**
 * Whether the two kinds of open card still have anybody behind them.
 *
 * A permission request is live while its turn can still hear the answer; a
 * workflow gate is live while its run is parked on it. Both go stale on a
 * restart, and a card nobody is listening to is not a card that wants a
 * person.
 */
function liveCards() {
  return {
    request: (requestId: string) => askThreadByRequest.has(requestId),
    run: (runId: string) => {
      const found = workflows.run(runId);
      if (!found || found.run.state !== "waiting" || !found.run.waiting) return null;
      return { until: found.run.waiting.until, name: found.workflow.name };
    },
  };
}

/**
 * A section name as the sidebar will show it. One rule for agents and
 * rooms, because they share the namespace: null or an empty string
 * clears the filing, whitespace collapses, and the cap keeps a heading
 * from becoming a paragraph.
 */
function normalizeSection(
  raw: unknown,
): { ok: true; section: string | null } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, section: null };
  if (typeof raw !== "string") return { ok: false, error: "a section is a short name" };
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: true, section: null };
  if (name.length > 60) return { ok: false, error: "section names top out at 60 characters" };
  return { ok: true, section: name };
}

function clientBot(bot: BotRecord | null) {
  if (!bot) return bot;
  const { resumeCursors: _cursors, tasks, ...visible } = bot;
  return {
    ...visible,
    // The public half of its key. Only ever the public half: the private
    // one never leaves this machine, and nothing in the app displays it.
    fingerprint: identityFor(bot.id).fingerprint,
    // Somebody is driving this one. On the agent rather than behind a
    // second poll, so every surface knows at the same moment and can say
    // so before the person hits a refusal they could have been shown
    // first. Null rather than absent, so a client can tell "not held"
    // from "an older harness that does not say".
    held: wheel.heldBy(bot.id),
    // lanes ship as summaries: state is derived here so every client
    // renders the same truth without holding every lane's transcript
    tasks: tasks.map((task) => {
      // A question only counts as waiting while its turn can still hear
      // the answer. A turn that errored out, or a server that restarted,
      // leaves the card on screen but nobody behind it; that lane is
      // idle, and saying otherwise sends the user to a dead door.
      // One rule for "is this waiting on me", shared with the activity
      // overlay (see server/activity.ts). Two rules is how a lane ends up
      // reading as idle in one place and blocked in another, which is
      // exactly what a workflow gate used to do: it parks on a card with
      // no request behind it, so the old test here called it idle.
      const state = blockedOn(store.messagesFor(task.id), liveCards())
        ? "needs-you"
        : task.busy
          ? "working"
          : "idle";
      // How full this lane is. The last turn's input tokens are the
      // closest thing a provider tells us, and the limit is what the
      // model will take: see server/context.ts.
      const limit = contextLimitFor(bot.modelSelection?.model);
      const fill = pressure(task.lastInput ?? 0, limit);
      return {
        id: task.id,
        title: task.title,
        state,
        createdAt: task.createdAt,
        usage: task.usage,
        context: {
          used: fill.used,
          limit: fill.limit,
          fraction: fill.fraction,
          summarised: Boolean(task.context),
        },
      };
    }),
  };
}

// ── pushing events to open clients ─────────────────────────────────────
const sseClients = new Set<ServerResponse>();

/** Every frame gets a sequence number, and the recent past stays in a
 * ring. A client that reconnects tells us the last number it saw; if the
 * gap still fits the ring it gets exactly the missed frames and skips the
 * full re-download, which is most reconnects on a phone. A gap the ring
 * cannot cover gets told so, honestly, and re-hydrates. */
let frameSeq = 0;
const RING_SIZE = 512;
const frameRing: Array<{ seq: number; frame: string }> = [];

function broadcast(payload: unknown) {
  const seq = ++frameSeq;
  const frame = `data: ${JSON.stringify({ ...(payload as object), _seq: seq })}\n\n`;
  // screen frames are megabytes of now-or-never pixels; replaying them
  // to a reconnecting phone would be all cost and no truth
  if ((payload as { kind?: string })?.kind !== "screen") {
    frameRing.push({ seq, frame });
    if (frameRing.length > RING_SIZE) frameRing.shift();
  }
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
  // and out to whatever phones are listening through the relay, sealed
  // per device. `wake` is the only thing the relay itself can read, and
  // it says nothing beyond "something happened that wants you". Screen
  // frames are skipped for the same reason they skip the ring: megabytes
  // of pixels the phone throws away, and a batch over the relay's cap is
  // dropped whole.
  if ((payload as { kind?: string })?.kind !== "screen") {
    relayLink.publish(payload, wakeReason(payload));
  }
}

/** Whether a frame is worth waking a sleeping phone for. Deliberately
 * narrow: a turn finishing is not worth a buzz, a turn blocked on a
 * human is exactly what the phone exists for. */
function wakeReason(payload: unknown): string | undefined {
  const p = payload as { kind?: string; requestType?: string } | null;
  if (p?.kind !== "message") return undefined;
  const message = (payload as { message?: { kind?: string; card?: { requestId?: string } } }).message;
  if (message?.kind === "options" && message.card?.requestId) return "needs-you";
  return undefined;
}

// ── turning events into a transcript ───────────────────────────────────
// Only one thing here is authoritative: the event stream. What lands on
// disk and what any client shows are both derived from it, which is why a
// transcript can be rebuilt after the fact and why no client is ever asked
// to reconstruct state it missed.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
/** Proposed teams awaiting the user's yes, by card message id. */
const teamPlans = new Map<string, { plan: TeamPlan; leadId: string }>();

/** The map above lives in memory, so a restart forgets it. The card is on
 * disk though, and it carries the whole plan, so an approval that arrives
 * after a restart still works. */
function recoverPlan(messageId: string, botId: string) {
  const bot = botId ? store.bot(botId) : null;
  if (!bot) return null;
  const card = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId)?.card;
  if (!card?.team || card.answered || card.dismissed) return null;
  const plan = normalizePlan(card.team);
  return plan ? { plan, leadId: bot.id } : null;
}

bus.subscribe((event: RuntimeEvent) => {
  broadcast({ kind: "runtime", event });
  const bot = store.botByThread(event.threadId);
  if (!bot) return;

  // The provider session belongs to a lane; the room is wherever that
  // lane is currently speaking.
  const roomId = activeRoom.get(event.threadId) ?? event.threadId;
  const inRoom = roomId !== event.threadId;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(roomId, inRoom ? { ...m, from: bot.id } : m);
    broadcast({ kind: "message", threadId: roomId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(event.threadId, event.providerInstanceId, event.sessionId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        // a lead may have proposed a team; the plan becomes a card the
        // user approves, never something that happens on its own
        const { plan, text: afterPlan } = extractTeamPlan(event.text);
        // Components an engine wrote into its own answer. The CLI is the
        // route for engines with a shell; this is the one for the rest,
        // so an API model can answer with a chart like anybody else.
        const { components, text } = extractComponents(afterPlan);
        if (text) pushMessage({ role: "bot", kind: "text", text: houseStyle(text) });
        for (const component of components) {
          if (!mayRender(component.kind, bot.withoutComponents)) continue;
          pushMessage({
            role: "bot",
            kind: "component",
            component: component as unknown as Record<string, unknown>,
          });
        }
        if (plan) {
          const card = pushMessage({
            role: "bot",
            kind: "options",
            card: {
              title: `Hire ${plan.members.length} agents for "${plan.room}"?`,
              subtitle: plan.members.map((m) => `${m.name}: ${m.title}`).join(" · "),
              options: ["Hire the team", "Not now"],
              team: plan,
            },
          });
          teamPlans.set(card.id, { plan, leadId: bot.id });
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(roomId, messageId, {
            tool: { name: store.messagesFor(roomId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: roomId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting, refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      // the agent asking for an app: plant sign-in cards and answer the
      // tool right away so the model can wrap up instead of blocking
      if (
        (event.tool === "request_connection" || event.tool === "request_secret") &&
        event.requestId
      ) {
        const answer =
          event.tool === "request_connection"
            ? plantConnectorCards(
                bot,
                roomId,
                event.requestId,
                (event.input as { apps?: unknown } | undefined)?.apps,
              )
            : plantSecretCard(
                bot,
                roomId,
                event.requestId,
                (event.input as { name?: unknown; hint?: unknown } | undefined) ?? {},
              );
        const instance = registry.get(bot.modelSelection.instanceId);
        void instance?.adapter
          .respondToRequest(event.threadId, event.requestId, { behavior: "answer", message: answer })
          .catch(() => {});
        break;
      }
      const permission = event.requestType === "permission";

      // Rules first, and only what they do not cover reaches a person.
      // Questions are never governed: an agent asking its owner something
      // is not an action, and a rule that answered it would be inventing
      // an answer. See server/policy.ts.
      if (permission && event.requestId) {
        // Somebody at the wheel outranks any rule, including an allow: the
        // point of taking over is that what the agent was about to do is
        // no longer what should happen.
        const hold = wheel.heldBy(bot.id);
        if (hold) {
          const instance = registry.get(bot.modelSelection.instanceId);
          void instance?.adapter
            .respondToRequest(event.threadId, event.requestId, {
              behavior: "deny",
              message: pausedMessage(hold),
            })
            .catch(() => {});
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: { name: "waiting: you have taken over this computer", ok: false },
          });
          break;
        }
        const target = targetOf(event.tool ?? "", (event.input as Record<string, unknown>) ?? {}, {
          botId: bot.id,
          agent: bot.name,
        });
        const decision = decide(policy.list(), target);
        if (decision.verdict !== "ask") {
          const allowed = decision.verdict === "allow";
          const instance = registry.get(bot.modelSelection.instanceId);
          void instance?.adapter
            .respondToRequest(event.threadId, event.requestId, {
              behavior: allowed ? "allow" : "deny",
              ...(allowed ? {} : { message: refusal(decision) }),
            })
            .catch(() => {});
          // Written down before the action runs, refusals included, and
          // signed by the agent it is about. A decision nobody was asked
          // about is the one most worth being able to look up later.
          record(
            signed(bot.id, {
              at: Date.now(),
              kind: "approval",
              actor: bot.name,
              summary: event.summary || event.tool || "an action",
              detail: {
                answer: allowed ? "allow" : "deny",
                decidedBy: "a rule",
                rule: decision.because,
                agent: bot.name,
              },
            }),
          );
          // Said in the lane too, or a refusal is a turn that quietly did
          // less than it was asked to.
          if (!allowed) {
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: { name: `a rule refused this: ${decision.because}`, ok: false },
            });
          }
          break;
        }

        // The agent's mode, after the rules. A deny rule has already
        // refused by here, so a mode can only widen what is allowed,
        // never reopen what a rule shut. "auto" waves everything
        // through; "edits" waves through the file-shaped tools and
        // cards the rest.
        const mode = bot.approvals ?? "ask";
        // File-shaped tools only, and named tightly: a bare "create"
        // would also match a connector's create_pull_request, which is
        // not an edit anyone meant to wave through.
        const editish = /edit|^write|_write|patch|str_replace|save_file|create_file|mkdir/i.test(
          event.tool ?? "",
        );
        if (mode === "auto" || (mode === "edits" && editish)) {
          const instance = registry.get(bot.modelSelection.instanceId);
          void instance?.adapter
            .respondToRequest(event.threadId, event.requestId, { behavior: "allow" })
            .catch(() => {});
          record(
            signed(bot.id, {
              at: Date.now(),
              kind: "approval",
              actor: bot.name,
              summary: event.summary || event.tool || "an action",
              detail: {
                answer: "allow",
                decidedBy: mode === "auto" ? "auto mode" : "edits mode",
                agent: bot.name,
              },
            }),
          );
          break;
        }
      }

      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your agent has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          // the tool rides along so the card can offer to remember the
          // answer as a rule
          ...(permission && event.tool ? { tool: event.tool } : {}),
        },
      });
      if (event.requestId) {
        askMessageByRequest.set(event.requestId, message.id);
        // answers must reach the lane that asked, not the active one
        askThreadByRequest.set(event.requestId, event.threadId);
      }
      // the chip turns amber the moment a lane needs a human
      broadcast({ kind: "bot", bot: clientBot(bot) });
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(roomId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          // The one thing in the product that is genuinely on your behalf:
          // an agent stopped, asked, and was told yes or no. Recorded with
          // who decided, because "the engine's own policy allowed it" and
          // "you allowed it" are different facts.
          if (existing.card.requestId) {
            // Signed by the agent that asked, so "Ivy asked to do this"
            // stops being a claim by whatever wrote the line and becomes
            // something a person can check afterwards.
            record(
              signed(bot.id, {
                at: Date.now(),
                kind: "approval",
                actor: bot.name,
                summary: existing.card.subtitle || existing.card.title,
                detail: {
                  answer: String(event.behavior ?? "unknown"),
                  decidedBy: event.source === "user" ? "you" : (event.source ?? "the engine"),
                  agent: bot.name,
                },
              }),
            );
          }
          const patched = store.patchMessage(roomId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: roomId, message: patched });
        }
        if (event.requestId) {
          askMessageByRequest.delete(event.requestId);
          askThreadByRequest.delete(event.requestId);
        }
      }
      broadcast({ kind: "bot", bot: clientBot(bot) });
      break;
    }
    case "thread.token-usage.updated": {
      usage.noteTokens(bot.id, event.providerInstanceId ?? event.provider, event.input, event.output);
      const high = turnTokens.get(event.threadId) ?? { input: 0, output: 0 };
      high.input = Math.max(high.input, event.input);
      high.output = Math.max(high.output, event.output);
      turnTokens.set(event.threadId, high);
      break;
    }
    case "runtime.error": {
      // The conversation being too big is the one failure this app should
      // fix rather than report. Our idea of a model's limit is a guess, so
      // when the provider disagrees, fold and try the same thing again
      // once. Only once: a second failure is not about length.
      if (isContextError(event.message) && !retriedForContext.has(event.threadId)) {
        retriedForContext.add(event.threadId);
        const said = [...store.messagesFor(event.threadId)]
          .reverse()
          .find((m) => m.role === "user" && m.kind === "text" && m.text && !m.deleted);
        void (async () => {
          const folded = await foldContext(bot.id, event.threadId, true).catch(() => false);
          if (folded && said?.text) {
            await startTurn(bot.id, said.text, { taskId: event.threadId, presetMessage: true }).catch(
              () => {},
            );
          } else {
            const notice = store.appendMessage(event.threadId, {
              role: "bot",
              kind: "notice",
              text: `This conversation is longer than ${bot.modelSelection.model} will take, and it could not be summarised. Starting a new task keeps this one readable.`,
            });
            broadcast({ kind: "message", threadId: event.threadId, message: notice });
          }
        })();
        break;
      }
      // Not a failed tool call: the turn itself could not run. It gets a
      // readable notice rather than a truncated mono chip, because the
      // message is usually instructions for the user.
      pushMessage({ role: "bot", kind: "notice", text: event.message.slice(0, 600) });
      break;
    }
    case "turn.completed": {
      usage.recordTurn(bot.id, event.providerInstanceId ?? event.provider, event.cost ?? null);
      const spent = turnTokens.get(event.threadId);
      turnTokens.delete(event.threadId);
      // only solo lanes tally; a room's spend belongs to no one lane.
      // solo turns map the lane to itself, room turns map it elsewhere
      const spoke = activeRoom.get(event.threadId);
      if (spent && (!spoke || spoke === event.threadId)) {
        store.addTaskUsage(event.threadId, spent.input, spent.output);
      }
      // the final frame stops being a live preview and becomes part of
      // the conversation
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      sweepArtifacts(bot.id, event.threadId, pushMessage);
      store.setTaskBusy(event.threadId, false);
      turnStarted.delete(event.threadId);
      // whatever the agent was given to act with is spent
      agentTokens.revokeTask(event.threadId);
      store.patchBot(bot.id, { unread: true });
      broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
      // A routine's run ends where its turn does, and its summary is
      // what the agent actually said: a row that only says "ok" answers
      // half the question people are asking.
      if (openRuns.has(event.threadId)) {
        const said = store.messagesFor(event.threadId);
        const reply = [...said]
          .reverse()
          .find((msg) => msg.role === "bot" && msg.kind === "text" && msg.text && !msg.deleted);
        closeRun(event.threadId, {
          ok: event.ok !== false,
          summary: reply?.text,
          error: event.ok === false ? (event.stopReason ?? "The turn did not finish.") : undefined,
        });
      }
      // A workflow's ask step ends where its turn does, and what the
      // agent actually said is the value the next step reads.
      const onBehalfOf = workflowTurns.get(event.threadId);
      if (onBehalfOf && workflows.run(onBehalfOf.runId)?.run.state === "running") {
        workflowTurns.delete(event.threadId);
        const said = lastSaid(event.threadId);
        if (event.ok === false) {
          // A turn stopped because somebody took the computer is not the
          // agent failing at the step. The run still fails, because the
          // alternative is resuming a plan made before the person
          // changed things, but it has to say who stopped it or it reads
          // as a crash.
          const why = wheel.heldBy(bot.id)
            ? `stopped: you took ${bot.name}'s computer`
            : (event.stopReason ?? "the turn did not finish");
          endStep(onBehalfOf.runId, onBehalfOf.stepId, "failed", { error: why });
          finishRun(onBehalfOf.runId, "failed", why);
        } else {
          endStep(onBehalfOf.runId, onBehalfOf.stepId, "ok", { summary: said });
          workflows.update(onBehalfOf.runId, (run) => {
            run.values[onBehalfOf.stepId] = { text: said };
            run.cursor++;
          });
          void advanceRun(onBehalfOf.runId).catch(() => {});
        }
      } else if (onBehalfOf) {
        // the run stopped while its turn was still going
        workflowTurns.delete(event.threadId);
      }
      retriedForContext.delete(event.threadId);
      // If this lane is filling up, fold its older half now rather than
      // on the way into the next turn, so nobody waits on a summary.
      if (shouldCompact(store.taskByThread(event.threadId)?.task.lastInput ?? 0, contextLimitFor(bot.modelSelection.model))) {
        void foldContext(bot.id, event.threadId).catch(() => {});
      } else {
        // Otherwise absorb one message into the running summary, if this
        // workspace asked for that. Deliberately in the else: a lane that
        // is already over the threshold wants the whole fold, not one
        // message at a time.
        void microFold(bot.id, event.threadId).catch(() => {});
      }
      // And read the session back, if this workspace asked for that. After
      // the fold on purpose: a review reads what is actually in the lane,
      // and a summarised lane is a smaller thing to read.
      void reviewForSkill(bot.id, event.threadId).catch(() => {});
      // A job ends where its turn does too, and whether the agent took it
      // or handed it back is in the same last thing they said.
      if (openJobs.has(event.threadId)) {
        const reply = [...store.messagesFor(event.threadId)]
          .reverse()
          .find((msg) => msg.role === "bot" && msg.kind === "text" && msg.text && !msg.deleted);
        settleJob(
          event.threadId,
          event.ok !== false,
          reply?.text ?? (event.stopReason ?? ""),
        );
      }
      drainSteer(event.threadId);
      // an agent that named someone else hands the room over to them
      if (inRoom) {
        const said = store.messagesFor(roomId);
        const last = [...said].reverse().find((m) => m.from === bot.id && m.kind === "text");
        if (last?.text) void relayMentions(roomId, bot.id, last.text);
      }
      activeRoom.delete(event.threadId);
      break;
    }
  }
});

// ── watching an agent's screen while it works ─────────────────────────
// While a turn is running its box is photographed on a timer and the
// frames go straight out to clients, which is what the computer panel
// renders. Whatever was on screen when the turn ended is kept and written
// into the transcript, so the chat shows how the work finished.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
>();

function startScreenPoller(botId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png, format } = await box.screenshotBox(cfg, botId);
      const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
      entry.last = frame;
      broadcast({ kind: "screen", botId, ...frame });
    } catch {
      /* asleep, or busy running something; the next tick can have it */
    } finally {
      inFlight = false;
    }
  };
  const entry = {
    timer: setInterval(capture, 4000),
    capture,
    last: null as Frame | null,
  };
  screenPollers.set(botId, entry);
}

/** Photograph it immediately rather than at the next tick. Called when
 * the agent has just done something, since that is exactly the moment the
 * picture changed and the moment someone is watching for it. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string): Frame | null {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  clearInterval(entry.timer);
  screenPollers.delete(botId);
  return entry.last;
}

// Local computer-use contract written by Electron main on startup
// (~/Library/Application Support/Bloks/cua-connection.json). Read
// fresh each turn, Electron may restart or permissions may change.
function readCuaConnection(): { command: string; args: string[]; env: Record<string, string> } | null {
  // new name first; pre-rename desktop builds used the old directory
  for (const dir of ["Bloks", "bloks"]) {
    try {
      const p = join(homedir(), "Library", "Application Support", dir, "cua-connection.json");
      const conn = JSON.parse(readFileSync(p, "utf8"));
      if (!conn || conn.mode === "unavailable" || !conn.mcpCommand) continue;
      return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/** Where each working agent is currently speaking. An agent's provider
 * session is keyed to the agent, so inbound events name the agent, not
 * the room; this is how a reply finds its way back to the right room. */
const activeRoom = new Map<string, string>(); // taskId -> blokId
/** Tokens of the turn in flight, per lane. Providers report a running
 * total for the turn, so this holds a high-water mark, popped when the
 * turn settles and folded into the lane's lifetime tally. */
const turnTokens = new Map<string, { input: number; output: number }>();
/** What the deliverables dir looked like when each lane's turn began. */
const artifactBaseline = new Map<string, Map<string, string>>();

/** New or changed deliverables since the lane's turn began become
 * artifact cards in whatever thread the turn was speaking to. */
function sweepArtifacts(
  botId: string,
  taskId: string,
  push: (m: Omit<Message, "id" | "at">) => Message,
) {
  const before = artifactBaseline.get(taskId);
  if (!before) return;
  artifactBaseline.delete(taskId);
  for (const info of artifacts.producedSince(botId, before)) {
    push({ role: "bot", kind: "artifact", artifact: info });
  }
}
/** The one live call. Two devices driving the same agents with two
 * microphones double-speaks every reply, so a call is a lease: claimed
 * with a token, renewed while it lasts, released on hang-up, and
 * self-expiring if the holder dies without saying goodbye. */
let activeCall: { token: string; device: string; targetId: string; expiresAt: number } | null = null;
const CALL_TTL_MS = 20_000;

function callConflict(token?: string): { device: string; targetId: string } | null {
  if (!activeCall) return null;
  if (activeCall.expiresAt < Date.now()) {
    activeCall = null;
    return null;
  }
  if (token && activeCall.token === token) return null;
  return { device: activeCall.device, targetId: activeCall.targetId };
}

/** Which lane raised a live ask, so the answer lands in the right one. */
const askThreadByRequest = new Map<string, string>();
/**
 * When each running turn began.
 *
 * Nothing else records it: a lane knows it is busy and when it was made,
 * neither of which answers "how long has this been going". A turn already
 * running before a restart is simply absent here, which reads as unknown
 * rather than as zero.
 */
const turnStarted = new Map<string, number>();

/** Highest seniority wins; ties break toward the earliest member listed. */
function leadOf(members: BotRecord[]): BotRecord | null {
  return members.reduce<BotRecord | null>(
    (best, m) => (!best || (m.seniority ?? 1) > (best.seniority ?? 1) ? m : best),
    null,
  );
}

/** The room brief an agent gets before it speaks: who else is here, who
 * decides, and how to address someone. */
function roomBriefing(blok: BlokRecord, speaker: BotRecord, members: BotRecord[]): string {
  const lead = leadOf(members);
  const roster = members
    .map((m) => {
      const tag = m.id === speaker.id ? " (you)" : "";
      const rank = m.id === lead?.id ? ", most senior" : "";
      return `- ${m.name}${tag}: ${m.title || "no stated role"}${rank}`;
    })
    .join("\n");

  const quoting =
    "When you answer a specific earlier point, quote it first as a markdown blockquote naming the speaker (> Name: their words), then respond below it. Quote only the line you are answering, never whole messages.";

  // This room works like a company, and that shapes cost as much as
  // quality: the lead runs the expensive model and spends it on judgement,
  // while the people doing volume run cheaper ones. So the lead delegates
  // and verifies rather than doing the legwork itself.
  const authority =
    lead?.id === speaker.id
      ? [
          "You are the most senior agent in this room, and you speak last.",
          "Your job is judgement, not volume: delegate the legwork to the right member with @Name, then check what comes back. Verify the substance rather than restating it. Look for what is wrong, missing, or asserted without evidence, and say so directly.",
          "When members disagree, make the call, state it plainly, and give the reason. Do not push the decision back to the user unless it is genuinely theirs.",
          "Do not do a member's task yourself when you can assign it. Your time is the expensive kind.",
          "When the work is done, give the user one short verdict: what you are shipping, what you changed, and anything still open.",
        ].join(" ")
      : lead
        ? [
            `${lead.name} is the most senior agent here and has the final say; your work goes to them for review.`,
            "Do the actual work rather than describing how you would do it. Produce the concrete thing that was asked for, note anything you could not verify, and keep it tight.",
            "Stay in your lane. Deliver your part of the brief and only your part; the other members are covering theirs, and duplicating their work wastes everyone's turn.",
            `End your turn by handing it over: @${lead.name} plus one line on what you did and anything you are unsure of.`,
            "Argue your case once if you disagree with the call, then follow it.",
          ].join(" ")
        : "";

  return [
    `You are in "${blok.name}", a shared room in Bloks. The user is here too, along with other agents.`,
    `Members:\n${roster}`,
    authority,
    quoting,
    "Speak only as yourself, in your own voice. Do not write other members' lines or summarize the room back to it. Keep contributions short; this is a conversation, not a report. Address someone directly with @Name.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The room's recent history, labelled so an agent can tell who said what. */
function roomTranscript(blokId: string, speakerId: string): string {
  const named = (m: Message) => {
    if (m.role === "user") return "User";
    const from = m.from ? store.bot(m.from) : null;
    return from ? (from.id === speakerId ? `${from.name} (you)` : from.name) : "Agent";
  };
  return store
    .messagesFor(blokId)
    .filter((m) => m.kind === "text" && m.text && !m.deleted && !m.queued)
    .slice(-30)
    .map((m) =>
      m.replyTo
        ? `${named(m)} (replying to ${m.replyTo.author}: "${m.replyTo.excerpt}"): ${m.text}`
        : `${named(m)}: ${m.text}`,
    )
    .join("\n");
}

// ── turn dispatch ──────────────────────────────────────────────────────
/**
 * `roomId` is where the reply lands. It defaults to the agent's own solo
 * thread; in a group it is the room's id. Either way the provider session
 * stays keyed to `bot.threadId`, which is what gives an agent continuous
 * memory across every room it works in.
 *
 * `hops` counts agent-triggered turns so a pair of agents cannot talk to
 * each other indefinitely.
 */
/** Reply context from the client, clamped: author and excerpt are
 * display strings, never trusted lookups. */
interface ReplyRef {
  id?: string;
  author: string;
  excerpt: string;
}

function replyRef(raw: any): ReplyRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const author = clamp(raw.author, 60);
  const excerpt = clamp(raw.excerpt, 200);
  if (!author || !excerpt) return undefined;
  return { ...(typeof raw.id === "string" ? { id: raw.id.slice(0, 40) } : {}), author, excerpt };
}

/** The lane background work (routines, webhooks) runs in. Reuses an
 * idle lane with this title, creates one when there is room, and only
 * falls back to the active lane at the lane cap. */
function backgroundTaskId(botId: string, title: string): string | undefined {
  const bot = store.bot(botId);
  if (!bot) return undefined;
  const named = bot.tasks.find((t) => t.title === title);
  if (named) return named.busy ? undefined : named.id;
  const active = bot.activeTaskId;
  const made = store.createTask(botId, title);
  if (made) {
    // creating a lane activates it, which background work must not do:
    // the user's screen stays on their own conversation
    store.setActiveTask(botId, active);
    broadcast({ kind: "bot", bot: clientBot(store.bot(botId)) });
    return made.id;
  }
  const fallback = bot.tasks.find((t) => !t.busy);
  return fallback?.id;
}

async function startTurn(
  botId: string,
  text: string,
  opts: {
    roomId?: string;
    hops?: number;
    replyTo?: ReplyRef;
    taskId?: string;
    /** One turn's answer to "where does this run", e.g. a routine that
     * wants the cloud computer regardless of the agent's own setting. */
    computerOverride?: "cloud" | "local" | "off";
    /** The user message is already in the transcript (a drained queue);
     * do not append it again. */
    presetMessage?: boolean;
  } = {},
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such agent"), { status: 404 });

  // Somebody at the wheel stops the agent, not just its questions.
  //
  // This used to be decided only at the permission checkpoint, which
  // meant a hold stopped an agent that asked and did nothing at all to
  // one that did not: an engine in a mode that never asks, a routine
  // firing at nine, a webhook, a job being taken, a room mention. Every
  // one of those arrives here, so here is where it is refused.
  //
  // Refused and not queued. A queue would replay, ten minutes later, a
  // plan the agent made before a person changed things underneath it,
  // and needing to change the plan is the whole reason to take over.
  // Checked before the busy check and before the engine lookup, so a
  // held agent says it is held rather than saying it is busy or that its
  // provider is missing.
  const hold = wheel.heldBy(bot.id);
  if (hold) {
    wheel.noteTurnedAway(bot.id);
    // The count rides on the agent, so a change to it is a change to the
    // agent. Without this the panel that reads bot.held shows the number
    // it happened to be at the last time anything else about the agent
    // moved, which for a hold on an idle agent is zero forever.
    broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
    throw Object.assign(new Error(heldRefusal(hold, bot.name)), { status: 409, held: true });
  }

  // An archived agent is retired, not deleted, so everything pointing at
  // it still exists: a routine, a webhook, a room it is in, a workflow
  // step naming it. Every one of those arrives here, and every one of
  // them fails loudly rather than quietly waking somebody who was put
  // away on purpose.
  if (bot.archivedAt) {
    throw Object.assign(new Error(`${bot.name} is archived. Restore it to give it work.`), {
      status: 409,
      archived: true,
    });
  }

  // the gate is the lane: other lanes keep their own turns running
  const task = bot.tasks.find((t) => t.id === (opts.taskId ?? bot.activeTaskId)) ?? bot.tasks[0];
  if (!task) throw Object.assign(new Error("no task lane on this agent"), { status: 500 });
  if (task.busy) {
    throw Object.assign(new Error("this task is already running, interrupt it or open another task"), {
      status: 409,
    });
  }

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable, pick another model in settings`),
      { status: 409 },
    );
  }

  // where the reply lands: the lane's own thread, or the shared room
  const roomId = opts.roomId ?? task.id;
  const blok = roomId === task.id ? null : bloks.get(roomId);
  // Who the agent is told it is working with, which is not the same as
  // who is on the roster. An archived member is still in the room so the
  // transcript stays legible, but telling a live agent to hand something
  // to it produces a handoff that is dropped with nothing written back.
  const members = blok
    ? (blok.memberIds.map((id) => store.bot(id)).filter(Boolean) as BotRecord[]).filter(
        (m) => !m.archivedAt,
      )
    : [];
  // keyed by the lane, so a room turn in one lane never bleeds messages
  // into a solo turn running in another
  activeRoom.set(task.id, roomId);

  // In a room the prompt already carries the labelled history, and the
  // triggering message is already on the record; only a solo chat writes
  // the user turn here.
  if (!blok && !opts.presetMessage) {
    const userMessage = store.appendMessage(roomId, {
      role: "user",
      kind: "text",
      text,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    broadcast({ kind: "message", threadId: roomId, message: userMessage });
  }

  // ── the transcript for API-backed drivers ──
  //
  // Engines that hold their own session get nothing here; the rest are
  // told the conversation every turn, and a conversation grows. This used
  // to be the last forty messages with the rest falling off the back,
  // which is the agent quietly forgetting an hour ago with nobody told.
  //
  // Now: everything since the last summary, trimmed to a real budget, with
  // the summary itself at the front. What does not fit is summarised
  // rather than dropped, which happens after the turn so nothing waits on
  // it, and lands in the thread as a message people can read.
  const contextLimit = contextLimitFor(bot.modelSelection.model);
  // leave room for the system prompt and the reply
  const transcriptBudget = Math.max(2_000, Math.floor(contextLimit * COMPACT_AT) - 4_000);
  const buildTranscript = (): { turns: Turn[]; dropped: number } => {
    if (blok) return { turns: [], dropped: 0 };
    const settled = store
      .messagesFor(roomId)
      .filter((m) => m.kind === "text" && m.text && !m.deleted)
      .map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        text: m.text!,
      }));
    return assembleTranscript(settled, task.context ?? null, transcriptBudget);
  };

  // The rule: anything that would fall out of the window gets summarised
  // rather than dropped. Comparing the trimmed transcript against the
  // limit would never fire, because trimming is what makes it fit, and
  // the trimming is exactly the silent forgetting this replaces.
  let built = buildTranscript();
  if (!blok && built.dropped > 0) {
    if (await foldContext(bot.id, task.id).catch(() => false)) built = buildTranscript();
  }
  const transcript = built.turns;

  // Skills are instructions, not decoration, they ship to the provider
  // as part of the standing system prompt, alongside whatever the user
  // told us about themselves in settings. Two kinds compose here: the
  // agent's own one-line skills, and full library skills it has attached.
  const attached = getSkills(bot.skillIds ?? []);
  const connectorHint = [
    cfg.composio?.key && bot.composio !== false
      ? "When a task needs an app the user has not connected yet (Slack, Gmail, GitHub, and so on), call the request_connection tool with the app slugs. A sign-in card appears in the chat; never paste sign-in or OAuth links into the conversation yourself."
      : null,
    "When a task needs an API key or other secret from the user, call the request_secret tool and they get a secure field in the chat; never ask for keys in plain conversation.",
  ]
    .filter(Boolean)
    .join(" ");
  const persona = [
    `You are ${bot.name}, a personal agent in Bloks.`,
    connectorHint,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
    bot.skills?.length &&
      `Your skills. Use them when the situation calls for one:\n${bot.skills
        .map((s) => `- ${s}`)
        .join("\n")}`,
    // Long skills are named here and read on demand, but only when this
    // engine gets a credential it could read them with. See the note in
    // server/skills.ts for why withholding one from an engine that cannot
    // fetch it would be losing the instruction rather than deferring it.
    skillsPrompt(
      disclose(attached, runsAProcess(instance.driverKind)),
      `To read one, run: node "${AGENT_CLI}" skill <id>`,
    ),
    // Every engine gets the gallery; only the route differs. One with a
    // shell calls the CLI. One without writes the component into its own
    // answer as a fenced block, which is the only shape a model with no
    // tools can reliably produce.
    galleryPrompt(
      bot.withoutComponents,
      runsAProcess(instance.driverKind)
        ? `To use one, run: node "${AGENT_CLI}" show <kind> '<json>'`
        : 'To use one, write it as a fenced block on its own:\n```bloks\n{ "kind": "table", ... }\n```',
    ),
    cfg.profile?.about?.trim() && `About the person you work for: ${cfg.profile.about.trim()}`,
    workspace.memoryPrompt(bot.id),
    `Deliverables: when you produce a file for the user (a report, web page, slide deck, spreadsheet, PDF, chart), save it to ${artifacts.artifactsDir(bot.id)} with a descriptive filename. Files saved there appear in the chat as cards the user can open in-app or download. HTML, PDF, images, CSV, XLSX, markdown and text all render in-app; for slide decks, save an HTML version alongside any .pptx so the deck is viewable in place.`,
    HOUSE_STYLE,
    // In a room, who else is here and who decides. Solo chats stay silent
    // about all of it.
    blok && roomBriefing(blok, bot, members),
    blok && `Recent conversation in this room:\n${roomTranscript(roomId, bot.id)}`,
    // only senior agents can ask for a team, and only outside a room, 
    // inside one they already have colleagues to delegate to
    !blok && (bot.seniority ?? 1) >= 3 && TEAM_PROTOCOL,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Asked again, because the checks above happened before a fold that
  // can take a model call of its own. Taking the wheel interrupts lanes
  // the driver already knows about, and a turn between the first check
  // and this line is in neither place: not yet registered, so nothing
  // interrupts it, and already past the gate, so nothing refuses it.
  const stillHeld = wheel.heldBy(bot.id);
  if (stillHeld) {
    wheel.noteTurnedAway(bot.id);
    broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
    throw Object.assign(new Error(heldRefusal(stillHeld, bot.name)), { status: 409, held: true });
  }

  // Mark it busy now, before any of the slow work, so the composer locks
  // the instant someone presses send. The dispatch itself is deliberately
  // not awaited: provisioning a box can take a minute and a half, and an
  // HTTP request must never be the thing holding that open.
  store.setTaskBusy(task.id, true);
  turnStarted.set(task.id, Date.now());
  store.patchBot(bot.id, { unread: false });
  artifactBaseline.set(task.id, artifacts.snapshot(bot.id));
  turnTokens.delete(task.id);
  broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });

  // a lane still wearing its default "Task N" name adopts the first
  // thing asked of it, kept very short so the strip reads like a to-do
  // list. General keeps its name; it is the conversation, not a task.
  if (!blok && /^Task \d+$/.test(task.title)) {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    let short = "";
    for (const word of words.slice(0, 3)) {
      const next = short ? `${short} ${word}` : word;
      if (next.length > 24) break;
      short = next;
    }
    short = (short || words[0].slice(0, 24)).replace(/[.,!?;:]+$/, "");
    if (short) store.patchTaskTitle(bot.id, task.id, short);
  }

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      // the key is workspace-wide, the grant is per agent
      if (cfg.composio?.key && bot.composio !== false) {
        integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      }
      const attached = (cfg.mcpServers ?? []).filter((server) =>
        (bot.mcpServers ?? []).includes(server.id),
      );
      if (attached.length) {
        integrations.mcpServers = attached.map(({ id: _id, ...rest }) => rest);
      }
      // cloud | sandbox | local | off | undefined(auto), with a per-turn
      // override taking precedence over the agent's own setting
      const wants = opts.computerOverride ?? bot.computer;
      // "sandbox" is the stored name for the Local VM: a Cua desktop in a
      // container on this machine, shared by all agents one at a time
      let vmTurn = false;
      if (wants === "sandbox") {
        if (!claimVm(task.id, bot.id)) {
          const holder = currentVmLease();
          const other = holder ? store.bot(holder.botId)?.name : null;
          throw new Error(
            other
              ? `the Local VM is in use by ${other} right now. Try again when their turn finishes`
              : "the Local VM is in use by another agent right now",
          );
        }
        const status = await vmStatus();
        const contract = status.ready ? await vmMcpContract() : null;
        if (!contract) {
          releaseVm(task.id);
          throw new Error(
            status.problem ?? "the Local VM is not ready. Set it up in Settings, under Local VM",
          );
        }
        integrations.localComputer = contract;
        vmTurn = true;
        touchVmIdle();
      }
      if (wants !== "off" && wants !== "local" && wants !== "sandbox" && box.boxConfigured(cfg)) {
        let b = await box.findBox(cfg, bot.id).catch(() => null);
        // the Computer driver runs ON the box, provision it on first use
        if (!b && instance.driverKind === "boxAgent") {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          await box.provisionBox(cfg, bot.id, bot.name);
          b = await box.findBox(cfg, bot.id).catch(() => null);
        }
        if (b) integrations.computer = { boxId: b.id, token: cfg.box!.token! };
      }
      // local computer (this Mac) via the Electron-hosted cua-driver: the
      // Electron main process owns the daemon (TCC attribution) and writes
      // its spawn contract to cua-connection.json; the harness only reads it
      if (!integrations.computer && wants !== "off" && wants !== "cloud" && wants !== "sandbox") {
        const cua = readCuaConnection();
        if (cua) integrations.localComputer = cua;
      }

      // A browser of its own, when the agent is allowed one. Separate
      // from the computer grant: an agent that should book a flight
      // does not also need the whole desktop, and the narrower tool is
      // the one to hand it. Off unless asked for, because a browser
      // starts a real process.
      if (bot.browser === true) {
        integrations.browser = {
          profileDir: join(DATA_DIR, "browser", bot.id),
          port: BROWSER_PORT,
        };
      }

      // A lane keeps the folder its first turn ran in: engines key
      // sessions to a directory, and a folder that shifts mid-session
      // breaks resume. Cloud turns run on the box, where a host path
      // means nothing, so they pin the lane to "default" explicitly.
      const onCloud = Boolean(integrations.computer) && instance.driverKind === "boxAgent";
      // A room's shared desk overrides each member's own folder: the
      // team works in one place. Pinned on the room's first dispatched
      // turn, and only by members that actually run on this host, so an
      // off-host engine speaking first never fixes a path it cannot see.
      const roomDesk = blok && !onCloud ? bloks.pinCwd(blok.id) : null;
      // A project the agent is on decides where its work happens, unless
      // the agent or the room has already said. Its folder is checked
      // rather than assumed: a project pointing at a directory that has
      // moved must stop, because an agent quietly writing into the wrong
      // place is harder to notice than one that refuses to start.
      const project = projects.forAgent(bot.id);
      let projectDesk: string | null = null;
      if (project && !onCloud) {
        const standing = standingOf(project);
        projectDesk = workingFolder(standing);
        if (standing.folders.length && !projectDesk) {
          const gone = standing.folderStates.filter((f) => f.state !== "ok").map((f) => f.path);
          const notice = store.appendMessage(roomId, {
            role: "bot",
            ...(blok ? { from: bot.id } : {}),
            kind: "notice",
            text: missingFolderMessage(project, gone),
          });
          broadcast({ kind: "message", threadId: roomId, message: notice });
          store.setTaskBusy(task.id, false);
          turnStarted.delete(task.id);
          broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
          return;
        }
      }
      const pinned = onCloud
        ? store.pinTaskCwd(task.id, null)
        : store.pinTaskCwd(task.id, roomDesk ?? bot.cwd ?? projectDesk ?? null);
      const turnCwd = onCloud ? undefined : (roomDesk ?? pinned ?? workspace.ensureWorkspace(bot.id));

      // A lane served by a different engine last time has a blind spot:
      // any cursor the new engine holds predates the other engine's
      // turns. Session-cursor engines get the story replayed inline;
      // API engines replay the transcript themselves every turn.
      const instanceId = bot.modelSelection.instanceId;
      const engineFresh =
        !blok &&
        engineIsFresh({
          instanceId,
          lastInstanceId: task.lastInstanceId,
          resumeCursors: task.resumeCursors,
          hasUserTurn: transcript.some((m) => m.role === "user"),
        });
      const nativeReplay = Boolean(instance.adapter.capabilities.replaysNatively);
      let turnText = opts.replyTo
        ? `(Replying to ${opts.replyTo.author}'s earlier message: "${opts.replyTo.excerpt}")\n\n${text}`
        : text;
      if (engineFresh && !nativeReplay) turnText = freshTurnText(transcript, turnText);

      // A credential of this agent's own, for this turn only. Given only
      // to engines that run a process, because a driver that talks to an
      // API over HTTP has nowhere to put it and no shell to use it from.
      const credential = runsAProcess(instance.driverKind)
        ? agentTokens.mint(bot.id, task.id, Date.now())
        : null;

      await instance.adapter.sendTurn({
        threadId: task.id,
        cwd: turnCwd,
        ...(credential
          ? {
              env: {
                BLOKS_URL: `http://127.0.0.1:${PORT}`,
                BLOKS_TOKEN: credential.token,
                BLOKS_CLI: AGENT_CLI,
              },
            }
          : {}),
        // its own workspace is always the agent's to edit: memory notes
        // must not queue approval cards behind a custom working folder
        ...(onCloud ? {} : { extraDirs: [workspace.ensureWorkspace(bot.id)] }),
        text: turnText,
        model: bot.modelSelection.model,
        effort: bot.effort,
        resumeCursor: engineFresh ? undefined : task.resumeCursors[instanceId],
        transcript,
        system:
          persona +
          (integrations.computer && instance.driverKind !== "boxAgent"
            ? " You have a machine of your own. Reach for the computer tools whenever a task is easier done than described: browsing, checking how something looks, or anything that wants a real desktop."
            : vmTurn
              ? " You have your own Linux desktop in a private VM on this machine. Reach for the computer tools whenever seeing or clicking beats describing: browsing, signing in, checking how something looks. The desktop is yours alone; files under ~/workspace survive the VM being recycled, everything else is disposable."
              : integrations.localComputer
                ? " The computer tools work this person's own Mac, so treat it as someone else's desk. Look before you touch: take a screenshot or read the current state first. Prefer naming what you want to act on over clicking at coordinates, since a coordinate that has shifted clicks something you did not intend. When an action would be hard to undo, ask first."
                : integrations.sandbox
                  ? " You have your own Linux sandbox: a persistent shell and filesystem at /work, isolated from this person's machine. Use sandbox_exec for anything a shell can do. There is no display, so nothing can be clicked or screenshotted; work in files and commands."
                  : "") +
          (credential ? `\n\n${cliBriefing(`node "${AGENT_CLI}"`)}` : "") +
          (project ? `\n\n${briefFor(project)}` : ""),
        integrations,
      });
      if (integrations.computer) startScreenPoller(bot.id);
      store.markTaskDispatched(bot.id, task.id, instanceId);
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      const failure = store.appendMessage(roomId, {
        role: "bot",
        ...(blok ? { from: bot.id } : {}),
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId: roomId, message: failure });
      sweepArtifacts(bot.id, task.id, (m) => {
        const message = store.appendMessage(roomId, blok ? { ...m, from: bot.id } : m);
        broadcast({ kind: "message", threadId: roomId, message });
        return message;
      });
      activeRoom.delete(task.id);
      store.setTaskBusy(task.id, false);
      turnStarted.delete(task.id);
      broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
      drainSteer(task.id);
    }
  })();
}

// ── rooms ─────────────────────────────────────────────────────────────
/**
 * How many agent-triggered turns may follow one human message. Without a
 * ceiling two agents that keep naming each other would talk forever, on
 * the user's tokens and without their attention.
 */
const MAX_AGENT_HOPS = 3;

/** Post into a room and wake whoever it was addressed to. */
/** One dispatch loop per room at a time; latecomers chain behind it. */
const roomPosting = new Map<string, Promise<unknown>>();

async function postToRoom(
  blok: BlokRecord,
  text: string,
  author: { botId?: string; hops: number; toAll?: boolean; replyTo?: ReplyRef },
) {
  return enqueueRoomPost(blok, text, author).completion;
}

function enqueueRoomPost(
  blok: BlokRecord,
  text: string,
  author: { botId?: string; hops: number; toAll?: boolean; replyTo?: ReplyRef },
) {
  if (!blok.memberIds.some((id) => store.bot(id))) {
    throw Object.assign(new Error("this room has no agents"), { status: 409 });
  }
  const previous = roomPosting.get(blok.id);
  const message = store.appendMessage(blok.id, {
    role: author.botId ? "bot" : "user",
    ...(author.botId ? { from: author.botId } : {}),
    kind: "text",
    text,
    queued: Boolean(previous),
    ...(author.replyTo ? { replyTo: author.replyTo } : {}),
  });
  broadcast({ kind: "message", threadId: blok.id, message });
  const run = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    const current = store.messagesFor(blok.id).find((m) => m.id === message.id);
    const room = bloks.get(blok.id);
    if (!room || !current || current.deleted) return message;
    if (current.queued) {
      const patched = store.patchMessage(blok.id, message.id, { queued: false });
      broadcast({ kind: "message.patch", threadId: blok.id, message: patched! });
    }
    return postToRoomNow(room, current.text ?? text, author, current);
  });
  roomPosting.set(blok.id, run);
  const cleanup = () => {
    if (roomPosting.get(blok.id) === run) roomPosting.delete(blok.id);
  };
  void run.then(cleanup, (error) => {
    cleanup();
    if (!bloks.get(blok.id)) return;
    const notice = store.appendMessage(blok.id, {
      role: "bot", kind: "notice",
      text: `This room message could not run: ${redactSecrets(String(error instanceof Error ? error.message : error)).slice(0, 200)}`,
    });
    broadcast({ kind: "message", threadId: blok.id, message: notice });
  });
  return { message, completion: run };
}

async function postToRoomNow(
  blok: BlokRecord,
  text: string,
  author: { botId?: string; hops: number; toAll?: boolean; replyTo?: ReplyRef },
  message: Message,
) {
  const members = blok.memberIds.map((id) => store.bot(id)).filter(Boolean) as BotRecord[];
  // Whether the room has anybody in it and whether anybody in it can
  // answer are two questions, and they used to be the same list. An
  // archived member keeps its place in the roster so the transcript
  // stays legible and restoring puts it back where it was, but nothing
  // wakes it. A room whose members are all archived still takes the
  // message: it is stored, nobody answers, which is the readable
  // tombstone this is for.
  if (!members.length) throw Object.assign(new Error("this room has no agents"), { status: 409 });
  const awake = members.filter((m) => !m.archivedAt);

  // Names resolve against everyone in the room, not only those who can
  // answer. addressees returns the whole list when nothing matched, so
  // naming an archived member against the awake list looked like naming
  // nobody, and a message meant for one retired agent woke the entire
  // room instead.
  const { ids, mentioned } = addressees(text, members);
  // An agent never wakes itself, and a message from an agent only reaches
  // someone it named, otherwise every reply would wake the whole room. The
  // exception is a kickoff brief, which is meant for everyone.
  let reach = !author.botId ? ids : author.toAll ? awake.map((m) => m.id) : mentioned ? ids : [];
  // A lead-only room narrows the unaddressed case to its most senior
  // member. Naming someone still reaches exactly who was named.
  if (blok.leadOnly && !author.botId && !mentioned) {
    // the most senior member who can actually answer, or a lead-only
    // room whose lead is archived swallows every message
    const lead = leadOf(awake);
    if (lead) reach = [lead.id];
  }
  const asked = reach.filter((id) => id !== author.botId);
  const targets = asked.filter((id) => !store.bot(id)?.archivedAt);
  // Somebody was named and cannot answer. Say so once, in the room,
  // rather than letting the room go quiet and read as broken.
  const retired = asked
    .filter((id) => store.bot(id)?.archivedAt)
    .map((id) => store.bot(id)!.name);
  if (mentioned && retired.length) {
    const notice = store.appendMessage(blok.id, {
      role: "bot",
      kind: "notice",
      text: `${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} archived and will not answer. Restore ${retired.length === 1 ? "it" : "them"} to bring ${retired.length === 1 ? "it" : "them"} back into the room.`,
    });
    broadcast({ kind: "message", threadId: blok.id, message: notice });
  }

  // While this loop runs, handoffs queue instead of firing. Otherwise the
  // lead would be pulled in the moment the first member reported, spend
  // its expensive turn on a third of the work, and get pulled in again for
  // each of the rest.
  const queue = new Map<string, string>();
  dispatching.set(blok.id, queue);
  try {
    await speakInTurn(
      blok.id,
      targets.map((id) => [id, text] as const),
      author.hops,
    );
    // whoever was named while the room was busy speaks now, and anyone
    // they name in turn goes round again until the chain runs out
    for (let round = 0; round < MAX_AGENT_HOPS && queue.size; round++) {
      const waiting = [...queue];
      queue.clear();
      await speakInTurn(blok.id, waiting, author.hops + round + 1);
    }
  } finally {
    dispatching.delete(blok.id);
  }
  return message;
}

/**
 * Juniors first, the most senior last. Answering in parallel would mean
 * nobody hears anybody: each agent would see only the room as it stood
 * when the batch started, and the senior agent could not make a final call
 * on input it never saw. Sequential is slower and worth it.
 */
async function speakInTurn(roomId: string, work: ReadonlyArray<readonly [string, string]>, hops: number) {
  const ordered = work
    .map(([id, text]) => [store.bot(id), text] as const)
    .filter((entry): entry is readonly [BotRecord, string] => entry[0] !== null && !entry[0].busy)
    .sort(([a], [b]) => (a.seniority ?? 1) - (b.seniority ?? 1));

  for (const [member, text] of ordered) {
    // one agent failing must not silence the rest of the room
    await startTurn(member.id, text, { roomId, hops }).catch((e) => sayTurnedAway(roomId, e));
    await waitForIdle(member.id);
  }
}

/**
 * Say that something tried to wake a held agent and was turned away.
 *
 * The callers that need this are the fire and forget ones, which swallow
 * every error so one agent failing cannot take a whole room down with
 * it. That is right for a failure and wrong for a refusal: a room that
 * simply goes quiet reads as the product being broken rather than as the
 * wheel being held.
 *
 * A notice, not a new message kind, so an older phone renders it as
 * readable prose rather than as a blank row.
 */
function sayTurnedAway(threadId: string, error: unknown): boolean {
  const refused = (error as { held?: boolean; archived?: boolean }) ?? {};
  if (!refused.held && !refused.archived) return false;
  const message = store.appendMessage(threadId, {
    role: "bot",
    kind: "notice",
    text: String((error as Error).message ?? "Somebody has the wheel."),
  });
  broadcast({ kind: "message", threadId, message });
  return true;
}

/**
 * A resume was refused rather than failing. Say so, and tell the caller
 * to put its "already resumed" mark back.
 *
 * A resume marks itself done before it starts, because the mark is the
 * only thing stopping it firing twice. That is right for a turn that
 * ran and wrong for one that was never allowed to: the task would sit
 * parked on a connection already made or a key already saved, with
 * nothing left that would ever pick it up.
 */
function unresume(threadId: string, error: unknown): boolean {
  const refused = (error as { held?: boolean; archived?: boolean }) ?? {};
  if (!refused.held && !refused.archived) return false;
  sayTurnedAway(threadId, error);
  return true;
}

/** Resolves once an agent's turn has settled, so the next speaker sees it. */
function waitForIdle(botId: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!store.bot(botId)?.busy || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  });
}

/** After an agent speaks, pass the room to anyone it named. */
async function relayMentions(roomId: string, fromBotId: string, text: string) {
  const blok = bloks.get(roomId);
  if (!blok) return;
  const hops = (agentHops.get(fromBotId) ?? 0) + 1;
  if (hops > MAX_AGENT_HOPS) return;

  const members = blok.memberIds.map((id) => store.bot(id)).filter(Boolean) as BotRecord[];
  const named = members.filter(
    (m) => m.id !== fromBotId && text.toLowerCase().includes(`@${m.name.toLowerCase()}`),
  );
  const queue = dispatching.get(roomId);
  for (const target of named) {
    agentHops.set(target.id, hops);
    // the room is mid-round: take a number rather than talk over it
    if (queue) {
      queue.set(target.id, text);
      continue;
    }
    if (store.bot(target.id)?.busy) continue;
    await startTurn(target.id, text, { roomId, hops }).catch((e) => sayTurnedAway(roomId, e));
  }
}

// ── the relay: this Mac, reachable from outside the house ─────────────
const relayLink = new RelayLink(PORT, (state) => broadcast({ kind: "relay", ...state }));
/** A Bloks Cloud licence, exactly as bloks.dev mints it. Kept here so
 * the shape is checked before anything is dialled: a mistyped key is the
 * ordinary case, and it should not cost a round trip or arrive back as
 * whatever the relay decided to call it. */
const CLOUD_KEY = /^blok_live_[0-9a-f]{32}$/;

/** Where an activation goes. A relay address already in the config wins,
 * so somebody running their own relay keeps running their own; the env
 * var is for a test or a staging box; bloks.dev is what everyone else
 * gets without configuring anything. */
function relayBase(): string {
  const url = cfg.relay?.url || process.env.BLOKS_RELAY_URL || "https://relay.bloks.dev";
  return url.trim().replace(/\/+$/, "");
}

function syncRelay() {
  // Pairing is the master switch. Turning pairing off is the documented
  // way to cut every remote device loose, and it must cut the relay too;
  // otherwise a relay phone keeps reaching the remote surface after the
  // owner believes they closed the door.
  const on =
    remoteEnabled() && cfg.relay?.enabled && cfg.relay.url && cfg.relay.agentToken;
  relayLink.configure(on ? { url: cfg.relay!.url!, agentToken: cfg.relay!.agentToken! } : null);
}
syncRelay();

// ── routines: work that happens without being asked ───────────────────
/**
 * Fires whatever is due. Two rules do most of the work here:
 *
 *   A busy target is left alone and retried on a later tick. Stacking a
 *   scheduled turn on top of one already running is worse than being a few
 *   minutes late, and the grace window in routines.ts is wide enough to
 *   cover a turn finishing.
 *
 *   `markRan` happens BEFORE dispatch, so a turn that takes longer than the
 *   tick interval cannot be started twice.
 */
/** Lanes with a routine run open on them, so the turn's ending can be
 * written back to the routine that started it. */
const openRuns = new Map<string, { routineId: string; runId: string }>();

/** Records what a finished turn should say about the run it belonged to,
 * and closes it. Called from the event fold on turn.completed, and on
 * the error path, because a routine that fails silently is the failure
 * mode this whole feature exists to end. */
/** Lanes that have already been folded and retried once for length. A
 * second failure is not about length, and a loop of retries would be a
 * loop of paid turns. Cleared when a turn completes. */
const retriedForContext = new Set<string>();

/** Job lanes with work in them, keyed the way routine runs are. */
const openJobs = new Map<string, string>();

/** Everyone the board may consider. */
function candidates(): Candidate[] {
  // Somebody at the wheel is not available for work, and neither is
  // somebody archived. Filtered here rather than caught at the offer,
  // because a refused offer finishes the job with an error, and either
  // of these should mean the job goes to the next candidate or waits on
  // the board, not that it dies.
  const free = store.bots.filter((bot) => !wheel.heldBy(bot.id) && !bot.archivedAt);
  return free.map((bot) => ({
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    skills: bot.skills,
    seniority: bot.seniority,
    hidden: bot.hidden,
  }));
}

/**
 * Put a job to whoever looks most suited, and start them on it.
 *
 * Returns the job as it now stands: claimed if somebody was given it,
 * open with nobody left if everyone has already been asked.
 */
async function offerJob(jobId: string): Promise<Job | null> {
  const job = jobs.get(jobId);
  if (!job || (job.state !== "open" && job.state !== "claimed")) return job;
  const agent = nextFor(job, candidates());
  if (!agent) {
    broadcast({ kind: "jobs" });
    return job;
  }
  const laneId = backgroundTaskId(agent.id, "Jobs");
  if (!laneId) {
    // their job lane is busy with the last one; leave it open rather than
    // queueing work behind work
    return job;
  }
  const claimed = jobs.offer(job.id, agent, laneId, Date.now());
  openJobs.set(laneId, job.id);
  broadcast({ kind: "jobs" });
  broadcast({ kind: "bot", bot: clientBot(store.bot(agent.id)) });
  await startTurn(agent.id, offerText(job), { taskId: laneId }).catch((e) => {
    openJobs.delete(laneId);
    jobs.finish(job.id, {
      ok: false,
      result: redactSecrets(e instanceof Error ? e.message : String(e)),
      now: Date.now(),
    });
    broadcast({ kind: "jobs" });
  });
  return claimed;
}

/**
 * A job lane's turn has ended. Whether that was the work being done or
 * the agent handing it back is in what they said.
 */
function settleJob(threadId: string, ok: boolean, said: string) {
  const jobId = openJobs.get(threadId);
  if (!jobId) return;
  openJobs.delete(threadId);
  const now = Date.now();
  if (!ok) {
    jobs.finish(jobId, { ok: false, result: said || "the turn did not finish", now });
    broadcast({ kind: "jobs" });
    return;
  }
  const claim = readClaim(said);
  if (claim.taken) {
    jobs.finish(jobId, { ok: true, result: claim.result, now });
    broadcast({ kind: "jobs" });
    return;
  }
  // handed back: it is open again, and the next candidate gets it
  jobs.passed(jobId, claim.because, now);
  broadcast({ kind: "jobs" });
  void offerJob(jobId);
}

/**
 * Fold the older half of a lane into a summary.
 *
 * Runs after a turn rather than before one, so nobody waits on it, and it
 * uses the same engine the lane runs on. If the summary cannot be made,
 * nothing changes: the next turn sends a slightly-too-long transcript and
 * the provider says so, which is recoverable. Losing the messages instead
 * would not be.
 */
async function foldContext(botId: string, threadId: string, force = false): Promise<boolean> {
  const bot = store.bot(botId);
  const task = bot?.tasks.find((t) => t.id === threadId);
  if (!bot || !task) return false;
  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance?.generateText) return false;

  const settled = store
    .messagesFor(threadId)
    .filter((m) => m.kind === "text" && m.text && !m.deleted);
  const already = task.context?.through ?? 0;
  const carried = settled.slice(already);
  const asTurns: Turn[] = carried.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: m.text!,
  }));
  const limit = contextLimitFor(bot.modelSelection.model);
  // Normally the budget is our own estimate of what fits. When the
  // provider has already refused the request, our estimate has been shown
  // to be wrong and its word is the one that counts, so fold hard: keep
  // the last exchange and summarise the rest.
  const budget = force ? 1 : Math.max(2_000, Math.floor(limit * COMPACT_AT) - 4_000);
  const plan = planCompaction(asTurns, budget, force ? 2 : 6);
  if (!plan.fold.length) return false;

  let summary: string;
  try {
    summary = (await instance.generateText(summaryPrompt(task.context?.summary ?? null, plan.fold))).trim();
  } catch {
    return false;
  }
  if (!summary) return false;

  store.setTaskContext(threadId, {
    summary: summary.slice(0, 8_000),
    through: already + plan.fold.length,
    at: Date.now(),
  });
  // a normal state, said plainly, in the thread it happened in
  const notice = store.appendMessage(threadId, {
    role: "bot",
    kind: "notice",
    text: compactionNotice(plan.fold.length),
  });
  broadcast({ kind: "message", threadId, message: notice });
  broadcast({ kind: "bot", bot: clientBot(store.bot(botId)) });
  return true;
}

/**
 * Absorb one message into a lane's running summary.
 *
 * Runs after a turn settles rather than before the next one starts, so
 * nobody waits on it, and takes exactly one message so the cost of a pass
 * never grows with the conversation. See server/context.ts for the two
 * rules that make it worth having and for what it trades.
 *
 * Quiet on every failure. A pass that does not happen is a lane that
 * compacts the old way later, which is the behaviour this defers rather
 * than replaces.
 */
async function microFold(botId: string, threadId: string): Promise<boolean> {
  if (!cfg.compaction?.micro) return false;
  const bot = store.bot(botId);
  const task = bot?.tasks.find((t) => t.id === threadId);
  if (!bot || !task) return false;
  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance?.generateText) return false;

  const settled = store
    .messagesFor(threadId)
    .filter((m) => m.kind === "text" && m.text && !m.deleted);
  const asTurns: Turn[] = settled.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: m.text!,
  }));

  const through = task.context?.through ?? 0;
  const plan = planMicro(asTurns, through);
  if (plan.through === through) return false;

  // Where micro-compaction took over. Fixed the first time it moves, so a
  // lane that folded the old way first keeps that part fully summarised.
  const microFrom = task.context?.microFrom ?? through;
  let summary = task.context?.summary ?? "";

  if (plan.absorb) {
    try {
      summary = (await instance.generateText(absorbPrompt(summary || null, plan.absorb))).trim();
    } catch {
      return false;
    }
    if (!summary) return false;
  }

  // A summary that has grown baggy is the problem it was meant to solve.
  if (needsDefrag(summary)) {
    try {
      const tighter = (await instance.generateText(defragPrompt(summary))).trim();
      if (tighter) summary = tighter;
    } catch {
      /* keep the baggy one; it is still a summary */
    }
  }

  store.setTaskContext(threadId, {
    summary: summary.slice(0, 8_000),
    through: plan.through,
    at: Date.now(),
    microFrom,
  });
  broadcast({ kind: "bot", bot: clientBot(store.bot(botId)) });
  return true;
}

/**
 * Read a finished session back, and stage a skill if it taught one.
 *
 * Two gates before anything is spent. The workspace has to have asked for
 * this at all, and the session has to look like it taught something: this
 * costs the person a model call on work they did not request, so an
 * ordinary exchange must not trigger one. See server/proposals.ts.
 *
 * What comes back is staged and never installed. That is the whole shape
 * of the feature, and the reason it is safe to run unattended.
 */
async function reviewForSkill(botId: string, threadId: string): Promise<boolean> {
  if (!cfg.skills?.propose) return false;
  const bot = store.bot(botId);
  if (!bot) return false;
  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance?.generateText) return false;

  const turns: Turn[] = store
    .messagesFor(threadId)
    .filter((m) => m.kind === "text" && m.text && !m.deleted)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      text: m.text!,
    }));

  if (!worthReviewing(turns, proposals.seenFor(threadId)).worth) return false;

  // Only skills a person could actually change are offered as targets: a
  // bundled one cannot be patched, so proposing a patch to it would be a
  // suggestion nobody can accept.
  const mine = listSkills().filter((s) => s.source === "user");
  let answer: string;
  try {
    answer = await instance.generateText(reviewPrompt(turns, mine.map((s) => ({ id: s.id, name: s.name }))));
  } catch {
    return false;
  }

  const parsed = parseProposal(answer);
  if (!parsed) return false;

  let skillId: string | undefined;
  let overwritesEdits = false;
  if (parsed.kind === "patch") {
    const target = mine.find((s) => s.id === parsed.skillId);
    // a patch to something that is not there, or that cannot be edited,
    // is a suggestion nobody can accept; take it as a new skill instead
    if (target) {
      skillId = target.id;
      // Item 15 already knows whether this has been edited here. Saying
      // so is what keeps approving a choice rather than a formality.
      overwritesEdits = Boolean(target.sha256 && hashBody(target.body) !== target.sha256);
    }
  }

  const staged = proposals.add({
    kind: skillId ? "patch" : "new",
    botId,
    botName: bot.name,
    threadId,
    ...(skillId ? { skillId } : {}),
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    because: parsed.because,
    at: Date.now(),
    fingerprint: fingerprintOf(turns),
    ...(overwritesEdits ? { overwritesEdits } : {}),
  });
  if (!staged) return false;
  broadcast({ kind: "skills" });
  return true;
}

function closeRun(threadId: string, outcome: { ok: boolean; summary?: string; error?: string }) {
  const open = openRuns.get(threadId);
  if (!open) return;
  openRuns.delete(threadId);
  routines.endRun(open.routineId, open.runId, {
    state: outcome.ok ? "ok" : "failed",
    summary: outcome.summary,
    error: outcome.error,
  });
  // Work that happened without anyone asking for it, which is exactly the
  // kind a person wants an account of afterwards.
  const routine = routines.get(open.routineId);
  record({
    at: Date.now(),
    kind: "routine.ran",
    actor: routine?.name || "a routine",
    summary: outcome.ok
      ? `Ran ${routine?.name || "a routine"}`
      : `${routine?.name || "A routine"} failed`,
    detail: {
      outcome: outcome.ok ? "ok" : "failed",
      ...(routine?.time ? { at: routine.time } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  });
  broadcast({ kind: "routines" });
}

// ── workflows: more than one step, and a place to say yes ─────────────
// See server/workflows.ts for the shape and for why a run is state on
// disk rather than a promise chain. This is the part that moves it: one
// function that takes a run from wherever it is to wherever it stops, and
// three ways back into it (a turn finishing, a person answering, a
// deadline passing) that all end up calling the same function.

/** Lanes whose turn a workflow run is waiting on, so turn.completed can
 * find the run that asked for it. */
const workflowTurns = new Map<string, { runId: string; stepId: string }>();

/**
 * Runs being advanced right now.
 *
 * advanceRun awaits real work in the middle of its loop, and the tick
 * that rescues stalled runs can fire during that await. Without this, one
 * run would be walked by two callers and a step would happen twice.
 */
const advancing = new Set<string>();

/** A run left mid-flight by a quit has no turn behind it any more. One
 * that was waiting is left exactly as it was, which is the entire point
 * of parking it on disk. */
const orphaned = workflows.settleOrphanRuns(Date.now());
if (orphaned) console.log(`[bloks] settled ${orphaned} workflow run(s) left running by a restart`);

function endStep(
  runId: string,
  stepId: string,
  state: "ok" | "failed" | "timed-out",
  outcome: { summary?: string; error?: string } = {},
) {
  workflows.update(runId, (run) => {
    const step = [...run.steps].reverse().find((s) => s.stepId === stepId && !s.endedAt);
    if (!step) return;
    step.state = state;
    step.endedAt = Date.now();
    if (outcome.summary) step.summary = outcome.summary.slice(0, 300);
    if (outcome.error) step.error = outcome.error.slice(0, 300);
  });
}

function finishRun(runId: string, state: "done" | "failed" | "stopped", error?: string) {
  const found = workflows.run(runId);
  if (!found || found.run.state === state) return;
  workflows.update(runId, (run) => {
    run.state = state;
    run.endedAt = Date.now();
    run.cursor = found.workflow.steps.length;
    delete run.waiting;
    if (error) run.error = error.slice(0, 300);
  });
  const workflow = found.workflow;
  const ran = found.run.steps.filter((s) => s.state === "ok").length;
  record({
    at: Date.now(),
    kind: "workflow.ran",
    actor: workflow.name,
    summary:
      state === "done"
        ? `Ran ${workflow.name}`
        : state === "stopped"
          ? `${workflow.name} stopped: ${error ?? "an approval was declined"}`
          : `${workflow.name} failed`,
    detail: {
      outcome: state,
      steps: ran,
      trigger: workflow.trigger.kind,
      ...(error ? { error } : {}),
    },
  });
  broadcast({ kind: "workflows" });
}

/** The last thing an agent actually said in a lane, which is what a step
 * hands on to the next one. A row that only says "ok" answers half the
 * question people are asking. */
function lastSaid(threadId: string): string {
  const said = [...store.messagesFor(threadId)]
    .reverse()
    .find((msg) => msg.role === "bot" && msg.kind === "text" && msg.text && !msg.deleted);
  return said?.text ?? "";
}

/**
 * Take a run as far as it can go.
 *
 * Returns when the run finishes, or when it is parked on something that
 * will call back in: an agent's turn, or a person. Every pause writes
 * itself down first, so the way back in is always "load the run and
 * advance it" rather than a continuation somebody has to keep alive.
 */
async function advanceRun(runId: string): Promise<void> {
  if (advancing.has(runId)) return;
  advancing.add(runId);
  try {
    await walkRun(runId);
  } finally {
    advancing.delete(runId);
  }
}

async function walkRun(runId: string): Promise<void> {
  for (;;) {
    const found = workflows.run(runId);
    if (!found) return;
    const { workflow, run } = found;
    if (run.state !== "running") return;

    const move = nextMove(workflow, run);
    if (move.kind === "done") {
      finishRun(runId, "done");
      return;
    }
    if (move.kind === "skip") {
      const at = Date.now();
      workflows.update(runId, (r) => {
        r.steps.push({ stepId: move.step.id, startedAt: at, endedAt: at, state: "skipped" });
        r.cursor++;
      });
      broadcast({ kind: "workflows" });
      continue;
    }

    const step = move.step;
    const text = fillTemplate(step.text, scopeOf(run)).trim();
    workflows.update(runId, (r) => {
      r.steps.push({ stepId: step.id, startedAt: Date.now(), state: "running" });
    });
    broadcast({ kind: "workflows" });

    try {
      if (step.action === "post") {
        const blok = step.targetId ? bloks.get(step.targetId) : null;
        if (!blok) throw new Error("that room is not there any more");
        if (!text) throw new Error("there was nothing left to say once the values were filled in");
        await postToRoom(blok, text, { hops: 0 });
        endStep(runId, step.id, "ok", { summary: text });
        workflows.update(runId, (r) => {
          r.values[step.id] = { text };
          r.cursor++;
        });
        broadcast({ kind: "workflows" });
        continue;
      }

      if (step.action === "ask") {
        const bot = step.targetId ? store.bot(step.targetId) : null;
        if (!bot) throw new Error("that agent is not here any more");
        if (!text) throw new Error("there was nothing left to ask once the values were filled in");
        const laneId = backgroundTaskId(bot.id, "Workflows");
        // A busy lane is a wait, not a failure. The step row is taken
        // back off so the history does not fill with attempts, the run
        // stays running, and the tick finds it again in half a minute.
        if (!laneId) {
          workflows.update(runId, (r) => {
            const at = r.steps.findIndex((sp) => sp.stepId === step.id && !sp.endedAt);
            if (at >= 0) r.steps.splice(at, 1);
          });
          return;
        }
        // Registered before the turn starts, because the turn can finish
        // before this line returns. Taken back if it never started, or a
        // later unrelated turn in that lane would be read as this step's
        // answer and walk a run that has already stopped.
        workflowTurns.set(laneId, { runId, stepId: step.id });
        try {
          await startTurn(bot.id, text, { taskId: laneId });
        } catch (e) {
          workflowTurns.delete(laneId);
          throw e;
        }
        // the rest happens in turn.completed
        return;
      }

      // ── the gate ──
      // Everything needed to pick this up again goes on disk before the
      // card is even drawn, so a quit between the two leaves a run that
      // is waiting rather than a run that is lost.
      const where = whereToAsk(workflow, move.index);
      if (!where) throw new Error("this approval has nowhere to ask");
      const threadId =
        where.kind === "room"
          ? (bloks.get(where.id)?.id ?? "")
          : (store.bot(where.id)?.threadId ?? "");
      if (!threadId) throw new Error("the place this was going to ask is gone");

      const until = waitUntil(step, Date.now());
      const card = store.appendMessage(threadId, {
        role: "bot",
        kind: "options",
        card: {
          title: text.slice(0, 200) || `${workflow.name} needs your say-so`,
          subtitle: `${workflow.name} is waiting on this. ${
            step.onTimeout === "continue"
              ? `It stops waiting and carries on ${friendlyWhen(until)}.`
              : `It stops if nobody answers ${friendlyWhen(until)}.`
          }`,
          options: ["Approve", "Decline"],
          runId,
        },
      });
      workflows.update(runId, (r) => {
        r.state = "waiting";
        r.waiting = {
          stepId: step.id,
          threadId,
          messageId: card.id,
          until,
          onTimeout: step.onTimeout ?? "stop",
        };
      });
      workflows.update(runId, (r) => {
        const open = [...r.steps].reverse().find((sp) => sp.stepId === step.id && !sp.endedAt);
        if (open) open.state = "waiting";
      });
      broadcast({ kind: "message", threadId, message: card });
      broadcast({ kind: "workflows" });
      return;
    } catch (e) {
      const why = redactSecrets(e instanceof Error ? e.message : String(e));
      endStep(runId, step.id, "failed", { error: why });
      finishRun(runId, "failed", why);
      return;
    }
  }
}

/** "in about 3 hours", "tomorrow", for a deadline on a card. */
function friendlyWhen(at: number): string {
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60_000));
  if (minutes < 90) return `in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `in about ${days} ${days === 1 ? "day" : "days"}`;
}

/** A person answered the card a run was parked on. */
function answerGate(runId: string, approved: boolean, answer: string) {
  const found = workflows.run(runId);
  if (!found || found.run.state !== "waiting" || !found.run.waiting) return false;
  const { stepId } = found.run.waiting;
  endStep(runId, stepId, "ok", { summary: answer });
  workflows.update(runId, (run) => {
    run.values[stepId] = { answer, approved: approved ? "yes" : "no" };
    delete run.waiting;
    run.cursor++;
    run.state = "running";
  });
  if (!approved) {
    // A decline ends the run rather than skipping one step. The gate is
    // there to stop what comes after it, and "no" that only skipped the
    // next line would be the opposite of what the person meant.
    const said = answer.trim().toLowerCase();
    const plain = !said || said === "decline" || said === "declined" || said === "no";
    finishRun(runId, "stopped", plain ? "you declined" : `you declined: ${answer}`);
    return true;
  }
  void advanceRun(runId).catch(() => {});
  return true;
}

/**
 * Approvals whose time is up.
 *
 * Stopping is the default and the honest one: nobody answering is not
 * consent. Carrying on is available for the gates that are a courtesy
 * rather than a decision, and it is the workflow's own choice, made when
 * it was written rather than when the clock ran out.
 */
function settleTimeouts() {
  for (const run of timedOut(workflows.waiting(), Date.now())) {
    const waiting = run.waiting!;
    endStep(run.id, waiting.stepId, "timed-out", { error: "nobody answered in time" });
    // the card stops asking, so nobody answers a question that has closed
    const existing = store.messagesFor(waiting.threadId).find((m) => m.id === waiting.messageId);
    if (existing?.card && !existing.card.answered) {
      const patched = store.patchMessage(waiting.threadId, waiting.messageId, {
        card: { ...existing.card, answered: "no answer in time", dismissed: true },
      });
      if (patched) broadcast({ kind: "message.patch", threadId: waiting.threadId, message: patched });
    }
    workflows.update(run.id, (r) => {
      r.values[waiting.stepId] = { answer: "", approved: "no" };
      delete r.waiting;
      r.cursor++;
      r.state = "running";
    });
    if (waiting.onTimeout === "continue") void advanceRun(run.id).catch(() => {});
    else finishRun(run.id, "stopped", "nobody answered in time");
  }
}

/** A workflow with its one-line description, which every route that
 * hands one back should carry: the list and the thing just saved should
 * not read differently. */
const withSummary = (workflow: Workflow) => ({ ...workflow, summary: describeWorkflow(workflow) });

/**
 * Runs still in flight when their workflow's steps were rewritten.
 *
 * Said out loud rather than settled silently: somebody who edits a
 * workflow while it is waiting on them should be told the run stopped,
 * because the alternative is a card in the chat that answers nothing.
 */
function stopRunsOnEdit(workflowId: string) {
  const workflow = workflows.get(workflowId);
  if (!workflow) return;
  for (const run of [...(workflow.runs ?? [])]) {
    if (run.state !== "running" && run.state !== "waiting") continue;
    const waiting = run.waiting;
    if (waiting) {
      const card = store.messagesFor(waiting.threadId).find((m) => m.id === waiting.messageId);
      if (card?.card && !card.card.answered) {
        const patched = store.patchMessage(waiting.threadId, waiting.messageId, {
          card: { ...card.card, answered: "the workflow changed", dismissed: true },
        });
        if (patched) broadcast({ kind: "message.patch", threadId: waiting.threadId, message: patched });
      }
      endStep(run.id, waiting.stepId, "failed", { error: "the workflow was edited" });
      workflows.update(run.id, (r) => {
        delete r.waiting;
      });
    }
    finishRun(run.id, "stopped", "the workflow was edited while this was running");
  }
}

/** Start a workflow, if it is one that may start. */
function fireWorkflow(workflowId: string, trigger: Record<string, string>): WorkflowRun | null {
  const workflow = workflows.get(workflowId);
  if (!workflow) return null;
  const run = workflows.begin(workflowId, trigger, Date.now());
  if (!run) return null;
  broadcast({ kind: "workflows" });
  void advanceRun(run.id).catch(() => {});
  return run;
}

/**
 * Something happened somewhere; start whatever was watching for it.
 *
 * Deliberately cheap and deliberately silent: this runs on the way
 * through every message and every reaction, and a workflow that does not
 * match should cost a comparison rather than anything else.
 */
function triggersFired(event: {
  kind: "message" | "reaction";
  targetId: string;
  text?: string;
  emoji?: string;
  fromUser: boolean;
}) {
  for (const workflow of workflows.watching(event.targetId)) {
    if (!firesOn(workflow.trigger, event)) continue;
    fireWorkflow(workflow.id, {
      text: event.text ?? "",
      emoji: event.emoji ?? "",
      from: event.fromUser ? "you" : "an agent",
    });
  }
}

/**
 * Runs that are running but that nothing is driving.
 *
 * The ordinary cause is an agent that was mid-turn when a step wanted it:
 * that step backs off rather than failing, and this is what comes back
 * for it. It also catches anything else that leaves a run without a way
 * back in, which is the failure mode worth having a net under, because a
 * run stuck at "running" forever looks exactly like a run still working.
 */
function resumeStalled() {
  const inFlight = new Set([...workflowTurns.values()].map((held) => held.runId));
  for (const workflow of workflows.workflows) {
    for (const run of workflow.runs ?? []) {
      if (run.state !== "running" || inFlight.has(run.id) || advancing.has(run.id)) continue;
      void advanceRun(run.id).catch(() => {});
    }
  }
}

// Every 30s, like the routine tick, and for the same reason: a deadline
// measured in hours does not need a finer clock than this.
const workflowTimer = setInterval(() => {
  settleTimeouts();
  resumeStalled();
}, 30_000);
workflowTimer.unref?.();
// And once shortly after boot. A deadline that passed while the app was
// closed is still a deadline that passed: the alternative is a gate that
// expired overnight and sits there looking live until the first tick.
setTimeout(() => {
  settleTimeouts();
  resumeStalled();
}, 2_000).unref?.();

async function runDueRoutines() {
  const now = new Date();
  for (const routine of routines.due(now)) {
    if (routine.targetKind === "room") {
      const blok = bloks.get(routine.targetId);
      if (!blok) {
        routines.remove(routine.id);
        continue;
      }
      const members = blok.memberIds.map((id) => store.bot(id)).filter(Boolean) as BotRecord[];
      if (members.some((m) => m.busy)) continue;
      // The same rule as the agent branch, which this one did not have:
      // a room where nobody can answer is not a run that happened. It
      // used to post, mark itself run and report success, which burns a
      // "once" routine on an empty room.
      if (!members.some((m) => !m.archivedAt && !wheel.heldBy(m.id))) continue;
      routines.markRan(routine.id, now.getTime());
      const run = routines.beginRun(routine.id, blok.id);
      if (run) openRuns.set(blok.id, { routineId: routine.id, runId: run.id });
      broadcast({ kind: "routines" });
      void postToRoom(blok, routine.prompt, { hops: 0 })
        .then(() => closeRun(blok.id, { ok: true, summary: "Posted to the room." }))
        .catch((e) =>
          closeRun(blok.id, {
            ok: false,
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          }),
        );
    } else {
      const bot = store.bot(routine.targetId);
      if (!bot) {
        // The agent was deleted for good. A routine pointed at nothing
        // is litter.
        routines.remove(routine.id);
        continue;
      }
      // Archived is not deleted, and a wheel somebody is holding is not
      // a failure: in both cases the routine stays on the books and
      // simply does not fire. markRan is skipped with it, or a "once"
      // routine would quietly burn its single run while nobody was there
      // to do it, and restoring or handing back would bring back a
      // schedule that had already spent itself.
      if (bot.archivedAt || wheel.heldBy(bot.id)) continue;
      const laneId = backgroundTaskId(bot.id, "Routines");
      if (!laneId) continue;
      routines.markRan(routine.id, now.getTime());
      const run = routines.beginRun(routine.id, laneId);
      if (run) openRuns.set(laneId, { routineId: routine.id, runId: run.id });
      broadcast({ kind: "routines" });
      await startTurn(bot.id, routine.prompt, {
        taskId: laneId,
        computerOverride: routine.runsOn,
      }).catch((e) => {
        // it never even started; that is a finished run, not a hung one
        closeRun(laneId, {
          ok: false,
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        });
      });
    }
  }
}

// Every 30s. The schedule has minute resolution, so this is twice as often
// as it needs to be and cheap enough not to care.
const routineTimer = setInterval(() => void runDueRoutines().catch(() => {}), 30_000);

// ── messages arriving from Telegram ───────────────────────────────────
// A loop rather than an interval: long polling already blocks for as
// long as we want to wait, and a timer on top of it would stack calls
// whenever Telegram was slow. Chats we have refused once are remembered
// for the life of the process, so somebody who found the bot and keeps
// typing gets one answer rather than one per message.
const telegramRefused = new Set<number>();
let telegramRunning = false;

async function telegramRound(): Promise<void> {
  const state = cfg.telegram;
  if (!state?.enabled || !state.token) return;
  const messages = await telegram.poll(state.token, state.offset ?? 0);
  const offset = telegram.nextOffset(state.offset ?? 0, messages);
  if (offset !== (state.offset ?? 0)) {
    // Saved before anything is acted on. A crash mid-turn should lose
    // the reply, not replay the message on every restart forever.
    cfg.telegram = { ...state, offset };
    saveConfig({ telegram: cfg.telegram } as Partial<AppConfig>);
  }
  for (const message of messages) {
    const decision = telegram.decide(cfg.telegram ?? {}, message);
    if (decision.kind === "pair") {
      const paired = [...(cfg.telegram?.chatIds ?? []), decision.chatId];
      cfg.telegram = { ...cfg.telegram, chatIds: paired, pairing: null };
      saveConfig({ telegram: cfg.telegram } as Partial<AppConfig>);
      broadcast({ kind: "config", config: await configStatus() });
      await telegram
        .send(state.token, decision.chatId, "Paired. Message me and your agent will answer.")
        .catch(() => {});
      continue;
    }
    if (decision.kind === "refuse") {
      if (telegramRefused.has(decision.chatId)) continue;
      telegramRefused.add(decision.chatId);
      await telegram
        .send(state.token, decision.chatId, "This bot is not paired with you.")
        .catch(() => {});
      continue;
    }
    if (decision.kind !== "deliver") continue;
    const bot = store.bot(cfg.telegram?.botId ?? "") ?? store.bots.find((b) => !b.hidden);
    if (!bot) continue;
    // The reply goes back to the chat that asked, and the exchange lands
    // in the agent's own thread like any other conversation.
    const answer = await answerOverTelegram(bot.id, decision.text).catch(
      (error: unknown) => `Could not answer: ${(error as Error).message}`,
    );
    await telegram.send(state.token, decision.chatId, answer).catch(() => {});
  }
}

/**
 * Run a turn for a message that arrived from a phone, and read back what
 * the agent said.
 *
 * Everything lands in the agent's ordinary lane, so a conversation
 * started on a phone is the same conversation when you open the Mac.
 * The reply is whatever it said that was not already there, which is
 * how a turn that ran tools and then answered comes back as the answer
 * rather than as the running commentary.
 */
async function answerOverTelegram(botId: string, text: string): Promise<string> {
  const bot = store.bot(botId);
  if (!bot) throw new Error("that agent is gone");
  const laneId = bot.activeTaskId ?? bot.threadId;
  const before = store.messagesFor(laneId).length;
  await startTurn(botId, text);
  await waitForIdle(botId, 240_000);
  const said = store
    .messagesFor(laneId)
    .slice(before)
    .filter((message) => message.role === "bot" && message.kind === "text" && message.text)
    .map((message) => message.text as string)
    .join("\n\n")
    .trim();
  return said || "(the agent finished without saying anything)";
}

async function telegramLoop(): Promise<void> {
  if (telegramRunning) return;
  telegramRunning = true;
  for (;;) {
    try {
      await telegramRound();
    } catch {
      // Telegram unreachable, a bad token, a laptop that just woke.
      // Wait before asking again rather than spinning on the failure.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    if (!cfg.telegram?.enabled) {
      telegramRunning = false;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

if (cfg.telegram?.enabled) void telegramLoop();

// The Local VM lease dies with the turn that held it, and a VM that
// survived a restart goes back on the idle clock.
configureVmLease((threadId) => Boolean(store.taskByThread(threadId)?.task.busy));
void vmStatus()
  .then((s) => {
    if (s.container === "running") touchVmIdle();
  })
  .catch(() => {});
routineTimer.unref?.();
// And once shortly after boot, so a Mac waking at 09:04 does not wait for
// the next tick to run the 09:00 routine.
setTimeout(() => void runDueRoutines().catch(() => {}), 5_000).unref?.();

// ── in-chat connectors ────────────────────────────────────────────────
// An agent that needs an app it cannot reach asks for it with a tool
// call; the harness turns that into sign-in cards in the chat and
// answers the tool immediately so the turn can end gracefully. When
// every card from one request is connected, the task resumes itself.

function connectorLabel(slug: string): string {
  const known = composio.connectorCatalogFallback().find((c) => c.slug === slug);
  if (known) return known.label;
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function plantConnectorCards(
  bot: BotRecord,
  threadId: string,
  requestId: string,
  rawApps: unknown,
): string {
  const slugs = [
    ...new Set(
      (Array.isArray(rawApps) ? rawApps : [])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
        .filter(Boolean),
    ),
  ].slice(0, 5);
  if (slugs.length === 0) return "No valid app names were given; ask the user which app they mean.";

  for (const slug of slugs) {
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "connector",
      connector: { slug, label: connectorLabel(slug), status: "needs-auth", resumeKey: requestId },
    });
    broadcast({ kind: "message", threadId, message });
  }
  broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
  const names = slugs.map(connectorLabel).join(", ");
  return `Sign-in cards for ${names} are now in the chat. Tell the user briefly to tap Connect on each card, then end your turn. The app resumes this task automatically once they are connected; never wait or poll.`;
}

/** "Transistor API key" becomes TRANSISTOR_API_KEY, the name the agent
 * will reach for in a shell. */
function secretEnvName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function plantSecretCard(
  bot: BotRecord,
  threadId: string,
  requestId: string,
  input: { name?: unknown; hint?: unknown },
): string {
  const label = clamp(input.name, 60);
  if (!label) return "The secret needs a name, e.g. \"Transistor API key\". Try again with one.";
  const envName = secretEnvName(label);
  if (!envName) return "That name has no usable characters; try a plainer one.";
  const message = store.appendMessage(threadId, {
    role: "bot",
    kind: "secret",
    secret: {
      envName,
      label,
      ...(typeof input.hint === "string" ? { hint: input.hint.slice(0, 140) } : {}),
      status: "needs-value",
      resumeKey: requestId,
    },
  });
  broadcast({ kind: "message", threadId, message });
  broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
  return `A secure field for "${label}" is now in the chat. Once the user saves it, the value is available to your shell tools as the environment variable ${envName} on your NEXT turn (not this one). End your turn now; the task resumes automatically when it is saved.`;
}

/** When the last card of a request connects, the task picks itself up. */
function maybeResumeAfterConnect(botId: string, threadId: string, resumeKey: string) {
  const cards = store
    .messagesFor(threadId)
    .filter((m) => m.kind === "connector" && m.connector?.resumeKey === resumeKey);
  if (cards.length === 0) return;
  const live = cards.filter((m) => m.connector!.status !== "dismissed");
  if (live.length === 0 || live.some((m) => m.connector!.status !== "connected")) return;
  if (live.every((m) => m.connector!.resumed)) return;
  for (const card of live) {
    const patched = store.patchMessage(threadId, card.id, {
      connector: { ...card.connector!, resumed: true },
    });
    if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
  }
  const names = live.map((m) => m.connector!.label).join(", ");
  void startTurn(
    botId,
    `${names} ${live.length === 1 ? "is" : "are"} now connected. Continue the task you were working on before asking for the connection.`,
    { taskId: threadId, presetMessage: true },
  ).catch((e) => {
    // The cards are already marked resumed, and this guard only fires
    // once, so a swallowed refusal leaves the task parked on a
    // connection that has been made with nothing coming to pick it up.
    // Put the mark back and say why, so handing the wheel back or
    // restoring the agent lets the connection be noticed again.
    if (!unresume(threadId, e)) return;
    for (const card of live) {
      const patched = store.patchMessage(threadId, card.id, {
        connector: { ...card.connector!, resumed: false },
      });
      if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
    }
  });
}

// ── steering a busy agent ─────────────────────────────────────────────
// Words said to a busy lane are not an error; they are the next thing to
// say. They land in the transcript immediately (flagged queued), wait in
// memory, and drain into one follow-up turn when the lane settles. A
// restart loses only the auto-send intent; the words are already saved.
const steerQueues = new Map<string, { botId: string; items: Array<{ messageId: string; text: string }> }>();

async function sendUserMessage(botId: string, text: string, options: { taskId?: string; replyTo?: ReplyRef } = {}) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such agent"), { status: 404 });
  const taskId = options.taskId ?? bot.activeTaskId;
  const lane = bot.tasks.find((t) => t.id === taskId);
  if (!lane) throw Object.assign(new Error("no such task"), { status: 404 });
  const holding = wheel.heldBy(bot.id);
  if (holding) {
    wheel.noteTurnedAway(bot.id);
    broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
    throw Object.assign(new Error(heldRefusal(holding, bot.name)), { status: 409 });
  }
  if (bot.archivedAt) {
    throw Object.assign(new Error(`${bot.name} is archived. Restore it to give it work.`), { status: 409 });
  }
  if (lane.busy) {
    const message = store.appendMessage(lane.id, {
      role: "user", kind: "text", text, queued: true,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });
    broadcast({ kind: "message", threadId: lane.id, message });
    const entry = steerQueues.get(lane.id) ?? { botId: bot.id, items: [] };
    entry.items.push({ messageId: message.id, text });
    steerQueues.set(lane.id, entry);
    return { ok: true, queued: true };
  }
  await startTurn(bot.id, text, { taskId: lane.id, replyTo: options.replyTo });
  triggersFired({ kind: "message", targetId: bot.id, text, fromUser: true });
  return { ok: true };
}

const choosingDecisions = new Set<string>();

function drainSteer(threadId: string) {
  const entry = steerQueues.get(threadId);
  if (!entry) return;
  const bot = store.bot(entry.botId);
  const lane = bot?.tasks.find((t) => t.id === threadId);
  if (!bot || !lane) {
    steerQueues.delete(threadId);
    return;
  }
  if (lane.busy) return;
  // claimed before any async work, so two racing settles fire it once
  steerQueues.delete(threadId);
  const alive = entry.items.filter((item) =>
    store.messagesFor(threadId).some((m) => m.id === item.messageId),
  );
  if (alive.length === 0) return;
  for (const item of alive) {
    const patched = store.patchMessage(threadId, item.messageId, { queued: false });
    if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
  }
  // one turn answers the whole burst
  const joined = alive.map((item) => item.text).join("\n");
  void startTurn(entry.botId, joined, { taskId: threadId, presetMessage: true }).catch((e) => {
    const failure = store.appendMessage(threadId, {
      role: "bot",
      kind: "notice",
      text: `Your queued message could not start a turn: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
    });
    broadcast({ kind: "message", threadId, message: failure });
  });
}

/** Per-agent hop depth for the current chain of agent-to-agent turns. */
const agentHops = new Map<string, number>();

/** Rooms with a dispatch loop in flight, holding whoever got named while
 * it ran and the line that named them. One room, one speaker at a time. */
const dispatching = new Map<string, Map<string, string>>();

// ── reacting to changed settings ──────────────────────────────────────
function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    speech: speech.speechConfigured(cfg),
    box: { configured: Boolean(cfg.box?.token) },
    // not a secret, the settings field prefills from it
    profile: { about: cfg.profile?.about ?? "" },
    // whether this workspace has ever been through the welcome
    setupDone: Boolean(cfg.setupDoneAt),
    // the desktop shell reads this at boot to register the hotkey
    shortcuts: { quickAsk: cfg.shortcuts?.quickAsk ?? null },
    // off unless somebody turned it on; see server/context.ts for what it
    // trades against the fold it defers
    compaction: { micro: Boolean(cfg.compaction?.micro) },
    // off unless asked for: reading a session back spends tokens on work
    // nobody requested, and what it finds is staged rather than installed
    skills: { propose: Boolean(cfg.skills?.propose) },
    // what is already here, so a first run can offer to keep it rather
    // than silently dropping somebody into a stranger's-looking workspace
    workspace: (() => {
      const agents = store.bots.filter((b) => !b.hidden).length;
      const rooms = bloks.bloks.length;
      let messages = 0;
      let mine = 0;
      for (const b of store.bots) {
        for (const t of b.tasks) {
          for (const msg of store.messagesFor(t.id)) {
            messages++;
            if (msg.role === "user") mine++;
          }
        }
      }
      return {
        agents,
        rooms,
        messages,
        /** Messages the person themselves sent. A first boot seeds one
         * agent that greets you, so counting everything would tell a
         * brand new install it was returning. Having said something is
         * the difference between a workspace and a fresh seed. */
        mine,
      };
    })(),
  };
}

/** Rebuild every engine from the current config. A pasted key should
 * work in the next message, not after a restart. The cost is that turns
 * running right now die with the old fleet, which is the right trade for
 * something a person only does deliberately. */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
}

// ── provider catalog ───────────────────────────────────────────────────
/** What the connections screen renders: every engine Bloks can talk to,
 * how you sign in to it, and whether it is signed in now. */
async function providerCatalog() {
  const connected = new Set(connectedProviders(cfg));
  const described = await registry.describe();
  const cliReady = new Map(
    described.map((d) => [
      d.driverKind,
      {
        installed: d.snapshot.state === "available",
        signedOut: d.snapshot.state === "available" && d.snapshot.authenticated === false,
      },
    ]),
  );
  const api = PROVIDER_SPECS.map((spec) => ({
    kind: spec.kind,
    name: spec.name,
    auth: spec.auth,
    keyHint: spec.keyHint,
    keyPrefix: spec.keyPrefix,
    signInHint: undefined as string | undefined,
    docsUrl: spec.docsUrl,
    connected: connected.has(spec.kind),
    needsSignIn: false,
    // an API engine is agentic exactly when the driver runs the tool
    // loop for it; the rest speak text only
    agentic: spec.tools === true,
  }));
  // A CLI being on PATH is not the same as being signed in. Installed is
  // still connected (some CLIs authenticate in ways we cannot see), but
  // when we can tell there is no login, the row says so.
  const cli = CLI_PROVIDERS.map((p) => ({
    ...p,
    keyPrefix: undefined,
    connected: cliReady.get(p.kind)?.installed ?? false,
    needsSignIn: cliReady.get(p.kind)?.signedOut ?? false,
    agentic: true,
  }));
  return { providers: [...cli, ...api] };
}

/** The address OpenRouter sends the browser back to. It has to be this
 * server, since the verifier never leaves it. */
const oauthCallback = (kind: string) => `http://127.0.0.1:${PORT}/api/oauth/${kind}/callback`;

async function connectProvider(kind: string, key: string, endpoint = "") {
  saveConfig({
    providers: { [kind]: { ...(key ? { key } : {}), ...(endpoint ? { url: endpoint } : {}) } },
  });
  Object.assign(cfg, loadConfig());
  await reloadProviders();
  broadcast({ kind: "providers", ...(await providerCatalog()) });
}

/** What Settings renders for user-added hosts: names, URLs, key labels.
 * Never the keys themselves. */
function customCatalog() {
  return {
    endpoints: (cfg.custom ?? []).map((endpoint) => {
      const active = activeCustomKey(endpoint);
      return {
        id: endpoint.id,
        name: endpoint.name,
        url: endpoint.url,
        instanceId: customInstanceId(endpoint.id),
        activeKeyId: active?.id ?? null,
        keys: endpoint.keys.map((cred) => ({
          id: cred.id,
          label: cred.label ?? "",
          active: cred.id === active?.id,
        })),
      };
    }),
  };
}

async function persistCustom(next: CustomEndpoint[]) {
  saveConfig({ custom: next } as Partial<AppConfig>);
  Object.assign(cfg, loadConfig());
  // loadConfig re-reads the file; keep the in-memory list aligned with
  // what we just wrote so a follow-up in this request sees it.
  cfg.custom = next;
  await reloadProviders();
  broadcast({ kind: "providers", ...(await providerCatalog()) });
}

function parseCustomKey(body: Record<string, unknown>): { key?: string; label?: string; error?: string } {
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const label = clamp(body.label, MAX_NAME_CHARS);
  if (!key) return { error: "a key is required" };
  if (key.length > MAX_KEY_CHARS) return { error: "that key is too long" };
  return { key, ...(label ? { label } : {}) };
}

// ── request and response helpers ──────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

/** The one place that answers a browser directly: the OAuth landing page. */
function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        // Rejecting alone leaves the sender streaming into a buffer nobody
        // is going to read. Hang up.
        req.destroy();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Webhook ingress stands apart from every other boundary: the token in
  // the URL is the whole credential, exactly as webhook senders expect.
  // Reachable from the network only when pairing is on, like the rest of
  // the server. GETs answer 405 so a pasted URL in a browser produces a
  // diagnosable answer instead of the SPA.
  const hookMatch = path.match(/^\/hook\/([\w-]+)$/);
  if (hookMatch) {
    if (method !== "POST") return json(res, 405, { error: "POST the event body to this URL" });
    if (!isLocalRequest(req) && !remoteEnabled()) {
      return json(res, 403, { error: "not reachable from here" });
    }
    const hook = webhooks.byToken(hookMatch[1]);
    if (!hook) return json(res, 404, { error: "no such webhook" });
    // An archived target keeps its hook, so restoring brings the same
    // URL back. A 4xx and not a 5xx: senders retry on a 5xx, and this
    // will not start working until somebody restores the agent.
    if (hook.botId && store.bot(hook.botId)?.archivedAt) {
      return json(res, 409, { error: "that agent is archived" });
    }

    // the payload is whatever arrived: JSON gets compacted, anything
    // else (form posts, plain text) is passed through as text
    let raw = "";
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 2_000_000) break;
        chunks.push(chunk as Buffer);
      }
      raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        const parsed = JSON.parse(raw);
        raw = JSON.stringify(parsed);
        if (raw === "{}") raw = "";
      } catch {
        /* not JSON; the text itself is the payload */
      }
    } catch {
      raw = "";
    }
    webhooks.noteFired(hook.id, raw);
    const text = webhookMessage(hook.name, raw);

    // Answer before the turn runs: webhook senders time out fast and
    // retry on failure, and an agent turn outlives both.
    json(res, 202, { ok: true });
    void (async () => {
      try {
        if (hook.workflowId) {
          // the body itself, not the wrapper sentence: a step reading
          // {{trigger.text}} wants what was sent, not our framing of it
          fireWorkflow(hook.workflowId, { text: raw, from: hook.name });
        } else if (hook.blokId) {
          const blok = bloks.get(hook.blokId);
          if (blok) await postToRoom(blok, text, { hops: 0 });
        } else if (hook.botId) {
          const laneId = backgroundTaskId(hook.botId, "Webhooks");
          if (!laneId) return; // lane busy; the sender's retry will land
          await startTurn(hook.botId, text, { taskId: laneId });
        }
      } catch (e) {
        // The sender is long gone; the failure belongs in the chat.
        const bot = hook.botId ? store.bot(hook.botId) : null;
        const threadId = bot?.threadId ?? hook.blokId ?? "";
        if (!threadId) return;
        const failure = store.appendMessage(threadId, {
          role: "bot",
          kind: "notice",
          text: `The webhook "${hook.name}" fired but the turn could not start: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        });
        broadcast({ kind: "message", threadId, message: failure });
      }
    })();
    return;
  }

  // A request carrying a turn's own credential is an agent acting for
  // itself. It is checked before anything else: an agent gets a narrower
  // surface than the person at the keyboard, and the narrowing has to
  // happen whatever else the request looks like.
  const asAgent = agentTokens.identify(bearerToken(req), Date.now());
  if (asAgent) {
    if (!isLocalRequest(req)) {
      return json(res, 403, { error: "an agent's credential only works on this machine" });
    }
    // Rooms it is in, not rooms that exist. An agent with a credential
    // could otherwise speak into any room in the workspace, which is a
    // wider thing than the room it was asked to work in.
    const verdict = allows(asAgent.botId, method, path, (roomId) =>
      Boolean(bloks.get(roomId)?.memberIds.includes(asAgent.botId)),
    );
    if (!verdict.ok) return json(res, 403, { error: verdict.reason });
    // Reading is free; changing the workspace is counted, so a pair of
    // agents cannot message each other in a circle all afternoon.
    if (method !== "GET" && !agentTokens.spend(asAgent)) {
      return json(res, 429, {
        error: "this turn has changed as much as one turn may. Finish up and say what you did.",
      });
    }
  }

  // A request replayed off the relay line speaks for a paired device, and
  // gets exactly what that device would get over the network: never the
  // local-only surface, however it arrived on the loopback interface.
  const viaRelay = relayDeviceFor(req);
  // Loopback is not a boundary in a browser, see server/http-guard.ts.
  const local = viaRelay ? false : isLocalRequest(req);
  if (!local && !viaRelay) {
    // Everything below this point is the remote surface, and it only
    // exists once somebody has switched pairing on.
    if (!remoteEnabled() || !isSameOrigin(req)) {
      return json(res, 403, { error: "cross-origin requests are not allowed" });
    }
    // Two things a device does before it holds a token: confirm it found
    // Bloks at all, and trade its code in. Nothing else.
    const open =
      (method === "GET" && path === "/api/health") ||
      (method === "POST" && path === "/api/pair/claim");
    if (!open && !deviceForToken(bearerToken(req))) {
      return json(res, 401, { error: "pair this device first" });
    }
  }

  try {
    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        // one app needs one stream; this many means something is looping.
        // A real error status stops EventSource's automatic retry loop.
        return json(res, 503, { error: "too many event streams open" });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Replay what a returning client missed, when the ring still has
      // it. `resumed: true` in the hello tells the client its state is
      // continuous and no re-hydrate is needed.
      const since = Number(url.searchParams.get("since") ?? NaN);
      const floor = frameRing[0]?.seq ?? frameSeq + 1;
      const canResume = Number.isFinite(since) && since >= floor - 1 && since <= frameSeq;
      res.write(
        `data: ${JSON.stringify({ kind: "hello", _seq: frameSeq, resumed: canResume })}\n\n`,
      );
      if (canResume) {
        for (const entry of frameRing) {
          if (entry.seq > since) res.write(entry.frame);
        }
      }
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      // ?messages=N trims each transcript to its tail. Phones hydrate
      // with a page and fetch history if someone actually scrolls.
      const tail = Number(url.searchParams.get("messages") ?? NaN);
      const trim = (list: Message[]) =>
        Number.isFinite(tail) && tail >= 0 ? list.slice(-tail) : list;
      return json(res, 200, {
        bots: store.bots.map((b) => ({
          ...clientBot(b)!,
          messages: trim(store.messagesFor(b.threadId)),
        })),
      });
    }
    if (method === "POST" && path === "/api/bots") {
      // The client sends the chosen role's profile so the agent is named,
      // skilled and greeted correctly on its very first frame, no
      // create-then-rename flash.
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const profile: NewBotProfile = {};
      const CAPS = {
        name: MAX_NAME_CHARS,
        title: MAX_TITLE_CHARS,
        description: MAX_DESCRIPTION_CHARS,
        greeting: MAX_DESCRIPTION_CHARS,
      } as const;
      for (const [key, max] of Object.entries(CAPS) as Array<[keyof typeof CAPS, number]>) {
        const value = clamp(body[key], max);
        if (value) profile[key] = value;
      }
      if (typeof body.color === "string") profile.color = body.color as NewBotProfile["color"];
      if (typeof body.shape === "string") profile.shape = body.shape as NewBotProfile["shape"];
      if (typeof body.seniority === "number") {
        profile.seniority = Math.max(1, Math.min(5, Math.round(body.seniority)));
      }
      for (const key of ["skills", "skillIds"] as const) {
        const list = clampList(body[key], MAX_SKILL_CHARS, MAX_SKILLS);
        if (list) profile[key] = list;
      }
      const setup = body.setup as NewBotProfile["setup"] | undefined;
      if (setup && typeof setup.title === "string" && Array.isArray(setup.options)) {
        profile.setup = {
          title: clamp(setup.title, MAX_TITLE_CHARS) ?? "",
          subtitle: clamp(setup.subtitle, MAX_DESCRIPTION_CHARS) ?? "",
          options: clampList(setup.options, MAX_TITLE_CHARS, 6) ?? [],
        };
      }

      const bot = store.createBot(profile);
      store.patchBot(bot.id, { modelSelection: await defaultSelection() });
      record({
        at: Date.now(),
        kind: "agent.created",
        actor: "you",
        summary: `Made ${bot.name}${bot.title ? `, ${bot.title}` : ""}`,
        detail: { agent: bot.name },
      });
      return json(res, 201, { bot: { ...clientBot(store.bot(bot.id))!, messages: store.messagesFor(bot.threadId) } });
    }
    // ── an agent arriving from somewhere else ──
    // Two calls on purpose. The first only reads the file and says what
    // would happen, so the person sees an agent's name, its skills and
    // what it will add to their library before anything is written. The
    // second does it. Both parse with the same function, so what the
    // preview promised is what the import performs.
    if (method === "POST" && (path === "/api/agents/import" || path === "/api/agents/import/preview")) {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const parsed =
        typeof body.text === "string" ? parseAgentDocument(body.text) : parseAgentFile(body.file);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const file = parsed.file;

      const described = await registry.describe();
      const preview = describeAgentFile(file, {
        skillIds: listSkills().map((s) => s.id),
        instanceIds: described.map((d) => d.instanceId),
        voiceReady: Boolean(loadConfig().providers?.elevenlabs?.key || loadConfig().providers?.openai?.key),
      });
      if (path.endsWith("/preview")) return json(res, 200, { preview });

      // Skills first: the agent points at them by id, so a half-written
      // library would leave it pointing at nothing. An id already in the
      // library is left exactly as it is, because someone else's file
      // does not get to rewrite a skill this workspace already trusts.
      const here = new Set(listSkills().map((s) => s.id));
      const carried: string[] = [];
      let added = 0;
      for (const skill of file.skills ?? []) {
        if (here.has(skill.id)) {
          carried.push(skill.id);
          continue;
        }
        try {
          const installed = installSkill({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            body: skill.body,
          });
          carried.push(installed.id);
          here.add(installed.id);
          added++;
        } catch {
          // a full library or a skill this build will not take is a
          // reason to arrive without it, not a reason not to arrive
        }
      }
      if (carried.length) broadcast({ kind: "skills" });

      const { profile, patch } = profileFromFile(file);
      const bot = store.createBot({ ...profile, skillIds: carried.length ? carried : undefined });
      store.patchBot(bot.id, { ...patch, modelSelection: await defaultSelection() });

      if (file.memory) {
        if (file.memory.text.trim()) workspace.writeMemoryFile(bot.id, file.memory.text);
        for (const topic of file.memory.topics) {
          workspace.writeMemoryTopic(bot.id, topic.name, topic.text);
        }
      }
      if (file.avatar) {
        try {
          mkdirSync(AVATARS_DIR, { recursive: true, mode: 0o700 });
          writeFileSync(join(AVATARS_DIR, bot.id), Buffer.from(file.avatar.data, "base64"), {
            mode: 0o600,
          });
          writeFileSync(join(AVATARS_DIR, `${bot.id}.mime`), file.avatar.mime, { mode: 0o600 });
          store.patchBot(bot.id, { avatarAt: Date.now() });
        } catch {
          // the pixel avatar is the identity everything keys off; a photo
          // that will not write is a missing skin, not a failed import
        }
      }

      const created = store.bot(bot.id)!;
      // Worth recording more carefully than a made agent: this one's
      // instructions were written somewhere else, by someone else.
      record({
        at: Date.now(),
        kind: "agent.imported",
        actor: "you",
        summary: `Brought in ${created.name} from a file`,
        detail: {
          agent: created.name,
          skills: carried.length,
          skillsAdded: added,
          memory: Boolean(file.memory),
          exportedAt: file.exportedAt,
        },
      });
      broadcast({ kind: "bot", bot: clientBot(created) });
      return json(res, 201, {
        preview,
        bot: { ...clientBot(created)!, messages: store.messagesFor(created.threadId) },
      });
    }
    // Model-written name + role for a described agent. The client already
    // has a local guess; this upgrades it when a provider is available.
    if (method === "POST" && path === "/api/agents/suggest") {
      const { description } = await readBody(req);
      if (typeof description !== "string" || !description.trim()) {
        return json(res, 400, { error: "description required" });
      }
      if (description.length > 2_000) return json(res, 413, { error: "description is too long" });
      const instance = registry.get((await defaultSelection()).instanceId);
      if (!instance?.generateText) return json(res, 200, {});
      try {
        // Name, role, persona and a few skills in one call. Whatever
        // comes back is a proposal shown in editable fields, never
        // something applied on the person's behalf.
        const draft = parseDraft(await instance.generateText(draftPrompt(description)));
        return json(res, 200, draft);
      } catch {
        return json(res, 200, { skills: [] }); // never block creation on a drafting call
      }
    }
    let m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      // Hiding is how an agent leaves the list, and archiving now moves
      // with it. PATCH /api/bots/:me is on the agent allowlist, so
      // without this an agent could take itself off its own routines and
      // nobody would find out until nothing ran. Retiring an agent is a
      // decision for the person.
      if (asAgent && body.hidden !== undefined) {
        return json(res, 403, { error: "an agent cannot retire itself" });
      }
      // Hiding is retiring now, so it goes through the pair rather than
      // setting one half of it. Assigning `hidden` on its own produced
      // either an agent in the list that refuses work, or one out of the
      // list that still does it, which is the exact split archiveBot
      // exists to make impossible.
      if (typeof body.hidden === "boolean") {
        const existing = store.bot(m[1]);
        if (!existing) return json(res, 404, { error: "no such agent" });
        const moved = body.hidden ? store.archiveBot(existing.id, Date.now()) : store.restoreBot(existing.id);
        if (moved) {
          record({
            at: Date.now(),
            kind: body.hidden ? "agent.archived" : "agent.restored",
            actor: "you",
            summary: `${body.hidden ? "Archived" : "Restored"} ${moved.name}`,
            detail: { agent: moved.name, ...(body.hidden ? { key: "kept" } : {}) },
          });
        }
        delete body.hidden;
      }
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "computer", "color", "shape", "skills", "skillIds", "seniority", "effort", "mascotExpression", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.cwd !== undefined) {
        const checked = workspace.validateWorkingFolder(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.path;
      }
      if (body.section !== undefined) {
        const named = normalizeSection(body.section);
        if (!named.ok) return json(res, 400, { error: named.error });
        patch.section = named.section;
      }
      if (body.approvals !== undefined) {
        if (!["ask", "edits", "auto"].includes(body.approvals as string)) {
          return json(res, 400, { error: "approvals is ask, edits or auto" });
        }
        patch.approvals = body.approvals;
      }
      if (body.mcpServers !== undefined) {
        if (!Array.isArray(body.mcpServers)) {
          return json(res, 400, { error: "mcpServers must be a list of server ids" });
        }
        patch.mcpServers = (body.mcpServers as unknown[])
          .filter((id): id is string => typeof id === "string")
          .filter((id) => (cfg.mcpServers ?? []).some((server) => server.id === id))
          .slice(0, 16);
      }
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") {
          return json(res, 400, { error: "composio must be true or false" });
        }
        patch.composio = body.composio;
      }
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") {
          return json(res, 400, { error: "browser must be true or false" });
        }
        // An agent granting itself a browser would be widening its own
        // reach, which is the person's call. PATCH /api/bots/:me is on
        // the agent allowlist, so this has to be said explicitly.
        if (asAgent) return json(res, 403, { error: "an agent cannot give itself a browser" });
        patch.browser = body.browser;
      }
      if (body.withoutComponents !== undefined) {
        if (!Array.isArray(body.withoutComponents)) {
          return json(res, 400, { error: "withoutComponents must be a list of component kinds" });
        }
        // Only kinds that exist: a withheld name nobody ships would read
        // as protection that is not doing anything.
        patch.withoutComponents = (body.withoutComponents as unknown[])
          .filter((kind): kind is ComponentKind => COMPONENT_KINDS.includes(kind as ComponentKind))
          .slice(0, COMPONENT_KINDS.length);
      }
      if (body.voice !== undefined) {
        const voice = speech.parseBotVoice(body.voice);
        if (voice === undefined && body.voice !== null) {
          return json(res, 400, { error: "voice must name a provider and a voice id" });
        }
        patch.voice = voice ?? null;
      }
      if (body.speakReplies !== undefined) {
        if (typeof body.speakReplies !== "boolean") {
          return json(res, 400, { error: "speakReplies must be true or false" });
        }
        patch.speakReplies = body.speakReplies;
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such agent" });
      broadcast({ kind: "bot", bot: clientBot(bot) });
      return json(res, 200, { bot: clientBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/restore$/);
    if (m && method === "POST") {
      const bot = store.restoreBot(m[1]);
      if (!bot) return json(res, 404, { error: "no such archived agent" });
      record({
        at: Date.now(),
        kind: "agent.restored",
        actor: "you",
        summary: `Restored ${bot.name}`,
        detail: { agent: bot.name },
      });
      broadcast({ kind: "bot", bot: clientBot(bot) });
      return json(res, 200, { bot: clientBot(bot) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });

      // Archived unless somebody asks for the other thing, the same way
      // a finished project is. A delete used to take the conversations
      // and burn the key, and the key cannot be remade: past signed
      // entries in the record verify against that fingerprint and no
      // other. One mis-click was the end of all of it.
      const forget = url.searchParams.get("forget") === "1";

      // Whatever happens next, it stops working now.
      for (const lane of bot.tasks.filter((t) => t.busy)) {
        await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(lane.id).catch(() => {});
      }
      stopScreenPoller(bot.id);
      terminals.close(bot.id);
      // A hold naming an agent that cannot act would sit in the activity
      // panel forever.
      wheel.release(bot.id);
      // Per turn credentials, in memory, nothing to keep.
      agentTokens.revokeBot(bot.id);
      // A claimed job waiting on somebody who is not coming goes back on
      // the board rather than sitting there, and says which of the two
      // things happened rather than always claiming a deletion.
      jobs.releaseAgent(
        bot.id,
        Date.now(),
        forget ? "The agent that took this was deleted." : "The agent that took this was archived.",
      );

      if (!forget) {
        // Stop the container and keep the volume: the volume is its
        // files, and retiring an agent is not supposed to touch work.
        void stopSandbox(bot.id).catch(() => {});
        // A dormant agent should not be billed for a box it is not using.
        void box.sleepBox(cfg, bot.id).catch(() => {});
        const archived = store.archiveBot(bot.id, Date.now());
        if (!archived) return json(res, 409, { error: "that agent is already archived" });
        record({
          at: Date.now(),
          kind: "agent.archived",
          actor: "you",
          summary: `Archived ${bot.name}`,
          detail: { agent: bot.name, conversations: bot.tasks.length, key: "kept" },
        });
        broadcast({ kind: "bot", bot: clientBot(archived) });
        return json(res, 200, { ok: true, archived: true });
      }

      // ── and the other one, which really is the end ──
      //
      // Everything below is deferred until here on purpose. A rule the
      // person wrote about this agent, a note pinned inside a file it
      // made, its place in a room or a project: restoring an agent whose
      // rules were dropped is a permission regression, and one whose
      // rooms were forgotten asks the person to rebuild a roster from
      // memory. workflows.removeTarget is the one that cannot be undone
      // even in principle, because it deletes the ids the steps pointed
      // at, so there would be nothing left saying who the step was for.
      //
      // The fingerprint is read before the key is burned, because it is
      // the only checkable handle the record keeps on an identity that
      // no longer exists.
      const fingerprint = identityFor(bot.id).fingerprint;
      record({
        at: Date.now(),
        kind: "agent.deleted",
        actor: "you",
        summary: `Deleted ${bot.name} for good`,
        detail: { agent: bot.name, fingerprint, conversations: bot.tasks.length, key: "destroyed" },
      });
      forgetIdentity(bot.id);
      proposals.removeForBot(bot.id);
      policy.removeForBot(bot.id);
      artifactComments.removeForBot(bot.id);
      projects.removeMember(bot.id);
      bloks.removeMember(bot.id);
      webhooks.removeTarget(bot.id);
      workflows.removeTarget(bot.id);
      void destroySandbox(bot.id).catch(() => {});
      routines.removeForTarget(bot.id);
      usage.forget(bot.id);
      store.deleteBot(bot.id);
      // Every lane, not just the first: an agent with three lanes used
      // to leave two files behind.
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        for (const task of bot.tasks) {
          try {
            unlinkSync(join(dir, `${task.id}.ndjson`));
          } catch {}
        }
      }
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true, archived: false });
    }

    // A card remembers being answered or waved away, so reopening a
    // thread does not present a decision that was already made.
    // ── the agent's photo, when the user gave it one ──
    // The bytes live on disk, never in bots.json. Clients send an already
    // downscaled square (both apps resize before uploading), so the body
    // cap stays where it is: a giant original is the sender's problem to
    // shrink, not ours to buffer.
    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar$/);
    if (m && method === "PUT") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req);
      const mime = String(body.mime ?? "");
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
        return json(res, 400, { error: "the picture has to be a JPEG, PNG or WebP" });
      }
      const bytes = Buffer.from(typeof body.data === "string" ? body.data : "", "base64");
      if (!bytes.length) return json(res, 400, { error: "the picture arrived empty" });
      mkdirSync(AVATARS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(join(AVATARS_DIR, bot.id), bytes, { mode: 0o600 });
      writeFileSync(join(AVATARS_DIR, `${bot.id}.mime`), mime, { mode: 0o600 });
      const patched = store.patchBot(bot.id, { avatarAt: Date.now() });
      broadcast({ kind: "bot", bot: clientBot(patched) });
      return json(res, 200, { bot: clientBot(patched) });
    }
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot?.avatarAt) return json(res, 404, { error: "no photo for this agent" });
      try {
        const bytes = readFileSync(join(AVATARS_DIR, bot.id));
        let mime = "image/jpeg";
        try {
          mime = readFileSync(join(AVATARS_DIR, `${bot.id}.mime`), "utf8").trim() || mime;
        } catch {
          /* sidecar lost: jpeg is what both clients send by default */
        }
        res.writeHead(200, { "content-type": mime, "cache-control": "private, max-age=86400" });
        return res.end(bytes);
      } catch {
        return json(res, 404, { error: "no photo for this agent" });
      }
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      for (const file of [join(AVATARS_DIR, bot.id), join(AVATARS_DIR, `${bot.id}.mime`)]) {
        try {
          unlinkSync(file);
        } catch {}
      }
      const patched = store.patchBot(bot.id, { avatarAt: null });
      broadcast({ kind: "bot", bot: clientBot(patched) });
      return json(res, 200, { bot: clientBot(patched) });
    }

    // ── an agent, as a file you can take somewhere else ──
    // What travels is the agent: who it is, what it can do, the skills it
    // carries and what it has learned. What stays is everything that only
    // means something on this machine, and the conversations, which belong
    // to the workspace they happened in rather than to the agent.
    m = path.match(/^\/api\/bots\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const memory = workspace.readMemoryFile(bot.id);
      const topics = workspace.listMemoryTopics(bot.id).flatMap((t) => {
        const text = workspace.readMemoryTopic(bot.id, t.name);
        return text === null ? [] : [{ name: t.name, text }];
      });
      let avatar: { mime: string; data: string } | null = null;
      if (bot.avatarAt) {
        try {
          const data = readFileSync(join(AVATARS_DIR, bot.id)).toString("base64");
          let mime = "image/jpeg";
          try {
            mime = readFileSync(join(AVATARS_DIR, `${bot.id}.mime`), "utf8").trim() || mime;
          } catch {
            /* sidecar lost: jpeg is what both clients send by default */
          }
          avatar = { mime, data };
        } catch {
          /* the record says there is a photo and the file is gone; export
             the agent anyway rather than failing over a picture */
        }
      }
      const file = packAgent({
        bot,
        memory: memory.text,
        topics,
        skills: getSkills(bot.skillIds ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          body: s.body,
        })),
        avatar,
        exportedAt: Date.now(),
        app: APP_VERSION,
      });
      record({
        at: Date.now(),
        kind: "agent.exported",
        actor: "you",
        summary: `Exported ${bot.name} as a file`,
        detail: {
          agent: bot.name,
          skills: (file.skills ?? []).length,
          memory: Boolean(file.memory),
          photo: Boolean(file.avatar),
        },
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${fileNameFor(bot.name)}"`,
      });
      return res.end(JSON.stringify(file, null, 2));
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      // Truncating would drop the tail of what someone wrote without
      // telling them, so an over-long message is refused instead.
      if (typeof body.text === "string" && body.text.length > MAX_MESSAGE_CHARS) {
        return json(res, 413, { error: "that message is too long to send in one go" });
      }
      const text = clamp(body.text, MAX_MESSAGE_CHARS);
      if (!text) return json(res, 400, { error: "text required" });
      const result = await sendUserMessage(m[1], text, { replyTo: replyRef(body.replyTo) });
      return json(res, 202, result);
    }
    // ── task lanes ──
    // ── voices: how agents sound ──
    if (method === "GET" && path === "/api/speech/voices") {
      return json(res, 200, {
        configured: speech.speechConfigured(cfg),
        voices: await speech.listVoices(cfg),
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/speak$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      if (!bot.voice) return json(res, 409, { error: "this agent has no voice yet. Pick one in its settings" });
      const body = await readBody(req);
      // default to reading the agent's latest reply aloud
      const text =
        clamp(body.text, speech.SPEAK_MAX_CHARS) ??
        [...store.messagesFor(bot.activeTaskId)]
          .reverse()
          .find((msg) => msg.role === "bot" && msg.kind === "text" && msg.text)?.text;
      if (!text) return json(res, 400, { error: "nothing to say" });
      // markdown is for eyes; the voice gets the spoken version
      const spoken = speakable(text);
      if (!spoken) return json(res, 400, { error: "nothing speakable in that message" });
      try {
        const { stream, mime } = await speech.speak(cfg, bot.voice, spoken);
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
        const { Readable } = await import("node:stream");
        Readable.fromWeb(stream as import("node:stream/web").ReadableStream).pipe(res);
      } catch (e) {
        json(res, 502, { error: redactSecrets(e instanceof Error ? e.message : String(e)) });
      }
      return;
    }

    // ── the Local VM: status, setup, lifecycle ──
    if (method === "GET" && path === "/api/local-vm") {
      const status = await vmStatus();
      const holder = currentVmLease();
      const rt = status.runtime ?? "docker";
      return json(res, 200, {
        ...status,
        inUseBy: holder ? (store.bot(holder.botId)?.name ?? null) : null,
        // shown collapsed in setup, for people who like to see the wires
        commands: {
          pull:
            rt === "container"
              ? `${rt} image pull ${status.baseRef}`
              : `${rt} pull ${status.baseRef}`,
          run: `${rt} ${vmRunArgs(rt, "<generated>").join(" ")}`,
        },
      });
    }
    m = path.match(/^\/api\/local-vm\/(prepare|create|stop|remove|screenshot)$/);
    if (m && method === "POST") {
      const verb = m[1];
      try {
        if (verb === "screenshot") {
          touchVmIdle();
          return json(res, 200, { frame: await vmScreenshot() });
        }
        if ((verb === "stop" || verb === "remove") && currentVmLease()) {
          return json(res, 409, { error: "an agent is using the Local VM. Stop that turn first" });
        }
        if (verb === "prepare") await vmPrepare();
        else if (verb === "create") {
          await vmCreate();
          touchVmIdle();
        } else if (verb === "stop") await vmStop();
        else await vmRemove();
        return json(res, 200, await vmStatus());
      } catch (e) {
        return json(res, 502, { error: redactSecrets(e instanceof Error ? e.message : String(e)) });
      }
    }

    // ── the relay line ──
    if (method === "GET" && path === "/api/relay") {
      if (!local) return json(res, 403, { error: "not from here" });
      return json(res, 200, {
        ...relayLink.state,
        url: cfg.relay?.url ?? "",
        enabled: Boolean(cfg.relay?.enabled),
      });
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/relay") {
      if (!local) return json(res, 403, { error: "not from here" });
      const body = await readBody(req);
      const patch: NonNullable<AppConfig["relay"]> = {};
      if (typeof body.url === "string") {
        const url = body.url.trim().replace(/\/+$/, "");
        if (url) {
          // Compare the parsed hostname exactly. A prefix or \b test lets
          // http://127.0.0.1.evil.com and http://127.0.0.1@evil.com
          // through, and either sends the agent token to that host in
          // clear. https to anywhere is fine; http only to true loopback.
          let parsed: URL | null = null;
          try {
            parsed = new URL(url);
          } catch {
            return json(res, 400, { error: "that is not a valid relay address" });
          }
          const loopback =
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost" ||
            parsed.hostname === "[::1]" ||
            parsed.hostname === "::1";
          if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
            return json(res, 400, { error: "the relay address must be https" });
          }
        }
        patch.url = url;
      }
      if (typeof body.agentToken === "string") patch.agentToken = body.agentToken.trim();
      if (typeof body.clientToken === "string") patch.clientToken = body.clientToken.trim();
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      saveConfig({ relay: patch });
      Object.assign(cfg, loadConfig());
      syncRelay();
      return json(res, 200, {
        ...relayLink.state,
        url: cfg.relay?.url ?? "",
        enabled: Boolean(cfg.relay?.enabled),
      });
    }

    if (method === "GET" && path === "/api/relay/join") {
      // Anything that reaches this line is the app itself or a paired
      // device; the gate above already turned strangers away. Pairing is
      // the trust root, so a paired phone may collect its relay
      // credentials without typing anything.
      if (!cfg.relay?.enabled || !cfg.relay.url || !cfg.relay.clientToken) {
        return json(res, 404, { error: "no relay is set up" });
      }
      // the caller's own device id, when the request carries one: the
      // phone needs it to address its envelopes
      const asDevice = viaRelay ?? deviceForToken(bearerToken(req))?.id ?? null;
      return json(res, 200, {
        url: cfg.relay.url,
        clientToken: cfg.relay.clientToken,
        ...(asDevice ? { deviceId: asDevice } : {}),
      });
    }

    // Turning Cloud on, from the Mac that will own the space.
    //
    // The licence key is a receipt, not a credential this machine keeps:
    // it is spent once here for a pair of space tokens, and those are the
    // only things that reach disk. Nothing in this route prints the key,
    // and redactSecrets knows its shape for the errors we did not write.
    if (method === "POST" && path === "/api/relay/activate") {
      if (!local) return json(res, 403, { error: "not from here" });
      const body = await readBody(req);
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!CLOUD_KEY.test(key)) {
        return json(res, 400, {
          error: "that is not a Bloks Cloud key. One starts with blok_live_ and ends in 32 hex characters",
        });
      }
      const url = relayBase();
      let minted: Response;
      try {
        minted = await fetch(`${url}/spaces`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // Deliberately not the thrown message: a fetch failure can quote
        // the request that caused it, and the request is the key.
        return json(res, 502, { error: "Bloks Cloud could not be reached. Check the connection and try again" });
      }
      // Read as unknowns and checked one at a time: this is another
      // service's JSON, and every field below is one a bad day could
      // deliver as null, a number, or not at all.
      const answer = (await minted.json().catch(() => ({}))) as {
        error?: unknown;
        message?: unknown;
        spaceId?: unknown;
        agentToken?: unknown;
        clientToken?: unknown;
      };
      const said =
        typeof answer.error === "string"
          ? answer.error
          : typeof answer.message === "string"
            ? answer.message
            : "";
      // A 402 is a card, not a fault. Whatever billing said is the only
      // thing that helps: "something went wrong" sends a person to
      // support for a problem their bank has already explained to them.
      if (minted.status === 402) {
        return json(res, 402, { error: said || "Bloks Cloud will not open a space for that subscription" });
      }
      // Redacted, unlike the 402 above, and for a reason that only
      // applies here: this is the branch that catches a gateway or a
      // proxy quoting the request it choked on, and the request is the
      // key. A billing message has no key in it and passes through whole.
      if (minted.status !== 201) {
        return json(res, minted.status === 401 ? 401 : 502, {
          error: redactSecrets(said) || `Bloks Cloud answered HTTP ${minted.status}`,
        });
      }
      const agentToken = typeof answer.agentToken === "string" ? answer.agentToken : "";
      const clientToken = typeof answer.clientToken === "string" ? answer.clientToken : "";
      // A space whose tokens did not arrive is worse than no space: it
      // would be saved, look activated, and never dial.
      if (!agentToken || !clientToken) {
        return json(res, 502, { error: "Bloks Cloud opened a space but sent no tokens for it" });
      }
      saveConfig({ relay: { url, agentToken, clientToken, enabled: true } });
      Object.assign(cfg, loadConfig());
      // Pairing stays exactly as the owner left it. It is the master
      // switch for every remote path (see syncRelay), and paying for
      // Cloud is not the same act as opening this Mac to the network, so
      // the answer below reports what is actually true instead: with
      // pairing off, `configured` and `connected` are both false.
      syncRelay();
      return json(res, 200, {
        ...relayLink.state,
        // the space that was just minted, which is the truth for the
        // moment between saving it and the stream saying hello
        spaceId: relayLink.state.spaceId ?? (typeof answer.spaceId === "string" ? answer.spaceId : null),
        url,
        enabled: Boolean(cfg.relay?.enabled),
      });
    }

    if (method === "GET" && path === "/api/relay/status") {
      if (!local) return json(res, 403, { error: "not from here" });
      // Three facts, and they are not one fact. `enabled` is the switch
      // in the config, `connected` is whether the line is up this second,
      // and `spaceId` only exists once the relay has said hello. A screen
      // that infers the last two from the first shows a green light while
      // the phone gets nothing.
      return json(res, 200, {
        enabled: Boolean(cfg.relay?.enabled),
        connected: relayLink.state.connected,
        spaceId: relayLink.state.spaceId,
      });
    }

    // Start fresh, without destroying anything: the whole workspace is
    // moved aside with a timestamp, so a person who chose wrong can put
    // it back by renaming one folder. The harness then reseeds itself on
    // the next boot the way a first install does.
    if (method === "POST" && path === "/api/workspace/reset") {
      if (!local) return json(res, 403, { error: "not from here" });
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const archive = `${DATA_DIR}-archived-${stamp}`;
        renameSync(DATA_DIR, archive);
        return json(res, 200, { archivedTo: archive });
      } catch (e) {
        return json(res, 500, {
          error: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200),
        });
      }
    }

    // ── user MCP servers: bring your own tools ──
    if (method === "GET" && path === "/api/mcp-servers") {
      // sanitized: names and shapes, never header values or full commands
      return json(res, 200, {
        servers: (cfg.mcpServers ?? []).map((server) => ({
          id: server.id,
          name: server.name,
          transport: server.transport,
          target:
            server.transport === "http"
              ? (server.url ?? "").replace(/^(https?:\/\/[^\/]+).*$/, "$1")
              : (server.command ?? "").split("/").pop(),
          hasHeaders: Boolean(Object.keys(server.headers ?? {}).length),
        })),
      });
    }
    if (method === "POST" && path === "/api/mcp-servers") {
      const body = await readBody(req);
      const name = clamp(body.name, 40);
      const transport = body.transport === "http" ? ("http" as const) : ("stdio" as const);
      if (!name) return json(res, 400, { error: "a server needs a name" });
      if ((cfg.mcpServers ?? []).length >= 16) {
        return json(res, 507, { error: "at most 16 MCP servers" });
      }
      const entry: NonNullable<AppConfig["mcpServers"]>[number] = {
        id: randomBytes(8).toString("hex"),
        name,
        transport,
      };
      if (transport === "http") {
        entry.url = typeof body.url === "string" && /^https?:\/\//.test(body.url) ? body.url : "";
        if (body.headers && typeof body.headers === "object") {
          entry.headers = Object.fromEntries(
            Object.entries(body.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .slice(0, 8) as Array<[string, string]>,
          );
        }
      } else if (typeof body.commandLine === "string") {
        // The settings screen sends the line exactly as it was typed, so
        // the split happens once, here, with quotes respected. Splitting
        // it on the client as well would mangle a quoted path before the
        // server ever saw it.
        const parts = splitArgs(clamp(body.commandLine, 1200) ?? "");
        entry.command = parts[0] ?? "";
        entry.args = parts.slice(1, 25);
      } else {
        entry.command = clamp(body.command, 300) ?? "";
        // Parsed the way a shell would, not split on whitespace: an
        // argument like "/Users/me/Application Support/x.mjs" is one
        // path, and tearing it in half runs the wrong file with no
        // error worth reading. An array is accepted as given.
        entry.args = Array.isArray(body.args)
          ? (body.args as unknown[]).filter((a): a is string => typeof a === "string").slice(0, 24)
          : typeof body.args === "string"
            ? splitArgs(body.args).slice(0, 24)
            : [];
      }
      if (transport === "http" ? !entry.url : !entry.command) {
        return json(res, 400, { error: transport === "http" ? "a valid http(s) url is required" : "a command is required" });
      }
      saveConfig({ mcpServers: [...(cfg.mcpServers ?? []), entry] } as Partial<AppConfig>);
      Object.assign(cfg, loadConfig());
      return json(res, 201, { id: entry.id });
    }
    m = path.match(/^\/api\/mcp-servers\/([\w-]+)$/);
    if (m && method === "DELETE") {
      mcp.close(m[1]);
      const remaining = (cfg.mcpServers ?? []).filter((server) => server.id !== m![1]);
      if (remaining.length === (cfg.mcpServers ?? []).length) {
        return json(res, 404, { error: "no such server" });
      }
      saveConfig({ mcpServers: remaining } as Partial<AppConfig>);
      Object.assign(cfg, loadConfig());
      // detach it from every agent so nothing dangles
      for (const b of store.bots) {
        if (b.mcpServers?.includes(m![1])) {
          store.patchBot(b.id, { mcpServers: b.mcpServers.filter((id) => id !== m![1]) });
        }
      }
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/choose$/);
    if (m && method === "POST") {
      const [threadId, messageId] = [m[1], m[2]];
      const body = await readBody(req);
      const existing = store.messagesFor(threadId).find((msg) => msg.id === messageId);
      if (!existing || existing.deleted || existing.component?.kind !== "decision") {
        return json(res, 404, { error: "no such decision" });
      }
      const parsed = parseComponent("decision", existing.component);
      if (!parsed.ok || parsed.component.kind !== "decision") {
        return json(res, 409, { error: "this decision has no valid options" });
      }
      const choice = body.choice;
      if (typeof choice !== "number" || !Number.isInteger(choice) || !parsed.component.options[choice]) {
        return json(res, 400, { error: "choose one of the offered options" });
      }
      const key = `${threadId}:${messageId}`;
      if (existing.decisionChoice !== undefined || choosingDecisions.has(key)) {
        return json(res, 409, { error: "this decision has already been answered" });
      }
      const room = bloks.get(threadId);
      const task = store.taskByThread(threadId);
      const bot = room ? store.bot(existing.from ?? "") : task?.bot;
      if (!bot || (room && !room.memberIds.includes(bot.id))) {
        return json(res, 409, { error: "the agent that asked is no longer here" });
      }
      const option = parsed.component.options[choice];
      const text = `${room ? `@${bot.name} ` : ""}${option.label}`;
      const replyTo = { messageId, author: bot.name, excerpt: parsed.component.question.slice(0, 300) };
      choosingDecisions.add(key);
      try {
        if (room) {
          enqueueRoomPost(room, text, { hops: 0, replyTo });
          triggersFired({ kind: "message", targetId: room.id, text, fromUser: true });
        } else {
          await sendUserMessage(bot.id, text, { taskId: threadId, replyTo });
        }
        const message = store.patchMessage(threadId, messageId, { decisionChoice: choice });
        broadcast({ kind: "message.patch", threadId, message: message! });
        return json(res, 200, { message });
      } finally {
        choosingDecisions.delete(key);
      }
    }

    // ── editing and taking back ──
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)$/);
    if (m && (method === "PATCH" || method === "DELETE")) {
      const existing = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      if (!existing) return json(res, 404, { error: "no such message" });

      if (method === "DELETE") {
        // A tombstone, not a hole. Replies that point at this message
        // still make sense, the transcript keeps its shape, and the
        // words themselves are gone from disk and from every engine.
        const patched = store.patchMessage(m[1], m[2], {
          deleted: true,
          text: "",
          card: undefined,
          artifact: undefined,
          png: undefined,
          component: undefined,
        });
        broadcast({ kind: "message.patch", threadId: m[1], message: patched! });
        return json(res, 200, { message: patched });
      }

      // Editing is for your own words. An agent's message is a record of
      // what it said, and rewriting that would make the transcript lie.
      if (existing.role !== "user") {
        return json(res, 403, { error: "only your own messages can be edited" });
      }
      if (existing.deleted) return json(res, 409, { error: "that message was taken back" });
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json(res, 400, { error: "an edited message still needs words" });
      if (text.length > MAX_MESSAGE_CHARS) return json(res, 413, { error: "that message is too long" });
      const patched = store.patchMessage(m[1], m[2], { text, editedAt: Date.now() });
      broadcast({ kind: "message.patch", threadId: m[1], message: patched! });
      return json(res, 200, { message: patched });
    }

    // ── reactions ──
    // A reaction is the cheapest thing a person can say, and in a room
    // full of agents it is often the only thing worth saying: agreeing
    // with a plan should not cost a turn or a line of transcript.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/react$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
      // Reactions are symbols, not labels. Anything with letters, digits
      // or whitespace in it is somebody using this as a text field, and
      // a long one would break the row it renders in.
      const points = [...emoji];
      if (
        !emoji ||
        points.length > 4 ||
        /[\p{L}\p{N}\s]/u.test(emoji)
      ) {
        return json(res, 400, { error: "that is not an emoji" });
      }
      const who = typeof body.who === "string" && store.bot(body.who) ? body.who : "user";
      const result = store.toggleReaction(m[1], m[2], emoji, who);
      if (!result) return json(res, 404, { error: "no such message" });
      broadcast({ kind: "message.patch", threadId: m[1], message: result.message });
      // Taking a reaction back is not a second event. A workflow fires on
      // somebody putting the emoji there, and firing again on its removal
      // would run the work twice for one change of mind.
      if (result.added) {
        // a thread is either a room or an agent's lane; workflows watch
        // whichever of the two this turns out to be
        const owner = bloks.get(m[1]) ? m[1] : (store.taskByThread(m[1])?.bot.id ?? m[1]);
        triggersFired({
          kind: "reaction",
          targetId: owner,
          emoji,
          text: result.message?.text ?? "",
          fromUser: who === "user",
        });
      }
      return json(res, 200, { added: result.added, message: result.message });
    }

    // ── connector cards: sign in from the chat ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/connector-cards\/([\w-]+)\/(authorize|refresh|dismiss)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      // the card lives in one of the bot's lanes; find which
      let threadId: string | null = null;
      let card: Message | undefined;
      for (const lane of bot.tasks) {
        card = store.messagesFor(lane.id).find((msg) => msg.id === m![2] && msg.kind === "connector");
        if (card) {
          threadId = lane.id;
          break;
        }
      }
      if (!card?.connector || !threadId) return json(res, 404, { error: "no such connector card" });
      const patch = (changes: Partial<NonNullable<Message["connector"]>>) => {
        const patched = store.patchMessage(threadId!, card!.id, {
          connector: { ...card!.connector!, ...changes },
        });
        if (patched) broadcast({ kind: "message.patch", threadId: threadId!, message: patched });
        return patched;
      };

      try {
        if (m[3] === "dismiss") {
          patch({ status: "dismissed" });
          return json(res, 200, { ok: true });
        }
        if (m[3] === "authorize") {
          const { url: authUrl } = await composio.beginConnectorAuth(cfg, card.connector.slug);
          patch({ status: "authorizing", authUrl });
          return json(res, 200, { url: authUrl });
        }
        // refresh: has the sign-in landed on the provider side?
        const states = await composio.connectorStates(cfg, [card.connector.slug]);
        if (states[card.connector.slug]?.connected) {
          patch({ status: "connected" });
          if (card.connector.resumeKey) {
            maybeResumeAfterConnect(bot.id, threadId, card.connector.resumeKey);
          }
          return json(res, 200, { connected: true });
        }
        return json(res, 200, { connected: false });
      } catch (e) {
        const error = redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200);
        patch({ status: "failed", error });
        return json(res, 502, { error });
      }
    }

    // ── secret cards: a value saved from the chat, never into it ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(save|dismiss)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      let threadId: string | null = null;
      let card: Message | undefined;
      for (const lane of bot.tasks) {
        card = store.messagesFor(lane.id).find((msg) => msg.id === m![2] && msg.kind === "secret");
        if (card) {
          threadId = lane.id;
          break;
        }
      }
      if (!card?.secret || !threadId) return json(res, 404, { error: "no such secret card" });
      const patch = (changes: Partial<NonNullable<Message["secret"]>>) => {
        const patched = store.patchMessage(threadId!, card!.id, {
          secret: { ...card!.secret!, ...changes },
        });
        if (patched) broadcast({ kind: "message.patch", threadId: threadId!, message: patched });
      };

      if (m[3] === "dismiss") {
        patch({ status: "dismissed" });
        return json(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!value || value.length > 4_000) {
        return json(res, 400, { error: "paste the value first" });
      }
      // straight to the config file; the transcript never sees it
      saveConfig({ secrets: { [card.secret.envName]: value } });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      patch({ status: "saved", resumed: true });
      const already = card.secret.resumed;
      if (!already) {
        void startTurn(
          bot.id,
          `The user saved "${card.secret.label}". It is available to your shell tools as the environment variable ${card.secret.envName}. Continue the task you were working on.`,
          { taskId: threadId, presetMessage: true },
        ).catch((e) => {
          // Same reason as the connector resume: the mark is what stops
          // this firing twice, so leaving it set after a refusal parks
          // the task on a secret that has already been saved.
          if (unresume(threadId, e)) patch({ status: "saved", resumed: false });
        });
      }
      return json(res, 200, { ok: true });
    }

    // ── the call lease ──
    if (method === "POST" && path === "/api/calls/claim") {
      const body = await readBody(req);
      const device = clamp(body.device, 40) ?? "another device";
      const targetId = clamp(body.targetId, 60) ?? "";
      // the device that lost our reply retries with the token it holds;
      // recognizing it beats locking that device out for a whole TTL
      if (activeCall && typeof body.token === "string" && activeCall.token === body.token) {
        activeCall.expiresAt = Date.now() + CALL_TTL_MS;
        return json(res, 200, { token: activeCall.token, ttlMs: CALL_TTL_MS });
      }
      const conflict = callConflict();
      if (conflict) {
        return json(res, 409, {
          error: `already on a call on ${conflict.device}. Hang up there first`,
          device: conflict.device,
        });
      }
      activeCall = {
        token: randomBytes(18).toString("base64url"),
        device,
        targetId,
        expiresAt: Date.now() + CALL_TTL_MS,
      };
      return json(res, 200, { token: activeCall.token, ttlMs: CALL_TTL_MS });
    }
    if (method === "POST" && path === "/api/calls/renew") {
      const body = await readBody(req);
      if (!activeCall || activeCall.token !== body.token || activeCall.expiresAt <= Date.now()) {
        return json(res, 410, { error: "that call lease is gone" });
      }
      activeCall.expiresAt = Date.now() + CALL_TTL_MS;
      return json(res, 200, { ok: true, ttlMs: CALL_TTL_MS });
    }
    if (method === "DELETE" && path === "/api/calls") {
      const body = await readBody(req);
      if (activeCall && activeCall.token === body.token) activeCall = null;
      return json(res, 200, { ok: true });
    }

    // ── memory: what the agent believes, readable and editable ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such agent" });
      const file = workspace.readMemoryFile(m[1]);
      return json(res, 200, { ...file, topics: workspace.listMemoryTopics(m[1]) });
    }
    if (m && method === "PUT") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req);
      if (typeof body.text !== "string") return json(res, 400, { error: "text required" });
      if (Buffer.byteLength(body.text, "utf8") > workspace.MEMORY_FILE_MAX_BYTES) {
        return json(res, 400, {
          error: "memory is capped at 256KB. Move long notes into memory/<topic>.md files",
        });
      }
      workspace.writeMemoryFile(m[1], body.text);
      return json(res, 200, { ok: true, truncated: workspace.readMemoryFile(m[1]).truncated });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/topics\/(.+)$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such agent" });
      // decode BEFORE the gate: an encoded ../ must be judged decoded
      let name = "";
      try {
        name = decodeURIComponent(m[2]);
      } catch {
        return json(res, 400, { error: "bad topic name" });
      }
      const text = workspace.readMemoryTopic(m[1], name);
      if (text === null) return json(res, 404, { error: "no such topic" });
      return json(res, 200, { name, text });
    }

    // ── notes pinned to a place in a deliverable ──
    // Ahead of the artifact route below, which matches anything after
    // the name and would otherwise swallow these.
    m = path.match(/^\/api\/bots\/([\w-]+)\/artifacts\/([^/]+)\/comments$/);
    if (m) {
      const botId = m[1];
      const name = decodeURIComponent(m[2]);
      if (!store.bot(botId)) return json(res, 404, { error: "no such agent" });
      if (method === "GET") {
        return json(res, 200, { comments: artifactComments.for(botId, name) });
      }
      if (method === "POST") {
        const body = await readBody(req);
        // The note has to point somewhere: an unanchored comment is a
        // chat message, and there is already a place for those.
        const anchor = parseAnchor(body.anchor);
        if (!anchor) return json(res, 400, { error: "a note needs a place to point at" });
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return json(res, 400, { error: "a note needs something to say" });
        if (text.length > MAX_COMMENT_CHARS) return json(res, 413, { error: "that note is too long" });
        const comment = artifactComments.add(botId, name, anchor, text);
        if (!comment) return json(res, 507, { error: "that artifact has too many notes" });
        broadcast({ kind: "artifact-comments", botId, artifact: name });
        return json(res, 201, { comment });
      }
    }
    // Hand the open notes to the agent as a message it can act on. The
    // anchors travel as text, because "cell B7" is an address the agent
    // can find in the file, and that is the whole point of pinning them.
    m = path.match(/^\/api\/bots\/([\w-]+)\/artifacts\/([^/]+)\/comments\/send$/);
    if (m && method === "POST") {
      const botId = m[1];
      const name = decodeURIComponent(m[2]);
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const open = artifactComments.for(botId, name).filter((c) => !c.resolved);
      if (open.length === 0) return json(res, 409, { error: "there are no open notes to send" });
      const lines = open.map((c) => `- ${describeAnchor(c.anchor)}: ${c.text}`).join("\n");
      const text = `I left notes on ${name}:\n\n${lines}\n\nPlease work through them and save the corrected file.`;
      // 202 says the work started. It has to be true for every reason it
      // might not have, not only the two this route happened to know
      // about: a busy lane and a missing engine end the same way, with
      // nothing running and the person told it was sent.
      const refused = await startTurn(botId, text).then(
        () => null,
        (e: unknown) => ({
          status: (e as { status?: number }).status ?? 500,
          error: String((e as Error).message),
        }),
      );
      if (refused) return json(res, refused.status, { error: refused.error });
      return json(res, 202, { sent: open.length });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/artifacts\/([^/]+)\/comments\/([\w-]+)$/);
    if (m && (method === "PATCH" || method === "DELETE")) {
      const name = decodeURIComponent(m[2]);
      if (method === "DELETE") {
        const ok = artifactComments.remove(m[3]);
        if (ok) broadcast({ kind: "artifact-comments", botId: m[1], artifact: name });
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such note" });
      }
      const body = await readBody(req);
      const comment = artifactComments.setResolved(m[3], body.resolved === true);
      if (!comment) return json(res, 404, { error: "no such note" });
      broadcast({ kind: "artifact-comments", botId: m[1], artifact: name });
      return json(res, 200, { comment });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/artifacts\/(.+)$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const opened = artifacts.openArtifact(bot.id, decodeURIComponent(m[2]));
      if (!opened) return json(res, 404, { error: "no such file" });
      res.writeHead(200, {
        "content-type": opened.mime,
        "content-length": opened.size,
        // html artifacts render inside a sandboxed iframe; this keeps a
        // hostile file from becoming a same-origin script on the API
        "content-security-policy": "sandbox allow-scripts",
        ...(url.searchParams.has("download")
          ? { "content-disposition": `attachment; filename="${decodeURIComponent(m[2]).replace(/"/g, "")}"` }
          : {}),
      });
      opened.stream.pipe(res);
      return;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req);
      const title = clamp(body.title, 40) || `Task ${bot.tasks.length + 1}`;
      const task = store.createTask(bot.id, title);
      if (!task) return json(res, 409, { error: `an agent runs at most ${MAX_TASKS} tasks` });
      const fresh = store.bot(bot.id)!;
      broadcast({ kind: "bot", bot: clientBot(fresh) });
      return json(res, 201, { bot: { ...clientBot(fresh), messages: store.messagesFor(task.id) } });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)\/activate$/);
    if (m && method === "POST") {
      if (!store.setActiveTask(m[1], m[2])) return json(res, 404, { error: "no such task" });
      const fresh = store.bot(m[1])!;
      broadcast({ kind: "bot", bot: clientBot(fresh) });
      return json(res, 200, { bot: { ...clientBot(fresh), messages: store.messagesFor(m[2]) } });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const outcome = store.deleteTask(m[1], m[2]);
      if (outcome === "missing") return json(res, 404, { error: "no such task" });
      if (outcome === "busy") return json(res, 409, { error: "that task is running, interrupt it first" });
      if (outcome === "last") return json(res, 409, { error: "an agent keeps at least one task" });
      const fresh = store.bot(m[1])!;
      broadcast({ kind: "bot", bot: clientBot(fresh) });
      return json(
        res,
        200,
        { bot: { ...clientBot(fresh), messages: store.messagesFor(fresh.activeTaskId) } },
      );
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req);
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      const requestId = String(body.requestId);
      const askThread = askThreadByRequest.get(requestId) ?? bot.threadId;
      try {
        await instance.adapter.respondToRequest(askThread, requestId, {
          behavior: body.behavior,
          message: body.message,
        });
        return json(res, 200, { ok: true, outcome: "delivered" });
      } catch {
        // The ask is gone: the turn ended, or the engine died. Failing
        // closed beats a 500 that leaves a dead card open forever, the
        // card settles as unanswerable, and the action was never run.
        const messageId = askMessageByRequest.get(requestId);
        if (messageId) {
          const existing = store.messagesFor(askThread).find((msg) => msg.id === messageId);
          if (existing?.card && !existing.card.answered) {
            const patched = store.patchMessage(askThread, messageId, {
              card: { ...existing.card, answered: "unavailable", dismissed: true },
            });
            if (patched) broadcast({ kind: "message.patch", threadId: askThread, message: patched });
          }
          askMessageByRequest.delete(requestId);
          askThreadByRequest.delete(requestId);
        }
        const notice = store.appendMessage(askThread, {
          role: "bot",
          kind: "activity",
          tool: { name: "that request had already closed, nothing was run", ok: false },
        });
        broadcast({ kind: "message", threadId: askThread, message: notice });
        return json(res, 200, { ok: false, outcome: "unavailable" });
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const instance = registry.get(bot.modelSelection.instanceId);
      // a named lane is interruptible even when another lane is on screen
      const laneId =
        typeof body.taskId === "string" && bot.tasks.some((t) => t.id === body.taskId)
          ? body.taskId
          : bot.threadId;
      await instance?.adapter.interruptTurn(laneId);
      return json(res, 200, { ok: true });
    }

    // How the desktop shell recognises the server it just started. A
    // developer's own harness answers this route identically, so the pid
    // is the part that distinguishes ours from theirs.
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "bloks", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe() });
    }

    // ── engines: what you can connect, and how ──
    if (method === "GET" && path === "/api/providers") {
      return json(res, 200, await providerCatalog());
    }

    // The bug-report bundle: facts a public issue can hold. Built from
    // booleans and counts, then scrubbed again; see server/diagnostics.ts.
    if (method === "GET" && path === "/api/diagnostics") {
      // This machine's business. A paired phone has no button that asks,
      // and a leaked token should not read the engine roster either.
      if (!local) return json(res, 403, { error: "not from here" });
      const { providers: rows } = await providerCatalog();
      const speechStatus = speech.speechConfigured(cfg);
      const report = diagnostics.diagnosticsReport({
        version: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        uptimeSeconds: process.uptime(),
        config: {
          xai: Boolean(cfg.xai?.key),
          composioConnect: Boolean(cfg.composio?.key),
          composioApi: Boolean(cfg.composio?.apiKey),
          box: Boolean(cfg.box?.token),
          speechElevenlabs: Boolean(speechStatus.elevenlabs),
          speechOpenai: Boolean(speechStatus.openai),
          compactionMicro: Boolean(cfg.compaction?.micro),
          skillsPropose: Boolean(cfg.skills?.propose),
        },
        engines: rows.map((row: { name: string; connected: boolean; agentic: boolean }) => ({
          name: row.name,
          connected: Boolean(row.connected),
          agentic: Boolean(row.agentic),
        })),
        counts: {
          agents: store.bots.filter((b) => !b.archivedAt).length,
          rooms: bloks.bloks.length,
          skills: listSkills().length,
        },
      });
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(report);
      return;
    }
    m = path.match(/^\/api\/providers\/([\w-]+)\/connect$/);
    if (m && method === "POST") {
      const spec = specFor(m[1]);
      if (!spec) return json(res, 404, { error: "no such provider" });
      if (spec.kind === "custom") {
        return json(res, 400, { error: "add a custom endpoint from Settings" });
      }
      if (spec.auth === "cli") return json(res, 400, { error: `${spec.name} signs in through its own CLI` });
      const body = await readBody(req);
      const key = String(body.key ?? "").trim();
      // an override for people pointing at a proxy or a self-hosted box
      const endpoint = String(body.url ?? "").trim();
      if (spec.auth !== "none" && !key) return json(res, 400, { error: "a key is required" });
      if (key.length > 400 || endpoint.length > 400) return json(res, 413, { error: "that value is too long" });
      if (endpoint && !/^https?:\/\//i.test(endpoint)) {
        return json(res, 400, { error: "the endpoint must be an http or https URL" });
      }
      await connectProvider(spec.kind, key, endpoint);
      return json(res, 200, await providerCatalog());
    }
    m = path.match(/^\/api\/providers\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const spec = specFor(m[1]);
      if (!spec) return json(res, 404, { error: "no such provider" });
      disconnectProvider(spec.kind);
      Object.assign(cfg, loadConfig());
      // loadConfig re-reads the file; drop the key it no longer holds
      delete cfg.providers?.[spec.kind];
      if (spec.kind === "grok") delete cfg.xai;
      await reloadProviders();
      broadcast({ kind: "providers", ...(await providerCatalog()) });
      return json(res, 200, await providerCatalog());
    }

    // ── custom OpenAI-compatible hosts: URL plus one or more keys ──
    if (method === "GET" && path === "/api/custom-endpoints") {
      return json(res, 200, customCatalog());
    }
    if (method === "POST" && path === "/api/custom-endpoints") {
      const body = await readBody(req);
      const name = clamp(body.name, MAX_NAME_CHARS);
      const url = typeof body.url === "string" ? normalizeCompatUrl(body.url) : undefined;
      const parsed = parseCustomKey(body);
      if (!name) return json(res, 400, { error: "a name is required" });
      if (!url) return json(res, 400, { error: "the endpoint must be an http or https URL" });
      if (url.length > MAX_URL_CHARS) return json(res, 413, { error: "that URL is too long" });
      if (parsed.error) return json(res, parsed.error.includes("too long") ? 413 : 400, { error: parsed.error });
      if ((cfg.custom ?? []).length >= MAX_CUSTOM_ENDPOINTS) {
        return json(res, 507, { error: `at most ${MAX_CUSTOM_ENDPOINTS} custom endpoints` });
      }
      const cred: CustomKey = { id: randomBytes(8).toString("hex"), key: parsed.key!, ...(parsed.label ? { label: parsed.label } : {}) };
      const entry: CustomEndpoint = {
        id: randomBytes(8).toString("hex"),
        name,
        url,
        keys: [cred],
        activeKeyId: cred.id,
      };
      await persistCustom([...(cfg.custom ?? []), entry]);
      return json(res, 201, customCatalog());
    }
    m = path.match(/^\/api\/custom-endpoints\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const next = (cfg.custom ?? []).filter((endpoint) => endpoint.id !== m![1]);
      if (next.length === (cfg.custom ?? []).length) return json(res, 404, { error: "no such endpoint" });
      await persistCustom(next);
      return json(res, 200, customCatalog());
    }
    m = path.match(/^\/api\/custom-endpoints\/([\w-]+)\/keys$/);
    if (m && method === "POST") {
      const endpoint = (cfg.custom ?? []).find((entry) => entry.id === m![1]);
      if (!endpoint) return json(res, 404, { error: "no such endpoint" });
      const body = await readBody(req);
      const parsed = parseCustomKey(body);
      if (parsed.error) return json(res, parsed.error.includes("too long") ? 413 : 400, { error: parsed.error });
      if (endpoint.keys.length >= MAX_CUSTOM_KEYS) {
        return json(res, 507, { error: `at most ${MAX_CUSTOM_KEYS} keys on one host` });
      }
      const cred: CustomKey = { id: randomBytes(8).toString("hex"), key: parsed.key!, ...(parsed.label ? { label: parsed.label } : {}) };
      const next = (cfg.custom ?? []).map((entry) =>
        entry.id === endpoint.id ? { ...entry, keys: [...entry.keys, cred] } : entry,
      );
      await persistCustom(next);
      return json(res, 201, customCatalog());
    }
    m = path.match(/^\/api\/custom-endpoints\/([\w-]+)\/keys\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const endpoint = (cfg.custom ?? []).find((entry) => entry.id === m![1]);
      if (!endpoint) return json(res, 404, { error: "no such endpoint" });
      const remaining = endpoint.keys.filter((cred) => cred.id !== m![2]);
      if (remaining.length === endpoint.keys.length) return json(res, 404, { error: "no such key" });
      // the last key is the host: drop the endpoint rather than leave a
      // connected row that cannot talk to anything
      if (!remaining.length) {
        await persistCustom((cfg.custom ?? []).filter((entry) => entry.id !== endpoint.id));
        return json(res, 200, customCatalog());
      }
      const activeKeyId =
        endpoint.activeKeyId === m[2] ? remaining[0].id : endpoint.activeKeyId;
      const next = (cfg.custom ?? []).map((entry) =>
        entry.id === endpoint.id ? { ...entry, keys: remaining, activeKeyId } : entry,
      );
      await persistCustom(next);
      return json(res, 200, customCatalog());
    }
    m = path.match(/^\/api\/custom-endpoints\/([\w-]+)\/keys\/([\w-]+)\/use$/);
    if (m && method === "POST") {
      const endpoint = (cfg.custom ?? []).find((entry) => entry.id === m![1]);
      if (!endpoint) return json(res, 404, { error: "no such endpoint" });
      if (!endpoint.keys.some((cred) => cred.id === m![2])) return json(res, 404, { error: "no such key" });
      const next = (cfg.custom ?? []).map((entry) =>
        entry.id === endpoint.id ? { ...entry, activeKeyId: m![2] } : entry,
      );
      await persistCustom(next);
      return json(res, 200, customCatalog());
    }

    // ── browser sign-in (OAuth PKCE) ──
    m = path.match(/^\/api\/oauth\/([\w-]+)\/start$/);
    if (m && method === "POST") {
      if (!supportsOAuth(m[1])) {
        return json(res, 400, { error: `${m[1]} does not offer a browser sign-in` });
      }
      const { url: authUrl } = startOAuth(m[1], oauthCallback(m[1]));
      return json(res, 200, { url: authUrl });
    }
    m = path.match(/^\/api\/oauth\/([\w-]+)\/callback$/);
    if (m && method === "GET") {
      const kind = m[1];
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code) {
        return html(res, 400, callbackPage(false, "No authorization code came back. Try again from Bloks."));
      }
      try {
        const key = await finishOAuth(kind, state, code, oauthCallback(kind));
        await connectProvider(kind, key);
        return html(res, 200, callbackPage(true, "You can close this tab and go back to Bloks."));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return html(res, 400, callbackPage(false, redactSecrets(message)));
      }
    }

    // ── hiring a proposed team ──
    m = path.match(/^\/api\/teams\/([\w-]+)\/hire$/);
    if (m && method === "POST") {
      const messageId = m[1];
      const body = await readBody(req);
      // Take the plan off the pending map first, so a double click hires
      // one team rather than two.
      const pending = teamPlans.get(messageId) ?? recoverPlan(messageId, String(body.botId ?? ""));
      teamPlans.delete(messageId);
      if (!pending) return json(res, 404, { error: "that proposal is no longer available" });
      const lead = store.bot(pending.leadId);
      if (!lead) return json(res, 404, { error: "the hiring agent is gone" });

      // New hires do the volume, so they get the cheapest model the lead's
      // provider offers; the lead keeps its own, costlier one for review.
      // That is the whole economics of the thing: cheap hands, expensive
      // judgement.
      const instance = registry.get(lead.modelSelection.instanceId);
      const options = instance?.models.options ?? [];
      const cheap =
        options.find((o) => /haiku|mini|flash|small|lite/i.test(o.id))?.id ??
        lead.modelSelection.model;

      const hires = pending.plan.members.slice(0, MAX_HIRES).map((member) =>
        store.createBot({
          name: member.name,
          title: member.title,
          description: member.description,
          skills: member.skills,
          seniority: 1,
          greeting: `${member.name} here. ${member.title || "Ready to work."}`,
          setup: {
            title: `Hired by ${lead.name}`,
            subtitle: `I work on "${pending.plan.room}" and report to ${lead.name}. You can talk to me here any time.`,
            options: [],
          },
        }),
      );
      for (const hire of hires) {
        store.patchBot(hire.id, {
          modelSelection: { instanceId: lead.modelSelection.instanceId, model: cheap },
        });
        broadcast({
          kind: "bot",
          bot: { ...clientBot(store.bot(hire.id))!, messages: store.messagesFor(hire.threadId) },
        });
      }

      const blok = bloks.create(pending.plan.room, [lead.id, ...hires.map((h) => h.id)]);
      broadcast({ kind: "blok", blok });

      // settle the proposal so it reads as decided everywhere
      const proposal = store.messagesFor(lead.threadId).find((msg) => msg.id === messageId);
      if (proposal?.card) {
        const patched = store.patchMessage(lead.threadId, messageId, {
          card: { ...proposal.card, answered: "Hire the team" },
        });
        if (patched) broadcast({ kind: "message.patch", threadId: lead.threadId, message: patched });
      }

      // the lead opens with its own brief, which is what starts the work
      const brief =
        pending.plan.brief ||
        "Here is what we are doing. Take your part and come back with the actual work.";
      void postToRoom(blok, brief, { botId: lead.id, hops: 0, toAll: true }).catch(() => {});

      return json(res, 201, {
        blok: { ...blok, messages: store.messagesFor(blok.id) },
        hired: hires.map((h) => h.id),
      });
    }

    // ── rooms (bloks with more than one agent) ──
    if (method === "GET" && path === "/api/bloks") {
      // The person sees every room and everything said in it. An agent
      // sees the transcripts of the rooms it is in, and no more than the
      // name and roster of the rest: enough to ask to be added to one,
      // which is the only reason it needs to know they exist.
      return json(res, 200, {
        bloks: bloks.bloks.map((b) =>
          !asAgent || b.memberIds.includes(asAgent.botId)
            ? { ...b, messages: store.messagesFor(b.id) }
            : { id: b.id, name: b.name, memberIds: b.memberIds, archived: b.archived, messages: [] },
        ),
      });
    }
    if (method === "POST" && path === "/api/bloks") {
      const body = await readBody(req);
      const memberIds = Array.isArray(body.memberIds)
        ? (body.memberIds as unknown[]).filter(
            (id): id is string => typeof id === "string" && Boolean(store.bot(id)),
          )
        : [];
      if (memberIds.length < 2) {
        return json(res, 400, { error: "a room needs at least two agents" });
      }
      if (memberIds.length > MAX_MEMBERS) {
        return json(res, 400, { error: `a room holds at most ${MAX_MEMBERS} agents` });
      }
      // Whoever opened it is in it. An agent that left itself off the
      // roster would have made a room it cannot speak in.
      if (asAgent && !memberIds.includes(asAgent.botId)) memberIds.unshift(asAgent.botId);
      const blok = bloks.create(clamp(body.name, MAX_NAME_CHARS) ?? "", memberIds);
      // open with the roster so the transcript explains itself later
      const names = memberIds.map((id) => store.bot(id)!.name).join(", ");
      store.appendMessage(blok.id, {
        role: "bot",
        kind: "text",
        text: `Room opened with ${names}. Mention someone with @name, or just talk and everyone answers.`,
      });
      broadcast({ kind: "blok", blok });
      return json(res, 201, { blok: { ...blok, messages: store.messagesFor(blok.id) } });
    }
    m = path.match(/^\/api\/bloks\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: { name?: string; memberIds?: string[]; leadOnly?: boolean; cwd?: string; archived?: boolean; section?: string | null } = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.leadOnly === "boolean") patch.leadOnly = body.leadOnly;
      if (typeof body.archived === "boolean") patch.archived = body.archived;
      if (body.section !== undefined) {
        const named = normalizeSection(body.section);
        if (!named.ok) return json(res, 400, { error: named.error });
        patch.section = named.section;
      }
      if ("cwd" in body) {
        const existing = bloks.get(m[1]);
        if (existing?.pinnedCwd !== undefined) {
          return json(res, 409, {
            error: "this room already works in its folder. Make a new room to work elsewhere",
          });
        }
        const checked = workspace.validateWorkingFolder(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.path ?? undefined;
      }
      if (Array.isArray(body.memberIds)) {
        patch.memberIds = (body.memberIds as unknown[]).filter(
          (id): id is string => typeof id === "string" && Boolean(store.bot(id)),
        );
      }
      const blok = bloks.patch(m[1], patch);
      if (!blok) return json(res, 404, { error: "no such room" });
      broadcast({ kind: "blok", blok });
      return json(res, 200, { blok });
    }
    if (m && method === "DELETE") {
      const ok = bloks.remove(m[1]);
      if (ok) routines.removeForTarget(m[1]);
      if (ok) workflows.removeTarget(m[1]);
      if (ok) broadcast({ kind: "blok.deleted", blokId: m[1] });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such room" });
    }
    m = path.match(/^\/api\/bloks\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const blok = bloks.get(m[1]);
      if (!blok) return json(res, 404, { error: "no such room" });
      const roomBody = await readBody(req);
      const raw = roomBody.text;
      if (typeof raw === "string" && raw.length > MAX_MESSAGE_CHARS) {
        return json(res, 413, { error: "that message is too long to send in one go" });
      }
      const text = clamp(raw, MAX_MESSAGE_CHARS);
      if (!text) {
        return json(res, 400, { error: "text required" });
      }
      // a human message starts a fresh chain, so hop counters reset
      for (const id of blok.memberIds) agentHops.delete(id);
      const { message } = enqueueRoomPost(blok, text, {
        hops: 0,
        replyTo: replyRef(roomBody.replyTo),
      });
      triggersFired({ kind: "message", targetId: blok.id, text, fromUser: true });
      return json(res, message.queued ? 202 : 201, { message });
    }

    // ── team manifests: a room and its people as a file ──
    // Export carries no ids, no cursors and no transcripts: it is the job
    // descriptions, which is the shareable part. Import builds new agents.
    m = path.match(/^\/api\/bloks\/([\w-]+)\/manifest$/);
    if (m && method === "GET") {
      const blok = bloks.get(m[1]);
      if (!blok) return json(res, 404, { error: "no such room" });
      const members = blok.memberIds
        .map((id) => store.bot(id))
        .filter((b): b is BotRecord => Boolean(b))
        .map((b) => ({
          name: b.name,
          title: b.title,
          description: b.description,
          skills: b.skills ?? [],
          seniority: b.seniority ?? 1,
          color: b.color,
          shape: b.shape,
        }));
      return json(res, 200, { bloksTeam: 1, name: blok.name, members });
    }
    // Point at a folder, get a proposed roster for the hire dialog. Read
    // only; nothing is created until the user hires.
    if (method === "POST" && path === "/api/teams/scout") {
      // Reads directory names off this machine's disk; only this machine
      // gets to point it anywhere. The scout button exists only on the
      // desktop, beside the native picker.
      if (!local) return json(res, 403, { error: "not from here" });
      const body = await readBody(req);
      const checked = workspace.validateWorkingFolder(body.path);
      if (!checked.ok) return json(res, 400, { error: checked.error });
      if (!checked.path) return json(res, 400, { error: "a folder is required" });
      try {
        return json(res, 200, { team: scout.scoutFolder(checked.path), path: checked.path });
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }

    if (method === "POST" && path === "/api/teams/import") {
      const body = await readBody(req);
      const rows: any[] = Array.isArray(body.members) ? body.members : [];
      const profiles = rows
        .map((row) => ({
          name: clamp(row?.name, MAX_NAME_CHARS),
          title: clamp(row?.title, MAX_TITLE_CHARS) ?? "",
          description: clamp(row?.description, MAX_DESCRIPTION_CHARS) ?? "",
          skills: clampList(row?.skills, MAX_SKILL_CHARS, MAX_SKILLS),
          seniority:
            typeof row?.seniority === "number"
              ? Math.max(1, Math.min(5, Math.round(row.seniority)))
              : 1,
          ...(typeof row?.color === "string" ? { color: row.color } : {}),
          ...(typeof row?.shape === "string" ? { shape: row.shape } : {}),
        }))
        .filter((profile) => profile.name)
        .slice(0, MAX_MEMBERS) as NewBotProfile[];
      const existing = (Array.isArray(body.existingMemberIds) ? body.existingMemberIds : [])
        .filter((id: unknown): id is string => typeof id === "string" && Boolean(store.bot(id)))
        .slice(0, MAX_MEMBERS);
      if (profiles.length + existing.length < 2) {
        return json(res, 400, { error: "a team needs at least two members" });
      }
      // What the team is for, in the user's own words. It rides into
      // every member's description so the first turn already knows the
      // project, instead of a room of strangers asking what this is.
      const brief = clamp(body.brief, 600);
      const desk = typeof body.cwd === "string" ? body.cwd.trim() : "";
      // Checked before anything is created: a mistyped desk used to be
      // dropped on the floor after the dialog had already said yes, and a
      // room that quietly ignores the folder it was given is worse than
      // an error. The dialog shows this message next to the field.
      const resolvedDesk = desk ? workspace.validateWorkingFolder(desk) : null;
      if (resolvedDesk && !resolvedDesk.ok) {
        return json(res, 400, { error: resolvedDesk.error });
      }
      const hired = profiles.map((profile) =>
        store.createBot({
          ...profile,
          description: brief
            ? `${profile.description}\n\nWhat this team is working on: ${brief}`.trim()
            : profile.description,
          greeting: `${profile.name} here. ${profile.title || "Ready to work."}`,
          setup: { title: "Imported with the team", subtitle: "", options: [] },
        }),
      );
      const selection = await defaultSelection();
      for (const hire of hired) {
        store.patchBot(hire.id, { modelSelection: selection });
        broadcast({
          kind: "bot",
          bot: { ...clientBot(store.bot(hire.id))!, messages: store.messagesFor(hire.threadId) },
        });
      }
      const blok = bloks.create(
        clamp(body.name, MAX_NAME_CHARS) ?? "Imported team",
        [...existing, ...hired.map((h) => h.id)],
      );
      // one desk for the whole room, when they were pointed at a folder
      if (resolvedDesk?.ok && resolvedDesk.path) bloks.patch(blok.id, { cwd: resolvedDesk.path });
      if (brief) {
        const note = store.appendMessage(blok.id, {
          role: "bot",
          kind: "text",
          text: `The brief for this team: ${brief}`,
        });
        broadcast({ kind: "message", threadId: blok.id, message: note });
      }
      broadcast({ kind: "blok", blok });
      return json(res, 201, { blok: { ...blok, messages: store.messagesFor(blok.id) } });
    }

    // ── search: every transcript, one query ──
    // A linear scan over the in-memory message stores. At personal-app
    // scale that is thousands of rows, not millions; an index would be
    // more machinery than the data deserves.
    if (method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
      if (!q) return json(res, 200, { hits: [] });
      const hits: object[] = [];
      const snip = (text: string) => {
        const flat = text.replace(/\s+/g, " ").trim();
        const at = flat.toLowerCase().indexOf(q);
        if (at < 0) return flat.slice(0, 120);
        const from = Math.max(0, at - 50);
        const to = Math.min(flat.length, at + q.length + 80);
        return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
      };
      for (const bot of store.bots) {
        if (bot.hidden) continue;
        for (const task of bot.tasks) {
          for (const message of store.messagesFor(task.id)) {
            if (message.kind !== "text" || !message.text) continue;
            if (!message.text.toLowerCase().includes(q)) continue;
            hits.push({
              threadId: task.id,
              messageId: message.id,
              at: message.at,
              role: message.role,
              snippet: snip(message.text),
              botId: bot.id,
              name: bot.name,
              task: task.title,
            });
          }
        }
      }
      for (const blok of bloks.bloks) {
        for (const message of store.messagesFor(blok.id)) {
          if (message.kind !== "text" || !message.text) continue;
          if (!message.text.toLowerCase().includes(q)) continue;
          hits.push({
            threadId: blok.id,
            messageId: message.id,
            at: message.at,
            role: message.role,
            snippet: snip(message.text),
            blokId: blok.id,
            name: blok.name,
          });
        }
      }
      hits.sort((a: any, b: any) => b.at - a.at);
      return json(res, 200, { hits: hits.slice(0, limit) });
    }

    // ── saved team library: your own rooms, banked as manifests ──
    // The same member shape import consumes, so a saved team and a
    // premade one hire through the identical door.
    if (method === "GET" && path === "/api/team-library") {
      return json(res, 200, { teams: teamLibrary.list() });
    }
    if (method === "POST" && path === "/api/team-library") {
      const body = await readBody(req);
      const name = clamp(body.name, MAX_NAME_CHARS);
      const rows: any[] = Array.isArray(body.members) ? body.members : [];
      if (!name || rows.length < 2) {
        return json(res, 400, { error: "a saved team needs a name and at least two members" });
      }
      const saved = teamLibrary.save(name, rows.slice(0, MAX_MEMBERS));
      return json(res, 201, { team: saved });
    }
    m = path.match(/^\/api\/team-library\/([\w-]+)$/);
    if (m && method === "DELETE") {
      teamLibrary.remove(m[1]);
      return json(res, 200, { ok: true });
    }

    // ── webhooks ──
    if (method === "GET" && path === "/api/webhooks") {
      const botId = url.searchParams.get("botId") ?? undefined;
      const blokId = url.searchParams.get("blokId") ?? undefined;
      const workflowId = url.searchParams.get("workflowId") ?? undefined;
      const list =
        botId || blokId || workflowId ? webhooks.for({ botId, blokId, workflowId }) : webhooks.hooks;
      return json(res, 200, { webhooks: list });
    }
    if (method === "POST" && path === "/api/webhooks") {
      const body = await readBody(req);
      const botId = typeof body.botId === "string" ? body.botId : undefined;
      const blokId = typeof body.blokId === "string" ? body.blokId : undefined;
      if (botId && !store.bot(botId)) return json(res, 404, { error: "no such agent" });
      if (blokId && !bloks.get(blokId)) return json(res, 404, { error: "no such room" });
      const workflowId = typeof body.workflowId === "string" && workflows.get(body.workflowId) ? body.workflowId : undefined;
      if (!botId && !blokId && !workflowId) return json(res, 400, { error: "a webhook needs a target" });
      const hook = webhooks.create(String(body.name ?? ""), { botId, blokId, workflowId });
      if (!hook) return json(res, 409, { error: "webhook limit reached" });
      return json(res, 201, { webhook: hook });
    }
    m = path.match(/^\/api\/webhooks\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      let hook = null;
      if (typeof body.enabled === "boolean") hook = webhooks.setEnabled(m[1], body.enabled);
      if (typeof body.name === "string") hook = webhooks.rename(m[1], body.name);
      return json(res, hook ? 200 : 404, hook ? { webhook: hook } : { error: "no such webhook" });
    }
    if (m && method === "DELETE") {
      const ok = webhooks.remove(m[1]);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such webhook" });
    }
    m = path.match(/^\/api\/webhooks\/([\w-]+)\/rotate$/);
    if (m && method === "POST") {
      const hook = webhooks.rotate(m[1]);
      return json(res, hook ? 200 : 404, hook ? { webhook: hook } : { error: "no such webhook" });
    }

    // ── skills (markdown instruction sets, shared across agents) ──
    // ── a terminal, in the agent's folder ──
    // Local only, every one of them. This is a shell on this Mac with
    // this account's privileges, and a paired phone reaching it over the
    // relay would be a remote shell on somebody's laptop. Whatever else
    // pairing is for, it is not for that.
    m = path.match(/^\/api\/bots\/([\w-]+)\/terminal$/);
    if (m && method === "POST") {
      if (!local) return json(res, 403, { error: "not from here" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      // the agent's chosen folder if it has one, its own workspace if not,
      // which is the same rule a turn runs under
      const cwd = bot.cwd || workspace.ensureWorkspace(bot.id);
      try {
        const session = terminals.open({
          botId: bot.id,
          cwd,
          cols: clampCols(body.cols),
          rows: clampRows(body.rows),
          now: Date.now(),
        });
        return json(res, 200, { terminal: session.info() });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : "no terminal" });
      }
    }
    if (m && method === "GET") {
      if (!local) return json(res, 403, { error: "not from here" });
      const session = terminals.get(m[1]);
      return json(res, 200, { terminal: session ? session.info() : null });
    }
    if (m && method === "DELETE") {
      if (!local) return json(res, 403, { error: "not from here" });
      terminals.close(m[1]);
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/terminal\/input$/);
    if (m && method === "POST") {
      if (!local) return json(res, 403, { error: "not from here" });
      const session = terminals.get(m[1]);
      if (!session) return json(res, 409, { error: "no terminal open" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (typeof body.data === "string") {
        if (Buffer.byteLength(body.data, "utf8") > MAX_INPUT_BYTES) {
          return json(res, 413, { error: "that is more than a terminal takes at once" });
        }
        if (!session.write(body.data)) return json(res, 409, { error: "the shell has gone" });
      }
      if (body.cols !== undefined || body.rows !== undefined) {
        session.resize(clampCols(body.cols ?? session.cols), clampRows(body.rows ?? session.rows));
      }
      return json(res, 200, { ok: true });
    }

    // The output, as its own stream. Not the app's event bus: this is one
    // client watching one shell, and terminal bytes have no business in a
    // ring buffer every other client replays.
    m = path.match(/^\/api\/bots\/([\w-]+)\/terminal\/stream$/);
    if (m && method === "GET") {
      if (!local) return json(res, 403, { error: "not from here" });
      const session = terminals.get(m[1]);
      if (!session) return json(res, 409, { error: "no terminal open" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (chunk: Buffer) => {
        try {
          // base64, because the stream is bytes and SSE is lines
          res.write(`data: ${JSON.stringify({ b64: chunk.toString("base64") })}\n\n`);
        } catch {
          /* the client went away mid-write; the close handler tidies up */
        }
      };
      const { replay, detach } = session.attach(send, () => {
        try {
          res.write(`data: ${JSON.stringify({ bye: session.info() })}\n\n`);
        } catch {
          /* nobody there any more */
        }
      });
      res.write(`data: ${JSON.stringify({ hello: session.info() })}\n\n`);
      if (replay.length) send(replay);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        detach();
      });
      return;
    }

    // ── what a server can draw ──
    // An MCP server is a list of functions until something draws it. A
    // server that publishes an interface gets it framed here, on our
    // terms: no origin of its own, no network at all, and only the tools
    // it published may be called back.
    m = path.match(/^\/api\/mcp-servers\/([\w-]+)\/apps$/);
    if (m && method === "GET") {
      if (!local) return json(res, 403, { error: "not from here" });
      const server = (cfg.mcpServers ?? []).find((s) => s.id === m![1]);
      if (!server) return json(res, 404, { error: "no such server" });
      try {
        const [resources, tools] = await Promise.all([mcp.resources(server), mcp.tools(server)]);
        return json(res, 200, {
          apps: appsIn(resources),
          tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 200) })),
        });
      } catch (e) {
        mcp.close(server.id);
        return json(res, 502, { error: e instanceof Error ? e.message : "that server would not answer" });
      }
    }

    // The document itself, already framed. Served as HTML rather than as
    // a string in JSON so the frame can hold it directly and a client has
    // no chance to assemble it into something else.
    m = path.match(/^\/api\/mcp-servers\/([\w-]+)\/apps\/view$/);
    if (m && method === "POST") {
      if (!local) return json(res, 403, { error: "not from here" });
      const server = (cfg.mcpServers ?? []).find((s) => s.id === m![1]);
      if (!server) return json(res, 404, { error: "no such server" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const uri = typeof body.uri === "string" ? body.uri : "";
      if (!uri) return json(res, 400, { error: "which app" });
      try {
        const resources = await mcp.resources(server);
        // only something the server itself listed as an interface: a
        // client does not get to name any uri and have us read it
        if (!appsIn(resources).some((app) => app.uri === uri)) {
          return json(res, 404, { error: "that server does not publish that" });
        }
        const document = documentIn(await mcp.read(server, uri));
        if (document === null) return json(res, 415, { error: "that app is not something we can show" });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "sandbox allow-scripts",
        });
        return res.end(frameDocument(document, themeFrom(body.theme)));
      } catch (e) {
        mcp.close(server.id);
        return json(res, 502, { error: e instanceof Error ? e.message : "that server would not answer" });
      }
    }

    // What a framed app asked for, once the client has decided the
    // message was one of the shapes we accept.
    m = path.match(/^\/api\/mcp-servers\/([\w-]+)\/apps\/act$/);
    if (m && method === "POST") {
      if (!local) return json(res, 403, { error: "not from here" });
      const server = (cfg.mcpServers ?? []).find((s) => s.id === m![1]);
      if (!server) return json(res, 404, { error: "no such server" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const message = parseAppMessage(body.message);
      if (!message) return json(res, 400, { error: "that is not something an app may ask for" });
      if (message.kind !== "tool") return json(res, 200, { handled: message });
      try {
        const tools = await mcp.tools(server);
        if (!allowsTool(tools, message.tool)) {
          return json(res, 403, { error: "that server does not publish that tool" });
        }
        const result = await mcp.call(server, message.tool, message.args);
        return json(res, 200, { text: textOf(result), result });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : "that tool would not run" });
      }
    }

    // ── who an agent's credential says it is ──
    // The one route that exists only for the command line. Everything
    // else it does is a route the app already has.
    if (method === "GET" && path === "/api/agent/whoami") {
      if (!asAgent) return json(res, 401, { error: "no agent credential on this request" });
      const bot = store.bot(asAgent.botId);
      return json(res, 200, {
        botId: asAgent.botId,
        name: bot?.name ?? "",
        title: bot?.title ?? "",
        taskId: asAgent.taskId,
        fingerprint: identityFor(asAgent.botId).fingerprint,
        can: capabilities(),
      });
    }

    // ── projects ──
    // A named thing you switch into: folders, people and a standing
    // brief. A lens rather than a container, so nothing is moved into it
    // and nothing is hidden from anyone.
    if (method === "GET" && path === "/api/projects") {
      return json(res, 200, {
        projects: projects.list(url.searchParams.get("archived") === "1").map(standingOf),
      });
    }
    if (method === "POST" && path === "/api/projects") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const project = projects.create(body, Date.now());
      broadcast({ kind: "projects" });
      return json(res, 201, { project: standingOf(project) });
    }
    m = path.match(/^\/api\/projects\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const project = projects.patch(m[1], body);
      if (!project) return json(res, 404, { error: "no such project" });
      broadcast({ kind: "projects" });
      return json(res, 200, { project: standingOf(project) });
    }
    if (m && method === "DELETE") {
      // archived rather than deleted, so a finished project stops
      // appearing without taking its history with it
      const archive = url.searchParams.get("forget") !== "1";
      const done = archive ? Boolean(projects.archive(m[1], Date.now())) : projects.remove(m[1]);
      if (!done) return json(res, 404, { error: "no such project" });
      broadcast({ kind: "projects" });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/projects\/([\w-]+)\/open$/);
    if (m && method === "POST") {
      const project = projects.opened(m[1], Date.now());
      if (!project) return json(res, 404, { error: "no such project" });
      broadcast({ kind: "projects" });
      return json(res, 200, { project: standingOf(project) });
    }

    // ── the job board ──
    // Work posted without naming who does it. The board offers it to
    // whoever looks most suited and that agent may hand it back, which is
    // what makes taking it mean anything.
    if (method === "GET" && path === "/api/jobs") {
      return json(res, 200, { jobs: jobs.list() });
    }
    if (method === "POST" && path === "/api/jobs") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const title = clamp(body.title, MAX_TITLE_CHARS) ?? "";
      const brief = clamp(body.brief, MAX_DESCRIPTION_CHARS) ?? "";
      if (!title && !brief) return json(res, 400, { error: "a job needs something to do" });
      const job = jobs.post({ title: title || brief.slice(0, 80), brief: brief || title, now: Date.now() });
      record({
        at: Date.now(),
        kind: "job.posted",
        actor: "you",
        summary: `Posted "${job.title}" to the board`,
        detail: { job: job.id },
      });
      broadcast({ kind: "jobs" });
      // offered in the background: posting should not wait on a turn
      void offerJob(job.id);
      return json(res, 201, { job: jobs.get(job.id) });
    }
    m = path.match(/^\/api\/jobs\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such job" });
      // a job in flight is cancelled rather than erased, because the turn
      // doing it is still out there and its result has to land somewhere
      if (job.state === "claimed") {
        jobs.cancel(job.id, Date.now());
      } else {
        jobs.remove(job.id);
      }
      broadcast({ kind: "jobs" });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/jobs\/([\w-]+)\/offer$/);
    if (m && method === "POST") {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such job" });
      if (job.state === "claimed") return json(res, 409, { error: "somebody is on it" });
      // asking again after everyone has passed starts the round over
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (body.again) jobs.patch(job.id, { offers: [], state: "open", result: undefined });
      else jobs.patch(job.id, { state: "open" });
      const offered = await offerJob(job.id);
      return json(res, 200, { job: offered ?? jobs.get(job.id) });
    }

    // ── the record ──
    // Read it, and check it. The check re-reads the file from the
    // beginning rather than trusting what is in memory, because what is in
    // memory is exactly what a tampered file would not disagree with.
    if (method === "GET" && path === "/api/ledger") {
      const asked = Number(url.searchParams.get("limit") ?? NaN);
      const limit = Number.isFinite(asked) ? Math.max(1, Math.min(500, Math.round(asked))) : 100;
      // Each entry with the verdict on its own signature, rather than one
      // verdict for the file: "the chain holds" and "this line is really
      // from Ivy" are different questions and a reader deserves both.
      const entries = ledger.list(limit).map((entry) => {
        const who = attribution(entry);
        return who.state === "unsigned" ? entry : { ...entry, signature: who.state, signedBy: who.by };
      });
      return json(res, 200, { entries, strayLines: ledger.strayLines });
    }
    if (method === "GET" && path === "/api/ledger/verify") {
      return json(res, 200, { result: await ledger.verify() });
    }

    // ── the catalog ──
    // Browsing is the easy half. The half that matters is what it says
    // about a skill you already have: see server/skill-registry.ts.
    if (method === "GET" && path === "/api/skills/registry") {
      try {
        const entries = await loadCatalog(url.searchParams.get("refresh") === "1");
        const rows = listing(entries, installedMarks());
        return json(res, 200, { skills: rows, updates: updateCount(rows) });
      } catch (e) {
        return json(res, 502, {
          error: e instanceof Error ? e.message : "the catalog could not be reached",
        });
      }
    }
    m = path.match(/^\/api\/skills\/registry\/([\w-]+)$/);
    if (m && method === "POST") {
      try {
        const entries = await loadCatalog(false);
        const entry = entries.find((e) => e.id === m![1]);
        if (!entry) return json(res, 404, { error: "the catalog does not have that" });
        const skill = installSkill({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          body: entry.body,
          ...markFor(entry),
        });
        broadcast({ kind: "skills" });
        record({
          at: Date.now(),
          kind: "skill.installed",
          actor: "you",
          summary: `Installed ${entry.name} from the catalog`,
          detail: { skill: entry.id, version: entry.version },
        });
        return json(res, 200, { skill });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 502;
        return json(res, status, { error: e instanceof Error ? e.message : "that would not install" });
      }
    }

    // ── skills the workspace suggested ──
    // Always staged, never installed. See server/proposals.ts for why
    // that is the whole shape of the feature rather than a caution on it.
    if (method === "GET" && path === "/api/skills/proposals") {
      return json(res, 200, { proposals: proposals.list() });
    }
    m = path.match(/^\/api\/skills\/proposals\/([\w-]+)$/);
    if (m && method === "POST") {
      const staged = proposals.get(m[1]);
      if (!staged) return json(res, 404, { error: "no such suggestion" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      // Edited before approving is the ordinary case, not an exception:
      // the suggestion is a draft with the words already written.
      try {
        const skill = installSkill({
          ...(staged.kind === "patch" && staged.skillId ? { id: staged.skillId } : {}),
          name: typeof body.name === "string" ? body.name : staged.name,
          description: typeof body.description === "string" ? body.description : staged.description,
          body: typeof body.body === "string" ? body.body : staged.body,
        });
        proposals.remove(staged.id);
        record({
          at: Date.now(),
          kind: "skill.installed",
          actor: "you",
          summary: `Kept ${skill.name}, suggested by ${staged.botName}`,
          detail: { skill: skill.id, from: staged.botName, kind: staged.kind },
        });
        broadcast({ kind: "skills" });
        return json(res, 200, { skill });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 400;
        return json(res, status, { error: e instanceof Error ? e.message : "that would not install" });
      }
    }
    if (m && method === "DELETE") {
      const ok = proposals.remove(m[1]);
      if (ok) broadcast({ kind: "skills" });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such suggestion" });
    }

    if (method === "GET" && path === "/api/skills") {
      return json(res, 200, { skills: listSkills() });
    }
    if (method === "POST" && path === "/api/skills") {
      const body = await readBody(req);
      try {
        const skill = installSkill({
          markdown: typeof body.markdown === "string" ? body.markdown : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
          id: typeof body.id === "string" ? body.id : undefined,
        });
        broadcast({ kind: "skills" });
        record({
          at: Date.now(),
          kind: "skill.installed",
          actor: "you",
          summary: `Added the skill ${skill.name}`,
          detail: { skill: skill.id },
        });
        return json(res, 201, { skill });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 400;
        return json(res, status, { error: e instanceof Error ? e.message : "bad skill" });
      }
    }
    m = path.match(/^\/api\/skills\/([\w.-]+)$/);
    if (m && method === "GET") {
      // One skill, in full. This is the other half of keeping long skills
      // out of the prompt: withholding a body is only deferring it if
      // there is something to fetch it with. See server/skills.ts.
      const found = listSkills().find((s) => s.id === m![1]);
      if (!found) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { skill: found });
    }
    if (m && method === "DELETE") {
      const ok = deleteSkill(m[1]);
      if (ok) {
        broadcast({ kind: "skills" });
        record({
          at: Date.now(),
          kind: "skill.deleted",
          actor: "you",
          summary: `Removed the skill ${m[1]}`,
          detail: { skill: m[1] },
        });
      }
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such skill" });
    }


    // ── workflows ──
    // A trigger, some steps, and somewhere a person says yes. See
    // server/workflows.ts for why a run is state on disk rather than a
    // promise nobody can restart.
    if (method === "GET" && path === "/api/workflows") {
      return json(res, 200, { workflows: workflows.list().map(withSummary) });
    }
    if (method === "POST" && path === "/api/workflows") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const input = cleanWorkflow(body);
      if (!input) return json(res, 400, { error: "that is not a workflow" });
      // Said before anything is stored, because the thing worth catching
      // here is a step reading a later step's answer: at run time that is
      // a silent gap in a prompt hours later, and nobody connects it back.
      const wrong = workflowProblems(input);
      if (wrong.length) return json(res, 400, { error: wrong[0], problems: wrong });
      const workflow = workflows.create(input, Date.now());
      if (!workflow) return json(res, 409, { error: `that is as many workflows as one workspace holds` });
      broadcast({ kind: "workflows" });
      return json(res, 201, { workflow: withSummary(workflow) });
    }
    m = path.match(/^\/api\/workflows\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const existing = workflows.get(m[1]);
      if (!existing) return json(res, 404, { error: "no such workflow" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      // enabling or disabling is the one change that is not a rewrite,
      // and it should not have to resend a valid workflow to do it
      if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
        const patched = workflows.patch(m[1], { enabled: body.enabled });
        broadcast({ kind: "workflows" });
        return json(res, 200, { workflow: patched && withSummary(patched) });
      }
      const input = cleanWorkflow({ ...existing, ...body });
      if (!input) return json(res, 400, { error: "that is not a workflow" });
      const wrong = workflowProblems(input);
      if (wrong.length) return json(res, 400, { error: wrong[0], problems: wrong });
      // A run holds a cursor into the step list it started with. Change
      // the steps underneath it and that cursor points at a different
      // step, so a run parked on an approval would resume into whatever
      // now sits at that index: the person answers one question and
      // something else happens. A run following a plan that no longer
      // exists is stopped rather than rewired.
      const rewritten = JSON.stringify(existing.steps) !== JSON.stringify(input.steps);
      const patched = workflows.patch(m[1], input);
      if (rewritten) stopRunsOnEdit(m[1]);
      broadcast({ kind: "workflows" });
      return json(res, 200, { workflow: patched && withSummary(patched) });
    }
    if (m && method === "DELETE") {
      const ok = workflows.remove(m[1]);
      if (ok) webhooks.removeTarget(m[1]);
      if (ok) broadcast({ kind: "workflows" });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such workflow" });
    }
    m = path.match(/^\/api\/workflows\/([\w-]+)\/run$/);
    if (m && method === "POST") {
      const workflow = workflows.get(m[1]);
      if (!workflow) return json(res, 404, { error: "no such workflow" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      // Running by hand works on a disabled workflow on purpose: turning
      // one off should stop it firing at you, not stop you testing it.
      const run = fireWorkflow(workflow.id, {
        text: clamp(body.text, MAX_MESSAGE_CHARS) ?? "",
        from: "you",
      });
      if (!run) return json(res, 500, { error: "that would not start" });
      return json(res, 202, { run });
    }
    // Answering the card a run is parked on. Its own route rather than
    // the chat, because the answer resumes a run rather than saying
    // anything to an agent.
    m = path.match(/^\/api\/workflows\/runs\/([\w-]+)\/answer$/);
    if (m && method === "POST") {
      const found = workflows.run(m[1]);
      if (!found) return json(res, 404, { error: "no such run" });
      if (found.run.state !== "waiting") {
        return json(res, 409, { error: "that question has already closed" });
      }
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const answer = clamp(body.answer, 300) ?? "";
      // Anything that is not an approval is a decline. A gate exists to
      // stop what comes after it, so an answer nobody can read should
      // stop rather than continue.
      const approved = /^(approve|approved|yes|allow|ok)$/i.test(answer.trim());
      const waiting = found.run.waiting!;
      const existing = store.messagesFor(waiting.threadId).find((msg) => msg.id === waiting.messageId);
      if (existing?.card) {
        const patched = store.patchMessage(waiting.threadId, waiting.messageId, {
          card: { ...existing.card, answered: answer || "Decline" },
        });
        if (patched) broadcast({ kind: "message.patch", threadId: waiting.threadId, message: patched });
      }
      const took = answerGate(m[1], approved, answer || "Decline");
      return json(res, took ? 200 : 409, took ? { ok: true, approved } : { error: "that question has already closed" });
    }

    // ── what is running, and what it costs ──
    // One place that answers the two questions a workspace with ten agents
    // in it cannot otherwise answer: what is happening, and what wants me.
    // Everything here is tracked elsewhere already; see server/activity.ts
    // for why joining it up is worth a surface of its own.
    if (method === "GET" && path === "/api/activity") {
      const live = liveCards();
      const lanes: Parameters<typeof assembleActivity>[0]["lanes"] = [];

      // A retired agent is not doing anything and nothing is waiting on
      // it, so it does not belong in a list of what is happening now.
      // The search route and the job board already draw the same line.
      for (const bot of store.bots.filter((b) => !b.archivedAt)) {
        for (const task of bot.tasks) {
          const limit = contextLimitFor(bot.modelSelection?.model);
          const fill = pressure(task.lastInput ?? 0, limit);
          lanes.push({
            threadId: task.id,
            botId: bot.id,
            botName: bot.name,
            laneTitle: task.title,
            busy: Boolean(task.busy),
            since: turnStarted.get(task.id),
            context: { used: fill.used, limit: fill.limit, fraction: fill.fraction },
            blocked: blockedOn(store.messagesFor(task.id), live, { includingPutAside: true }),
          });
        }
      }
      // A gate can park on a room's card, and somebody still has to answer
      // it. A room is never busy in its own right: its members are.
      for (const blok of bloks.bloks) {
        const blocked = blockedOn(store.messagesFor(blok.id), live, { includingPutAside: true });
        if (!blocked) continue;
        lanes.push({
          threadId: blok.id,
          botId: blok.id,
          botName: blok.name,
          laneTitle: "Room",
          busy: false,
          room: true,
          blocked,
        });
      }

      const routineNames = new Map<string, string>();
      for (const [threadId, open] of openRuns) {
        routineNames.set(threadId, routines.get(open.routineId)?.name || "a routine");
      }
      const jobTitles = new Map<string, string>();
      for (const [threadId, jobId] of openJobs) {
        jobTitles.set(threadId, jobs.get(jobId)?.title || "a job");
      }
      const workflowSteps = new Map<string, { name: string; step: string }>();
      for (const [threadId, held] of workflowTurns) {
        const found = workflows.run(held.runId);
        if (found) workflowSteps.set(threadId, { name: found.workflow.name, step: held.stepId });
      }

      usage.flush();
      const today = usage.since(1);
      const spend = new Map<string, { botId: string; turns: number; input: number; output: number; cost: number }>();
      let costKnown = false;
      for (const bucket of today) {
        const row = spend.get(bucket.botId) ?? {
          botId: bucket.botId,
          turns: 0,
          input: 0,
          output: 0,
          cost: 0,
        };
        row.turns += bucket.turns;
        row.input += bucket.input;
        row.output += bucket.output;
        row.cost += bucket.cost;
        spend.set(bucket.botId, row);
        if (bucket.costKnown) costKnown = true;
      }

      return json(
        res,
        200,
        assembleActivity({
          paused: wheel.all().map((hold) => ({
            botId: hold.botId,
            botName: store.bot(hold.botId)?.name ?? "an agent",
            since: hold.since,
            why: hold.why,
            turnedAway: hold.turnedAway,
          })),
          lanes,
          routines: routineNames,
          jobs: jobTitles,
          workflows: workflowSteps,
          spend: [...spend.values()],
          costKnown,
          at: Date.now(),
        }),
      );
    }

    // ── answering with something other than a paragraph ──
    // An agent renders one of the gallery instead of describing it. What
    // arrives is JSON an agent wrote, so nothing reaches a screen without
    // going through server/components.ts first.
    m = path.match(/^\/api\/bots\/([\w-]+)\/show$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const kind = String(body.kind ?? "");
      if (!mayRender(kind as ComponentKind, bot.withoutComponents)) {
        return json(res, 403, { error: `this agent cannot use ${kind}. Answer in prose instead` });
      }
      const parsed = parseComponent(kind, body.data);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });

      // The lane it is answering in, which for a background turn is not
      // the one on screen.
      const laneId =
        typeof body.taskId === "string" && bot.tasks.some((t) => t.id === body.taskId)
          ? body.taskId
          : (asAgent?.taskId && bot.tasks.some((t) => t.id === asAgent.taskId)
              ? asAgent.taskId
              : bot.activeTaskId);
      const destination = activeRoom.get(laneId) ?? laneId;
      const message = store.appendMessage(destination, {
        role: "bot",
        from: bot.id,
        kind: "component",
        component: parsed.component as unknown as Record<string, unknown>,
      });
      broadcast({ kind: "message", threadId: destination, message });
      return json(res, 201, { ok: true });
    }

    // ── reaching agents from a phone ──
    if (method === "GET" && path === "/api/telegram") {
      const state = cfg.telegram ?? {};
      // The token is a credential and never comes back out; what the
      // screen needs is whether one is set and who is paired.
      return json(res, 200, {
        configured: Boolean(state.token),
        enabled: state.enabled === true,
        paired: (state.chatIds ?? []).length,
        pairing: state.pairing ?? null,
        botId: state.botId ?? null,
      });
    }
    if (method === "POST" && path === "/api/telegram") {
      if (asAgent) return json(res, 403, { error: "an agent cannot change this" });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const next = { ...(cfg.telegram ?? {}) };
      if (body.token !== undefined) {
        const token = telegram.cleanToken(body.token);
        if (!token) return json(res, 400, { error: "a bot token is required" });
        try {
          await telegram.whoAmI(token);
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        next.token = token;
        // A new token is a new bot: whoever was paired with the old one
        // has no business talking to this one.
        next.chatIds = [];
        next.offset = 0;
      }
      if (typeof body.botId === "string") next.botId = body.botId;
      if (body.enabled !== undefined) next.enabled = body.enabled === true;
      if (body.pair === true) next.pairing = telegram.pairingWord();
      if (body.unpair === true) {
        next.chatIds = [];
        next.pairing = null;
      }
      cfg.telegram = next;
      saveConfig({ telegram: next } as Partial<AppConfig>);
      if (next.enabled && next.token) void telegramLoop();
      return json(res, 200, {
        configured: Boolean(next.token),
        enabled: next.enabled === true,
        paired: (next.chatIds ?? []).length,
        pairing: next.pairing ?? null,
        botId: next.botId ?? null,
      });
    }

    // ── borrowing a sign-in for the agent's browser ──
    // Per site, never the whole jar: an agent that checks a delivery
    // should not also be handed the bank. The keychain prompt this
    // raises is the consent gate, and it is the operating system's own.
    if (method === "GET" && path === "/api/browser/cookie-sources") {
      return json(res, 200, { sources: cookieStores().map((store) => store.browser) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/browser\/cookies$/);
    if (m && method === "POST") {
      if (asAgent) return json(res, 403, { error: "an agent cannot import your sign-ins" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      if (bot.browser !== true) {
        return json(res, 400, { error: "give this agent a browser first" });
      }
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const sites = Array.isArray(body.sites)
        ? (body.sites as unknown[])
            .filter((site): site is string => typeof site === "string" && site.trim().length > 0)
            .map((site) => site.trim())
            .slice(0, 12)
        : [];
      if (!sites.length) return json(res, 400, { error: "name at least one site" });
      const source = cookieStores().find(
        (candidate) => candidate.browser === String(body.browser ?? ""),
      );
      if (!source) return json(res, 400, { error: "no such browser on this machine" });
      try {
        const cookies = await readCookies(source.path, source.browser, sites);
        if (!cookies.length) {
          return json(res, 200, { imported: 0, note: `no cookies for those sites in ${source.browser}` });
        }
        await launch(join(DATA_DIR, "browser", bot.id), BROWSER_PORT);
        const targets = await listTargets(BROWSER_PORT);
        if (!targets.length) return json(res, 503, { error: "the agent's browser is not open" });
        const page = new CdpSession(targets[targets.length - 1].webSocketDebuggerUrl);
        await page.open();
        try {
          await page.send("Network.setCookies", {
            cookies: cookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              ...(cookie.expires ? { expires: cookie.expires } : {}),
            })),
          });
        } finally {
          page.close();
        }
        // The values themselves never touch the response or the log.
        return json(res, 200, { imported: cookies.length, sites });
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }

    // ── taking the wheel ──
    // While a person is driving, the agent's actions are refused rather
    // than queued: a queue would replay a plan made before they changed
    // things. See server/policy.ts.
    m = path.match(/^\/api\/bots\/([\w-]+)\/wheel$/);
    if (m && method === "GET") {
      return json(res, 200, { hold: wheel.heldBy(m[1]) });
    }
    if (m && (method === "POST" || method === "DELETE")) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such agent" });
      if (method === "POST") {
        const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
        // Pressing it again is not a new period. Taking a wheel already
        // held would reset the clock and the count, so the record would
        // say the hold cost nothing and lasted a moment.
        const already = wheel.heldBy(bot.id);
        if (already) return json(res, 200, { hold: already });
        const hold = wheel.take(bot.id, String(body.why ?? ""), Date.now());

        // Stop what it is already doing, rather than leaving it to trip
        // on a checkpoint it may never reach. An engine that does not ask
        // permission would otherwise run its turn to the end on a
        // computer somebody has just taken over, which is the exact case
        // this exists for. Nothing is remembered to be resumed: the
        // transcript keeps what it did, and asking again after the hand
        // back is the person's decision.
        for (const lane of bot.tasks.filter((t) => t.busy)) {
          await registry
            .get(bot.modelSelection.instanceId)
            ?.adapter.interruptTurn(lane.id)
            .catch(() => {});
        }
        stopScreenPoller(bot.id);
        // An interrupted job turn would otherwise finish the job with the
        // interrupt as its result, which reads as the agent failing at
        // it. The work was not refused, the person took the computer, so
        // it goes back on the board for somebody else.
        jobs.releaseAgent(bot.id, Date.now(), "Put back: somebody took this agent's computer.");
        broadcast({ kind: "jobs" });

        // A period, not a log of what somebody typed. The useful fact is
        // that a person was driving between two times; what they pressed
        // is both a privacy problem and less readable.
        record({
          at: hold.since,
          kind: "control.taken",
          actor: "you",
          summary: `Took over ${bot.name}'s computer`,
          detail: { agent: bot.name, why: hold.why },
        });
        broadcast({ kind: "wheel", botId: bot.id });
        broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
        return json(res, 200, { hold });
      }
      const was = wheel.release(bot.id);
      if (was) {
        record({
          at: Date.now(),
          kind: "control.released",
          actor: "you",
          summary: `Handed ${bot.name}'s computer back`,
          detail: {
            agent: bot.name,
            heldFor: Math.round((Date.now() - was.since) / 1000),
            // What the hold cost, as a number rather than a log. None of
            // it runs now: it was refused, not queued.
            turnedAway: was.turnedAway,
          },
        });
        broadcast({ kind: "wheel", botId: bot.id });
        broadcast({ kind: "bot", bot: clientBot(store.bot(bot.id)) });
      }
      return json(res, 200, { ok: true });
    }

    // ── rules ──
    // What agents may do, decided before a person is asked. An empty
    // policy means every question still reaches you, which is the whole
    // difference between this and a gateway. See server/policy.ts.
    if (method === "GET" && path === "/api/rules") {
      return json(res, 200, {
        rules: policy.list().map((rule) => ({ ...rule, summary: describeRule(rule) })),
        fields: POLICY_FIELDS,
        ops: POLICY_OPS,
      });
    }
    if (method === "POST" && path === "/api/rules") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const cleaned = cleanRule(body);
      if ("error" in cleaned) return json(res, 400, { error: cleaned.error });
      if (cleaned.rule.botId && !store.bot(cleaned.rule.botId)) {
        return json(res, 400, { error: "no such agent" });
      }
      const rule = policy.add(cleaned.rule, Date.now());
      if (!rule) return json(res, 409, { error: "that is as many rules as one workspace holds" });
      record({
        at: Date.now(),
        kind: "policy.changed",
        actor: "you",
        summary: `Added a rule: ${describeRule(rule)}`,
        detail: { rule: rule.id, effect: rule.effect },
      });
      broadcast({ kind: "rules" });
      return json(res, 201, { rule: { ...rule, summary: describeRule(rule) } });
    }
    m = path.match(/^\/api\/rules\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (typeof body.enabled !== "boolean") return json(res, 400, { error: "on or off" });
      const rule = policy.setEnabled(m[1], body.enabled);
      if (!rule) return json(res, 404, { error: "no such rule" });
      record({
        at: Date.now(),
        kind: "policy.changed",
        actor: "you",
        summary: `${body.enabled ? "Switched on" : "Switched off"} a rule: ${describeRule(rule)}`,
        detail: { rule: rule.id, enabled: body.enabled },
      });
      broadcast({ kind: "rules" });
      return json(res, 200, { rule: { ...rule, summary: describeRule(rule) } });
    }
    if (m && method === "DELETE") {
      const going = policy.list().find((r) => r.id === m![1]);
      const ok = policy.remove(m[1]);
      if (ok && going) {
        record({
          at: Date.now(),
          kind: "policy.changed",
          actor: "you",
          summary: `Removed a rule: ${describeRule(going)}`,
          detail: { rule: going.id },
        });
        broadcast({ kind: "rules" });
      }
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such rule" });
    }

    // ── usage (see server/usage.ts) ──
    // What has been spent, never what is left: Bloks does not own the
    // quota and will not invent a denominator.
    if (method === "GET" && path === "/api/usage") {
      const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 365);
      usage.flush();
      return json(res, 200, summarize(usage.since(days), days));
    }

    // ── routines (see server/routines.ts) ──
    // Scheduled work an agent does without being asked. The schedule is a
    // time of day plus days of the week, not cron: it has to be readable
    // at arm's length on a phone.
    if (method === "GET" && path === "/api/routines") {
      const now = new Date();
      return json(res, 200, {
        routines: routines.routines.map((r) => ({
          ...r,
          summary: describeRoutine(r),
          nextRunAt: r.enabled ? (nextScheduledAfter(r, now)?.getTime() ?? null) : null,
        })),
      });
    }
    if (method === "POST" && path === "/api/routines") {
      const body = await readBody(req);
      const clean = normalizeRoutine(body);
      if (!clean) return json(res, 400, { error: "a routine needs a target, something to say, and a time" });
      // A routine aimed at nothing would fire forever into the void.
      const exists =
        clean.targetKind === "room" ? Boolean(bloks.get(clean.targetId)) : Boolean(store.bot(clean.targetId));
      if (!exists) return json(res, 404, { error: "no such agent or room" });
      const routine = routines.create(clean);
      if (!routine) return json(res, 507, { error: `you can have at most ${MAX_ROUTINES} routines` });
      broadcast({ kind: "routines" });
      return json(res, 201, { routine: { ...routine, summary: describeRoutine(routine) } });
    }
    m = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const existing = routines.get(m[1]);
      if (!existing) return json(res, 404, { error: "no such routine" });
      const body = await readBody(req);
      // Only the fields a person edits. Never lastRunAt: rewriting when it
      // last ran is how you make a routine fire twice.
      const merged = normalizeRoutine({
        targetId: existing.targetId,
        targetKind: existing.targetKind,
        prompt: body.prompt ?? existing.prompt,
        time: body.time ?? existing.time,
        days: body.days ?? existing.days,
        enabled: body.enabled ?? existing.enabled,
        name: body.name ?? existing.name,
        repeat: body.repeat ?? existing.repeat,
        date: body.date ?? existing.date,
        durationMin: body.durationMin ?? existing.durationMin,
        runsOn: body.runsOn === null ? undefined : (body.runsOn ?? existing.runsOn),
      });
      if (!merged) return json(res, 400, { error: "that is not a valid routine" });
      const routine = routines.patch(m[1], merged);
      broadcast({ kind: "routines" });
      return json(res, 200, { routine: { ...routine!, summary: describeRoutine(routine!) } });
    }
    if (m && method === "DELETE") {
      const ok = routines.remove(m[1]);
      if (ok) broadcast({ kind: "routines" });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such routine" });
    }
    // Run one now, for "does this actually do what I meant" without
    // waiting until tomorrow morning.
    m = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (m && method === "POST") {
      const routine = routines.get(m[1]);
      if (!routine) return json(res, 404, { error: "no such routine" });
      // A hand-run is still a run. It is how anybody checks that a
      // routine does what they meant, so it belongs in the history at
      // least as much as the scheduled ones do.
      if (routine.targetKind === "room") {
        const blok = bloks.get(routine.targetId);
        if (!blok) return json(res, 404, { error: "that room is gone" });
        const run = routines.beginRun(routine.id, blok.id);
        if (run) openRuns.set(blok.id, { routineId: routine.id, runId: run.id });
        broadcast({ kind: "routines" });
        void postToRoom(blok, routine.prompt, { hops: 0 })
          .then(() => closeRun(blok.id, { ok: true, summary: "Posted to the room." }))
          .catch((e) =>
            closeRun(blok.id, {
              ok: false,
              error: redactSecrets(e instanceof Error ? e.message : String(e)),
            }),
          );
      } else {
        const laneId = backgroundTaskId(routine.targetId, "Routines");
        if (!laneId) return json(res, 409, { error: "that agent's Routines lane is busy. Try again when it settles" });
        const run = routines.beginRun(routine.id, laneId);
        if (run) openRuns.set(laneId, { routineId: routine.id, runId: run.id });
        broadcast({ kind: "routines" });
        try {
          await startTurn(routine.targetId, routine.prompt, {
            taskId: laneId,
            computerOverride: routine.runsOn,
          });
        } catch (e) {
          closeRun(laneId, {
            ok: false,
            error: redactSecrets(e instanceof Error ? e.message : String(e)),
          });
          throw e;
        }
      }
      return json(res, 202, { ok: true });
    }

    // ── pairing (see server/pairing.ts) ──
    // Everything that changes the boundary is loopback only: you have to
    // be at the Mac to let a device in, or to throw one out.
    if (method === "GET" && path === "/api/pair") {
      if (!local) return json(res, 403, { error: "not from here" });
      return json(res, 200, pairingStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/pair") {
      if (!local) return json(res, 403, { error: "not from here" });
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "enabled must be true or false" });
      }
      setRemoteEnabled(body.enabled);
      // pairing is the master switch for all remote access, the relay
      // included: turning it off drops the outbound line immediately
      syncRelay();
      const status = pairingStatus();
      broadcast({ kind: "pairing", ...status });
      return json(res, 200, status);
    }
    if (method === "POST" && path === "/api/pair/start") {
      if (!local) return json(res, 403, { error: "not from here" });
      if (!remoteEnabled()) return json(res, 409, { error: "turn on pairing first" });
      const started = startPairing();
      broadcast({ kind: "pairing", ...pairingStatus() });
      return json(res, 200, { ...started, addresses: pairingStatus().addresses, port: PORT });
    }
    if (method === "POST" && path === "/api/pair/cancel") {
      if (!local) return json(res, 403, { error: "not from here" });
      cancelPairing();
      broadcast({ kind: "pairing", ...pairingStatus() });
      return json(res, 200, { ok: true });
    }
    // The one route a device may call before it is anybody. A wrong code
    // burns one of five tries and the fifth closes the window, so this
    // cannot be ground down.
    if (method === "POST" && path === "/api/pair/claim") {
      const body = await readBody(req);
      // `credential` is the QR token or the code; `code` is the old name
      const claimed = claimPairing(body.credential ?? body.code, body.device);
      if (!claimed) return json(res, 401, { error: "that code is not valid" });
      broadcast({ kind: "pairing", ...pairingStatus() });
      return json(res, 200, claimed);
    }
    if (method === "DELETE" && path === "/api/pair/devices") {
      if (!local) return json(res, 403, { error: "not from here" });
      revokeAll();
      broadcast({ kind: "pairing", ...pairingStatus() });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/pair\/devices\/([\w-]+)$/);
    if (m && method === "DELETE") {
      if (!local) return json(res, 403, { error: "not from here" });
      const ok = revokeDevice(m[1]);
      if (ok) broadcast({ kind: "pairing", ...pairingStatus() });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such device" });
    }

    // ── stored settings: written here, never read back out ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      // Only known string fields, each length-capped. Without this the
      // whole config file is an arbitrary write target.
      const FIELDS: Record<string, { keys: string[]; max: number }> = {
        xai: { keys: ["key", "url"], max: 400 },
        composio: { keys: ["key", "apiKey", "url"], max: 400 },
        speech: { keys: ["elevenlabsKey", "openaiKey"], max: 400 },
        box: { keys: ["token"], max: 400 },
        profile: { keys: ["about"], max: 4_000 },
      };
      const patch: Record<string, object> = {};
      // consent flags are booleans and ride outside the string loop
      let consentPatch: { useDiscoveredOpenAI: boolean } | null = null;
      /** Sections that save themselves, so the empty-patch guard below
       * does not mistake a real write for an empty request. */
      let wroteSomething = false;
      if (body.speech && typeof body.speech === "object" && !Array.isArray(body.speech)) {
        const consent = (body.speech as Record<string, unknown>).useDiscoveredOpenAI;
        if (typeof consent === "boolean") consentPatch = { useDiscoveredOpenAI: consent };
      }
      // A boolean, not a credential, so it rides outside the string table
      // like the consent flags do.
      if (body.compaction && typeof body.compaction === "object" && !Array.isArray(body.compaction)) {
        const micro = (body.compaction as Record<string, unknown>).micro;
        if (typeof micro === "boolean") {
          saveConfig({ compaction: { micro } });
          Object.assign(cfg, loadConfig());
          wroteSomething = true;
        }
      }
      if (body.skills && typeof body.skills === "object" && !Array.isArray(body.skills)) {
        const propose = (body.skills as Record<string, unknown>).propose;
        if (typeof propose === "boolean") {
          saveConfig({ skills: { propose } });
          Object.assign(cfg, loadConfig());
          wroteSomething = true;
        }
      }
      // A hotkey is not a credential, so it gets its own shape check
      // rather than a slot in the string table: it must look like an
      // accelerator, and null is how it is cleared.
      if (body.shortcuts && typeof body.shortcuts === "object" && !Array.isArray(body.shortcuts)) {
        const asked = (body.shortcuts as Record<string, unknown>).quickAsk;
        if (asked === null) {
          saveConfig({ shortcuts: { quickAsk: null } });
          Object.assign(cfg, loadConfig());
          wroteSomething = true;
        } else if (typeof asked === "string") {
          const accelerator = asked.trim();
          const valid =
            accelerator.length <= 60 &&
            /^([A-Za-z]+\+)+[A-Za-z0-9]+$/.test(accelerator) &&
            /(Command|Control|Alt|Shift|Super|CommandOrControl)\+/.test(accelerator);
          if (!valid) return json(res, 400, { error: "that is not a keyboard shortcut" });
          saveConfig({ shortcuts: { quickAsk: accelerator } });
          Object.assign(cfg, loadConfig());
          wroteSomething = true;
        }
      }
      if (body.setupDone === true && !cfg.setupDoneAt) {
        saveConfig({ setupDoneAt: Date.now() });
        Object.assign(cfg, loadConfig());
      }
      for (const [section, spec] of Object.entries(FIELDS)) {
        const value = body[section];
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const clean: Record<string, string> = {};
        for (const key of spec.keys) {
          const field = (value as Record<string, unknown>)[key];
          if (typeof field !== "string") continue;
          if (field.length > spec.max) {
            return json(res, 413, { error: `${section}.${key} is too long` });
          }
          clean[key] = field;
        }
        if (Object.keys(clean).length) patch[section] = clean;
      }
      if (consentPatch) {
        patch.speech = { ...(patch.speech as object | undefined), ...consentPatch };
      }
      if (!Object.keys(patch).length && !wroteSomething) {
        return json(res, 400, { error: "nothing to save" });
      }
      // A Composio key is probed before it is believed. Saving a bad key
      // used to light the row green anyway, and "Connected" must mean
      // Composio said yes, not "a string was stored". A definite refusal
      // blocks the save; an unreachable service does not, because
      // offline is not the user's fault.
      const composioPatch = patch.composio as { key?: string; apiKey?: string } | undefined;
      if (composioPatch?.key) {
        const verdict = await composio.validateConnectKey(cfg, composioPatch.key);
        if (verdict === false) {
          return json(res, 400, { error: "Composio didn't accept that Connect key" });
        }
      }
      if (composioPatch?.apiKey) {
        const verdict = await composio.validateApiKey(composioPatch.apiKey);
        if (verdict === false) {
          return json(res, 400, { error: "Composio didn't accept that API key" });
        }
      }
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── attachments (pasted images, saved once, referenced by path) ──
    if (method === "POST" && path === "/api/attachments") {
      attachments.saveAttachment(req, res);
      return;
    }
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      attachments.serveAttachment(m[1], res);
      return;
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.connectorCatalog(cfg);
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectorStates(
        cfg,
        services.length ? services : composio.SHIPPED_CONNECTOR_SLUGS,
      );
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.beginConnectorAuth(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.disconnectConnector(cfg, m[1]));

    // ── the bot's local sandbox (a container on this machine) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/sandbox$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such agent" });
      return json(res, 200, await sandboxStatus(m[1]));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/sandbox\/(provision|exec|stop|destroy)$/);
    if (m && method === "POST") {
      const botId = m[1];
      if (!store.bot(botId)) return json(res, 404, { error: "no such agent" });
      switch (m[2]) {
        case "provision":
          return json(res, 200, await provisionSandbox(botId));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await execInSandbox(botId, String(body.command ?? "")));
        }
        case "stop":
          return json(res, 200, await stopSandbox(botId));
        case "destroy":
          // files go with it; the client is expected to have warned
          await destroySandbox(botId);
          return json(res, 200, { ok: true });
      }
    }

    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") return json(res, 200, await box.boxStatus(cfg, m[1]));
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such agent" });
      switch (m[2]) {
        case "provision":
          return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
        case "join":
          return json(res, 200, await box.joinBox(cfg, botId));
        case "sleep":
          return json(res, 200, await box.sleepBox(cfg, botId));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
        }
        case "screenshot":
          return json(res, 200, await box.screenshotBox(cfg, botId));
      }
    }

    // In the packaged app this process also serves the built interface,
    // so the window has exactly one origin to talk to and there is no
    // development proxy in the path to fall over.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      // resolve, then require the result to stay inside STATIC_DIR, 
      // string-stripping ".." is not a containment check
      const requested = path === "/" ? "/index.html" : decodeURIComponent(path);
      const root = resolve(STATIC_DIR);
      const file = resolve(root, `.${requested}`);
      if (file !== root && !file.startsWith(root + sep)) {
        return json(res, 403, { error: "forbidden" });
      }
      try {
        const data = readFileSync(file);
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          ...SECURITY_HEADERS,
        });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html", ...SECURITY_HEADERS });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: redactSecrets(e instanceof Error ? e.message : String(e)) });
  }
});

/** Provider and connector errors sometimes quote the credential that
 * failed. Never hand one back to the UI (or into a log) verbatim. */
function redactSecrets(message: string): string {
  let out = message;
  const stored = [
    cfg.xai?.key,
    cfg.composio?.key,
    cfg.composio?.apiKey,
    cfg.box?.token,
    ...Object.values(cfg.providers ?? {}).map((p) => p?.key),
    ...(cfg.custom ?? []).flatMap((endpoint) => endpoint.keys.map((cred) => cred.key)),
    ...Object.values(cfg.secrets ?? {}),
  ];
  for (const secret of stored) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  // and anything that merely looks like a key we haven't stored. A Cloud
  // licence is the sharp case: it is spent at activation and never
  // written to the config, so the list above can never cover it.
  return out
    .replace(/\b(sk|ck|ak|gsk|xai)[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\bblok_live_[0-9a-f]{32}\b/g, "[redacted]");
}

// Read once, here, and never again while the process lives: see the
// header of server/pairing.ts for why this is not a live toggle.
const BIND = bindHost();
noteBound(BIND);
server.listen(PORT, BIND, () => {
  console.log(`bloks server on http://127.0.0.1:${PORT}`);
  if (BIND !== "127.0.0.1") {
    console.log(`[bloks] paired devices may reach this machine on port ${PORT}`);
  }
});

// A provider process can die in ways that surface as an unhandled
// rejection here. Losing one turn is bad; losing the whole workspace and
// every other agent with it is worse, so log and stay up.
process.on("unhandledRejection", (reason) => {
  console.error("[bloks] unhandled rejection:", redactSecrets(String(reason)));
});
process.on("uncaughtException", (error) => {
  console.error("[bloks] uncaught exception:", redactSecrets(error?.stack ?? String(error)));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // shells first: they are children of this process and would otherwise
    // outlive it, still holding the folder open
    terminals.closeAll();
    mcp.closeAll();
    void registry.disposeAll().finally(() => process.exit(0));
  });
}
