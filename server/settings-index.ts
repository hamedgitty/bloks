// Where things are in the app, as data both sides read.
//
// The Settings index (every page, the group it sits in, the words people
// search for and the rows each page draws) and the app's main places
// (Overview, Automations and its tabs, Memory, Plugins, Usage, an agent's
// own settings). The app draws its Settings list and runs its settings
// search from this (src/lib/settingsPages.ts), and the server reads the
// same list when an agent asks where something lives (`bloks where`) or
// puts a button in the chat that opens it (`bloks open`), so the answer an
// agent gives and the page the person lands on can never drift apart.
//
// Words are catalogue keys, read in the reader's language by the app and
// in English by the server (server/where.ts). Nothing here imports
// anything: the app bundles this file, and the server build compiles it.

export type SettingsGroupId = "account" | "workspace" | "agents" | "integrations" | "connections" | "data" | "help";

/** A page as it is written down. Keys are plain strings here; the app
 * holds every one of them to its catalogue's keys when it reads the list,
 * so a misspelt key still fails the typecheck. */
export interface SettingsPageEntry {
  id: string;
  label: string;
  group: SettingsGroupId;
  /** One line under the page's title. */
  description: string;
  /** Words people search for that the label does not say, in English.
   * They stay here as they are, so an English word finds its page in
   * every language. */
  keywords: string;
  /** The same words for a translator to give in their own language,
   * whose English is `keywords`. */
  keywordsKey: string;
  /** The rows the page draws, so a search can name the row it found and
   * take you to it. */
  rows?: readonly string[];
  /** Only drawn where the desktop app has workspaces. */
  workspace?: boolean;
}

/** The groups, in the order the list shows them. The workspace's group is
 * titled with the workspace's own name where it is drawn. */
export const SETTINGS_GROUP_INDEX = [
  { id: "account", label: "settingsPages.group.account" },
  { id: "workspace", label: "settingsPages.group.workspace" },
  { id: "agents", label: "settingsPages.group.agents" },
  { id: "integrations", label: "settingsPages.group.integrations" },
  { id: "connections", label: "settingsPages.group.connections" },
  { id: "data", label: "settingsPages.group.data" },
  { id: "help", label: "settingsPages.group.help" },
] as const satisfies ReadonlyArray<{ id: SettingsGroupId; label: string }>;

