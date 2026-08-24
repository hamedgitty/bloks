export const BLOK_COLOR_NAMES = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const;

export type BlokColor = (typeof BLOK_COLOR_NAMES)[number];

export const BLOK_COLORS: Record<BlokColor, string> = {
  green: "#3bc76b",
  blue: "#4c86f5",
  red: "#f04438",
  orange: "#ff9432",
  purple: "#a468f7",
  cyan: "#3fc3f0",
  pink: "#f972b6",
  yellow: "#ffd93b",
  teal: "#2ec9a9",
  coral: "#ff7a63",
};

export const BLOK_SHAPES = [
  "star",
  "burst",
  "diamond",
  "bit",
  "triangle",
  "cloud",
  "drop",
  "invader",
] as const;

export type BlokShape = (typeof BLOK_SHAPES)[number];

export const BLOK_EXPRESSIONS = [
  "deadpan",
  "friendly",
  "focused",
  "thinking",
  "excited",
  "sleepy",
  "surprised",
  "skeptical",
  "worried",
  "mischievous",
] as const;

export type BlokExpression = (typeof BLOK_EXPRESSIONS)[number];

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type MascotBotProfile = {
  id?: string;
  name: string;
  title?: string;
  description?: string;
  shape?: BlokShape | null;
  mascotExpression?: BlokExpression | null;
  busy?: boolean;
  unread?: boolean;
  messages?: MascotMessage[];
};

/**
 * Stable default shape for agents created before shapes existed: hash the
 * id so every agent gets its own silhouette without a data migration.
 */
export function shapeForBot(bot: MascotBotProfile): BlokShape {
  if (bot.shape && BLOK_SHAPES.includes(bot.shape)) return bot.shape;
  const key = bot.id ?? bot.name;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return BLOK_SHAPES[Math.abs(hash) % BLOK_SHAPES.length];
}

/**
 * Selects a state glyph from live state first, then from what the agent is about.
 * The keyword groups deliberately overlap as little as possible so an agent's
 * an agent keeps the same face while everything else about it is
 * edited. Being recognisable in a list is the whole job.
 */
export function expressionForBot(bot: MascotBotProfile): BlokExpression {
  if (bot.mascotExpression) return bot.mascotExpression;

  const last = bot.messages?.[bot.messages.length - 1];

  if (last?.kind === "activity" && last.tool?.ok === false) return "worried";
  if (bot.busy) return "focused";
  if (bot.unread) return "surprised";
  if (last?.kind === "options") return "thinking";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "focused";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "thinking";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "sleepy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "surprised";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "skeptical";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "worried";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "mischievous";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "friendly";
  }

  return "deadpan";
}