export const SETTINGS_PAGE_INDEX = [] = [
  {
    id: "plan",
    group: "account",
    label: "settingsPages.plan.label",
    description: "settingsPages.plan.description",
    keywords:
      "plan billing subscription licence license key copy replace remove cloud team hosting bloks ai allowance upgrade renew renewal cancel invoice card payment membership manage",
    keywordsKey: "settingsPages.plan.keywords",
    rows: [
      "settingsPages.plan.row.manageBilling",
      "settingsPages.plan.row.bloksKey",
      "settingsPages.plan.row.workspacesOnline",
      "settingsPages.plan.row.members",
      "settingsPages.plan.row.bloksAi",
      "settingsPages.plan.row.moveToManagedHosting",
      "settingsPages.plan.row.letBackgroundWorkUseBloksAi",
    ],
  },
  {
    id: "general",
    group: "account",
    label: "settingsPages.general.label",
    description: "settingsPages.general.description",
    keywords:
      "appearance theme dark light system accent colour color width transcript narrow medium wide sidebar conversations threads shortcut hotkey quick ask your name owner call me language translate translation locale",
    keywordsKey: "settingsPages.general.keywords",
    rows: [
      "settingsPages.general.row.yourName",
      "settingsPages.general.row.theme",
      "settingsPages.general.row.accent",
      "settingsPages.general.row.sameAccentInEveryWorkspace",
      "settingsPages.general.row.transcriptWidth",
      "settingsPages.general.row.showConversationsInTheSidebar",
      "settingsPages.general.row.quickAskShortcut",
      "settingsPages.general.row.language",
    ],
  },
  {
    id: "about-you",
    group: "account",
    label: "settingsPages.aboutYou.label",
    description: "settingsPages.aboutYou.description",
    keywords: "profile context personal instructions about me preferences",
    keywordsKey: "settingsPages.aboutYou.keywords",
    rows: ["settingsPages.aboutYou.row.whatEveryAgentKnowsAboutYou"],
  },
  {
    id: "workspace:general",
    group: "workspace",
    label: "settingsPages.workspaceGeneral.label",
    description: "settingsPages.workspaceGeneral.description",
    keywords: "workspace name mark logo kind business personal team solo delete",
    keywordsKey: "settingsPages.workspaceGeneral.keywords",
    rows: [
      "settingsPages.workspaceGeneral.row.name",
      "settingsPages.workspaceGeneral.row.kind",
      "settingsPages.workspaceGeneral.row.whoUsesIt",
      "settingsPages.workspaceGeneral.row.mark",
      "settingsPages.workspaceGeneral.row.deleteWorkspace",
    ],
    workspace: true,
  },
  {
    id: "workspace:members",
    group: "workspace",
    label: "settingsPages.workspaceMembers.label",
    description: "settingsPages.workspaceMembers.description",
    keywords: "members people invite join admin team password approve",
    keywordsKey: "settingsPages.workspaceMembers.keywords",
    rows: ["settingsPages.workspaceMembers.row.inviteSomeone"],
    workspace: true,
  },
  {
    id: "workspace:online",
    group: "workspace",
    label: "settingsPages.workspaceOnline.label",
    description: "settingsPages.workspaceOnline.description",
    keywords: "online offline relay cloud space remote anywhere address",
    keywordsKey: "settingsPages.workspaceOnline.keywords",
    rows: [
      "settingsPages.workspaceOnline.row.online",
      "settingsPages.workspaceOnline.row.status",
      "settingsPages.workspaceOnline.row.address",
      "settingsPages.workspaceOnline.row.workspacesOnline",
    ],
    workspace: true,
  },
  {
    id: "workspace:notifications",
    group: "workspace",
    label: "settingsPages.workspaceNotifications.label",
    description: "settingsPages.workspaceNotifications.description",
    keywords: "notifications banners mute quiet dock badge alerts",
    keywordsKey: "settingsPages.workspaceNotifications.keywords",
    rows: ["settingsPages.workspaceNotifications.row.tellMeAbout", "settingsPages.workspaceNotifications.row.mute"],
    workspace: true,
  },
  {
    id: "engines",
    group: "agents",
    label: "settingsPages.engines.label",
    description: "settingsPages.engines.description",
    keywords:
      "engines models providers claude codex gemini grok cursor cline devin openai api key cli sign in bloks ai endpoints pause speed path",
    keywordsKey: "settingsPages.engines.keywords",
    rows: [
      "settingsPages.engines.row.yourEngines",
      "settingsPages.engines.row.pauses",
      "settingsPages.engines.row.codexSpeed",
      "settingsPages.engines.row.howYourEnginesAreDoing",
      "settingsPages.engines.row.yourEndpoints",
    ],
  },
  {
    id: "new-agents",
    group: "agents",
    label: "settingsPages.newAgents.label",
    description: "settingsPages.newAgents.description",
    keywords: "defaults folder hire approvals model effort",
    keywordsKey: "settingsPages.newAgents.keywords",
    rows: [
      "settingsPages.newAgents.row.folder",
      "settingsPages.newAgents.row.approvals",
      "settingsPages.newAgents.row.model",
      "settingsPages.newAgents.row.effort",
    ],
  },
  {
    id: "behaviour",
    group: "agents",
    label: "settingsPages.behaviour.label",
    description: "settingsPages.behaviour.description",
    keywords:
      "behavior working with agents skills suggest suggestions learn learning improve revise recall remember memory other conversations tidy nightly archive turn limit consecutive chain replies stuck silent tool call background subagents tasks finish stop incident incidents desk failure lead retry interrupt queue messages while working steer correction files changes rooms room auto route router who answers pick small model compaction compact summarise summarize idle cache long tokens",
    keywordsKey: "settingsPages.behaviour.keywords",
    rows: [
      "settingsPages.behaviour.row.suggestSkills",
      "settingsPages.behaviour.row.bringUpOtherConversations",
      "settingsPages.behaviour.row.tidyMemoryEveryNight",
      "settingsPages.behaviour.row.messagesWhileAnAgentWorks",
      "settingsPages.behaviour.row.agentToAgentLimit",
      "settingsPages.behaviour.row.stopStuckToolCalls",
      "settingsPages.behaviour.row.showOtherChangedFiles",
      "settingsPages.behaviour.row.backgroundWorkAnAgentStarts",
      "settingsPages.behaviour.row.autoPicksWith",
      "settingsPages.behaviour.row.incidentDesk",
      "settingsPages.behaviour.row.whoLeadsIncidents",
      "settingsPages.behaviour.row.compactLongChats",
      "settingsPages.behaviour.row.summariseAsYouGo",
      "settingsPages.behaviour.row.compactWhileIdle",
    ],
  },
  {
    id: "rules",
    group: "agents",
    label: "settingsPages.rules.label",
    description: "settingsPages.rules.description",
    keywords:
      "deny allow permissions safety approval gate full access auto ask conservative suggestions always allow habit",
    keywordsKey: "settingsPages.rules.keywords",
    rows: ["settingsPages.rules.row.howMuchAgentsAsk", "settingsPages.rules.row.yourRules"],
  },
  {
    id: "security",
    group: "agents",
    label: "settingsPages.security.label",
    description: "settingsPages.security.description",
    keywords:
      "security safety checkup audit risk full access pairing devices email webhooks secrets browser computer file permissions signed out",
    keywordsKey: "settingsPages.security.keywords",
  },
  {
    id: "voices",
    group: "agents",
    label: "settingsPages.voices.label",
    description: "settingsPages.voices.description",
    keywords: "speech elevenlabs openai fish audio xai grok chatterbox local tts call audio",
    keywordsKey: "settingsPages.voices.keywords",
    rows: [
      "settingsPages.voices.row.elevenlabsApiKey",
      "settingsPages.voices.row.openaiApiKey",
      "settingsPages.voices.row.fishAudioApiKey",
      "settingsPages.voices.row.xaiApiKey",
      "settingsPages.voices.row.chatterboxServer",
    ],
  },
  {
    id: "plugins",
    group: "integrations",
    label: "settingsPages.plugins.label",
    description: "settingsPages.plugins.description",
    keywords: "apps connectors composio mcp servers skills agents tools integrations gmail slack github",
    keywordsKey: "settingsPages.plugins.keywords",
  },
  {
    id: "apps",
    group: "integrations",
    label: "settingsPages.apps.label",
    description: "settingsPages.apps.description",
    keywords:
      "composio connect key api key claude desktop cursor mcp other apps secrets secret saved token password forget environment variable",
    keywordsKey: "settingsPages.apps.keywords",
    rows: [
      "settingsPages.apps.row.composioConnectKey",
      "settingsPages.apps.row.composioApiKey",
      "settingsPages.apps.row.savedSecrets",
      "settingsPages.apps.row.useBloksFromOtherAiApps",
    ],
  },
  {
    id: "devices",
    group: "connections",
    label: "settingsPages.devices.label",
    description: "settingsPages.devices.description",
    keywords: "iphone pairing remote relay qr phone access location where gps city place",
    keywordsKey: "settingsPages.devices.keywords",
    rows: ["settingsPages.devices.row.phoneAccess", "settingsPages.devices.row.whereYourBloksRuns", "settingsPages.devices.row.location"],
  },
  {
    id: "chat",
    group: "connections",
    label: "settingsPages.chat.label",
    description: "settingsPages.chat.description",
    keywords: "telegram signal signal-cli slack discord whatsapp email mail groups",
    keywordsKey: "settingsPages.chat.keywords",
    rows: [
      "settingsPages.chat.row.telegram",
      "settingsPages.chat.row.signal",
      "settingsPages.chat.row.slack",
      "settingsPages.chat.row.discord",
      "settingsPages.chat.row.whatsapp",
      "settingsPages.chat.row.signalGroups",
      "settingsPages.chat.row.email",
    ],
  },
  {
    id: "home",
    group: "connections",
    label: "settingsPages.home.label",
    description: "settingsPages.home.description",
    keywords:
      "home assistant smart home lights locks climate thermostat covers garage alarm sensors entities automation webhook voice assist hass",
    keywordsKey: "settingsPages.home.keywords",
    rows: [
      "settingsPages.home.row.connection",
      "settingsPages.home.row.whatAgentsCanSee",
      "settingsPages.home.row.agentsThatCanUseIt",
      "settingsPages.home.row.startAnAgentFromHomeAssistant",
    ],
  },
  {
    id: "computers",
    group: "connections",
    label: "settingsPages.computers.label",
    description: "settingsPages.computers.description",
    keywords: "vm virtual machine local box boat sandbox desktop cloud computer sleep idle",
    keywordsKey: "settingsPages.computers.keywords",
    rows: [
      "settingsPages.computers.row.localVm",
      "settingsPages.computers.row.boatApiKey",
      "settingsPages.computers.row.sleepIdleCloudComputersAfter",
    ],
  },
  {
    id: "browser",
    group: "connections",
    label: "settingsPages.browser.label",
    description: "settingsPages.browser.description",
    keywords:
      "browser web sites allow deny block list ask first auto downloads sign out cookies password card upload take over",
    keywordsKey: "settingsPages.browser.keywords",
    rows: [
      "settingsPages.browser.row.asks",
      "settingsPages.browser.row.sitesAgentsMayUse",
      "settingsPages.browser.row.sitesAgentsNeverUse",
      "settingsPages.browser.row.downloads",
      "settingsPages.browser.row.signOutOfEverySite",
    ],
  },
  {
    id: "past-sessions",
    group: "data",
    label: "settingsPages.pastSessions.label",
    description: "settingsPages.pastSessions.description",
    keywords: "import sessions history transcripts claude code codex resume continue chats conversations projects",
    keywordsKey: "settingsPages.pastSessions.keywords",
  },
  {
    id: "bring-setup",
    group: "data",
    label: "settingsPages.bringSetup.label",
    description: "settingsPages.bringSetup.description",
    keywords:
      "import migrate claude code codex cursor openclaw hermes claude.md agents.md subagents commands prompts skills mcp memory rules telegram slack discord move switch undo",
    keywordsKey: "settingsPages.bringSetup.keywords",
  },
  {
    id: "record",
    group: "data",
    label: "settingsPages.record.label",
    description: "settingsPages.record.description",
    keywords: "ledger audit history log record signed",
    keywordsKey: "settingsPages.record.keywords",
  },
  {
    id: "backups",
    group: "data",
    label: "settingsPages.backups.label",
    description: "settingsPages.backups.description",
    keywords:
      "backup restore archive copy export move new computer undo history passphrase encrypt seal daily automatic hosted",
    keywordsKey: "settingsPages.backups.keywords",
    rows: [
      "settingsPages.backups.row.backUpEveryDay",
      "settingsPages.backups.row.includeUndoHistory",
      "settingsPages.backups.row.sealWithAPassphrase",
      "settingsPages.backups.row.backUpNow",
      "settingsPages.backups.row.writeOutThisWorkspace",
    ],
  },
  {
    id: "training",
    group: "data",
    label: "settingsPages.training.label",
    description: "settingsPages.training.description",
    keywords: "export training fine tune fine-tuning dataset jsonl openai sharegpt trajectory runs tool calls model data",
    keywordsKey: "settingsPages.training.keywords",
    rows: [
      "settingsPages.training.row.shape",
      "settingsPages.training.row.eachRecordIs",
      "settingsPages.training.row.metadata",
      "settingsPages.training.row.dates",
      "settingsPages.training.row.engines",
      "settingsPages.training.row.onlyFinishedWell",
      "settingsPages.training.row.onlyNotCorrected",
      "settingsPages.training.row.onlyThumbsUp",
      "settingsPages.training.row.takeOutNames",
      "settingsPages.training.row.shortenToolResults",
      "settingsPages.training.row.capEachRecord",
    ],
  },
  {
    id: "about",
    group: "help",
    label: "settingsPages.about.label",
    description: "settingsPages.about.description",
    keywords: "version update feedback diagnostics bug report server headless workspace server bloks-server",
    keywordsKey: "settingsPages.about.keywords",
    rows: [
      "settingsPages.about.row.checkForUpdates",
      "settingsPages.about.row.workspaceServer",
      "settingsPages.about.row.somethingBrokenOrMissing",
      "settingsPages.about.row.diagnostics",
    ],
  },
] as const satisfies readonly SettingsPageEntry[];

/**
 * Where an old address goes now. Bloks Cloud became Plan (the key, the
 * membership and Bloks AI in one place); the workspace's Engines and keys
 * and Usage were only ever links to pages Settings already has.
 */
export const SETTINGS_REDIRECTS: Readonly<Record<string, string>> = {
  cloud: "plan",
  "bloks-cloud": "plan",
  billing: "plan",
  "workspace:plan": "plan",
  "workspace:engines": "engines",
  "workspace:usage": "plan",
  "workspace:settings": "workspace:general",
  workspace: "workspace:general",
};

/** A place on the main rail, or a tab of one, that is not a Settings
 * page. `agent` is one agent's own settings: which agent is said where it
 * is opened, never here. An id is never a Settings page's id too, since
 * one id opens one place. */
export interface PlaceEntry {
  id: string;
  label: string;
  /** The place it is a tab of. */
  parent?: string;
  description: string;
  /** Words people search for that the label does not say, in English. */
  keywords: string;
}

export const PLACE_INDEX = [
  {
    id: "overview",
    label: "appRail.overview",
    description: "places.overview.about",
    keywords: "overview home today brief morning brief activity waiting on you failed running rehearsals attempts projects",
  },
  {
    id: "automations",
    label: "appRail.automations",
    description: "places.automations.about",
    keywords: "automations automation",
  },
  {
    id: "automations:schedules",
    parent: "automations",
    label: "automationsPanel.tab.schedules",
    description: "places.schedules.about",
    keywords: "routine routines schedule schedules check-in check-ins calendar recurring every day morning time quiet",
  },
  {
    id: "automations:watchers",
    parent: "automations",
    label: "automationsPanel.tab.watchers",
    description: "places.watchers.about",
    keywords: "watcher watchers watch folder page web feed rss command place arrive leave app watcher composio event",
  },
  {
    id: "automations:intents",
    parent: "automations",
    label: "automationsPanel.tab.intents",
    description: "places.intents.about",
    keywords: "intent intents standing words phrases mention trigger",
  },
  {
    id: "automations:workflows",
    parent: "automations",
    label: "automationsPanel.tab.workflows",
    description: "places.workflows.about",
    keywords: "workflow workflows steps trigger runs gate",
  },
  {
    id: "automations:webhooks",
    parent: "automations",
    label: "automationsPanel.webhooks",
    description: "places.webhooks.about",
    keywords: "webhook webhooks url outside event post",
  },
  {
    id: "automations:jobs",
    parent: "automations",
    label: "automationsPanel.tab.jobs",
    description: "places.jobs.about",
    keywords: "job jobs job board post work queue",
  },
  {
    id: "memory",
    label: "common.memory",
    description: "places.memory.about",
    keywords: "memory memories remember forget notes journal undo shared memory topic files",
  },
  {
    // not "plugins", which is Settings' own page of that name
    id: "plugins:apps",
    label: "common.plugins",
    description: "places.plugins.about",
    keywords: "plugins apps connectors mcp servers tools integrations customize",
  },
  {
    id: "plugins:skills",
    parent: "plugins:apps",
    label: "common.skills",
    description: "places.skills.about",
    keywords: "skill skills version versions history restore suggested suggestions instructions revise",
  },
  {
    id: "plugins:catalog",
    parent: "plugins:apps",
    label: "customize.catalogue",
    description: "places.catalog.about",
    keywords: "catalogue catalog teams team install gallery ready made",
  },
  {
    id: "usage",
    label: "appRail.usage",
    description: "places.usage.about",
    keywords: "usage cost costs spend spending spent tokens turns money monthly limit limits price",
  },
  {
    id: "agent",
    label: "places.agent.label",
    description: "places.agent.about",
    keywords:
      "agent profile edit profile name title engine backup engine model effort approvals voice notifications browser computer tools memory schedules container docker ssh where it works",
  },
] as const satisfies readonly PlaceEntry[];

export type PlaceId = (typeof PLACE_INDEX)[number]["id"];
