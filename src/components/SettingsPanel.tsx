import { useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Crown from "lucide-react/dist/esm/icons/crown.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Fingerprint from "lucide-react/dist/esm/icons/fingerprint-pattern.mjs";
import Library from "lucide-react/dist/esm/icons/library.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, type Bot, type Skill } from "@/state/store";
import { useMcpServers, type McpServerRow } from "./McpServers";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import {
  expressionForBot,
  shapeForBot,
  BLOK_COLORS,
  BLOK_COLOR_NAMES,
  BLOK_EXPRESSIONS,
  BLOK_SHAPES,
} from "@/lib/mascot";
import { ModelPicker } from "./ModelPicker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { VoiceCard } from "./Voice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/cn";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12.5px] font-medium text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}

/** Library skills this agent has attached. Toggling one changes what
 * reaches the model on the very next turn. */
function AttachedSkills({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [library, setLibrary] = useState<Skill[] | null>(null);
  const attached = bot.skillIds ?? [];

  useEffect(() => {
    api("/api/skills")
      .then((r) => setLibrary(r.skills ?? []))
      .catch(() => setLibrary([]));
  }, []);

  const toggle = (id: string) =>
    dispatch({
      type: "updateBot",
      botId: bot.id,
      patch: {
        skillIds: attached.includes(id) ? attached.filter((s) => s !== id) : [...attached, id],
      },
    });

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Library size={14} className="text-muted-foreground" />
          <span className="text-[13.5px] font-semibold text-foreground">From the library</span>
          <span className="text-[12px] text-muted-foreground">{attached.length}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "toggleSkills", open: true })}>
          Manage
        </Button>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Shared instruction sets this agent can carry.
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {library === null ? (
          <div className="py-3 text-[12.5px] text-muted-foreground">Loading…</div>
        ) : library.length === 0 ? (
          <div className="py-3 text-[12.5px] text-muted-foreground">No skills installed yet.</div>
        ) : (
          library.map((skill) => {
            const on = attached.includes(skill.id);
            return (
              <button
                key={skill.id}
                onClick={() => toggle(skill.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
                  on ? "bg-brand-soft" : "hover:bg-accent",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded",
                    on ? "bg-brand-ink text-brand-foreground" : "border",
                  )}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("text-[12.5px] font-medium", on ? "text-brand-ink" : "text-foreground")}>
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span className="mt-px block truncate text-[11.5px] text-muted-foreground">
                      {skill.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Skills are instructions the agent carries into every turn, they go
 * into its system prompt, so editing one changes behavior. */
function SkillsEditor({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const skills = bot.skills ?? [];

  const setSkills = (next: string[]) =>
    dispatch({ type: "updateBot", botId: bot.id, patch: { skills: next } });

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    setSkills([...skills, value]);
    setDraft("");
  };

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-muted-foreground" />
        <span className="text-[13.5px] font-semibold text-foreground">Skills</span>
        <span className="text-[12px] text-muted-foreground">{skills.length}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Instructions this agent carries into every conversation.
      </div>

      {skills.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {skills.map((skill, i) => (
            <div
              key={`${i}-${skill.slice(0, 12)}`}
              className="group flex items-start gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground">
                {skill}
              </span>
              <button
                onClick={() => setSkills(skills.filter((_, j) => j !== i))}
                className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-destructive group-hover:opacity-100"
                title="Remove skill"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a skill: when to use it, and what to return"
          className="h-8 text-[12.5px]"
        />
        <Button variant="secondary" size="icon-sm" onClick={add} disabled={!draft.trim()} title="Add">
          <Plus size={14} />
        </Button>
      </div>
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "color"
        | "shape"
        | "seniority"
        | "withoutComponents"
        | "effort"
        | "mascotExpression"
        | "composio"
      >
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  /** Center-crop to a square, shrink to 512, and ship as JPEG. Done
   * here so the server never has to buffer somebody's 12MB original. */
  const uploadAvatar = (file: File) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(
        image,
        (image.width - side) / 2,
        (image.height - side) / 2,
        side,
        side,
        0,
        0,
        512,
        512,
      );
      const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      api(`/api/bots/${bot.id}/avatar`, {
        method: "PUT",
        body: JSON.stringify({ data, mime: "image/jpeg" }),
      }).catch(() => {});
    };
    image.src = url;
  };

  const activeExpression = expressionForBot(bot);
  const activeShape = shapeForBot(bot);
  const [lookTab, setLookTab] = useState<"shape" | "color" | "face">("shape");
  const shuffleLook = () =>
    patch({
      color: BLOK_COLOR_NAMES[Math.floor(Math.random() * BLOK_COLOR_NAMES.length)],
      shape: BLOK_SHAPES[Math.floor(Math.random() * BLOK_SHAPES.length)],
    });

  return (
    <Dialog open onOpenChange={(open) => !open && dispatch({ type: "toggleSettings", open: false })}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[560px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center border-b px-5">
          <DialogTitle className="text-[14.5px]">Agent settings</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6">
        {/* Identity: the live face beside one control panel at a time.
            A photo replaces the pixel identity everywhere it is shown;
            the identity underneath survives, so removing the photo
            brings the same face back rather than a reroll. */}
        <div className="mt-5 rounded-2xl border bg-card p-4">
          {/* Side by side when there is room. On a phone the controls get
              about 150px beside the face, which is not enough for four
              tab labels or a row of six shapes, so the face goes above
              them and they get the whole width. */}
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
            <div className="flex shrink-0 flex-col items-center gap-2 pt-1 sm:w-[116px]">
              <button
                onClick={shuffleLook}
                title="Shuffle the look"
                className="rounded-full outline-none transition-transform duration-150 hover:scale-105 active:scale-95"
              >
                <div key={`${bot.color}-${bot.shape}`} className="animate-pop">
                  <AgentAvatar bot={bot} size={88} />
                </div>
              </button>
              <div className="text-[11px] text-muted-foreground/70">click to shuffle</div>
              <div className="flex flex-col items-center">
                <label className="cursor-pointer rounded-lg px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  {bot.avatarAt ? "Change photo" : "Use a photo"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadAvatar(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                {bot.avatarAt && (
                  <button
                    className="rounded-lg px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      api(`/api/bots/${bot.id}/avatar`, { method: "DELETE" }).catch(() => {});
                    }}
                  >
                    Remove photo
                  </button>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-center gap-1">
                {(
                  [
                    ["shape", "Shape"],
                    ["color", "Color"],
                    ["face", "Face"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setLookTab(key)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                      lookTab === key
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-muted-foreground"
                  onClick={() => patch({ color: "green", shape: "star", mascotExpression: null })}
                >
                  Reset
                </Button>
              </div>

              {lookTab === "shape" && (
                <div className="grid grid-cols-6 gap-1">
                  {BLOK_SHAPES.map((shape) => (
                    <button
                      key={shape}
                      onClick={() => patch({ shape })}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-lg transition-colors duration-150 hover:bg-accent active:scale-95",
                        activeShape === shape && "bg-accent ring-2 ring-ring",
                      )}
                      title={shape}
                      aria-label={`Use ${shape} shape`}
                    >
                      <BlokAvatar color={bot.color} shape={shape} expression="deadpan" size={30} />
                    </button>
                  ))}
                </div>
              )}

              {lookTab === "color" && (
                <div className="grid grid-cols-5 gap-2 p-1">
                  {BLOK_COLOR_NAMES.map((color) => (
                    <button
                      key={color}
                      onClick={() => patch({ color })}
                      className={cn(
                        "size-9 justify-self-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-95",
                        bot.color === color && "ring-2 ring-ring ring-offset-2 ring-offset-card",
                      )}
                      style={{ backgroundColor: BLOK_COLORS[color] }}
                      title={color}
                      aria-label={`Use ${color} color`}
                    />
                  ))}
                </div>
              )}

              {lookTab === "face" && (
                <div className="grid grid-cols-5 gap-1">
                  {BLOK_EXPRESSIONS.map((expression) => (
                    <button
                      key={expression}
                      onClick={() => patch({ mascotExpression: expression })}
                      className={cn(
                        "flex h-[48px] items-center justify-center rounded-lg transition-colors duration-150 hover:bg-accent active:scale-95",
                        activeExpression === expression && "bg-accent ring-2 ring-ring",
                      )}
                      title={expression}
                      aria-label={`Use ${expression} expression`}
                    >
                      <BlokAvatar
                        color={bot.color}
                        shape={activeShape}
                        expression={expression}
                        size={34}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3.5">
          <Field label="Name">
            <Input value={bot.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="Title">
            <Input
              placeholder="What this agent does, in a line"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="Instructions">
            <Textarea
              className="min-h-[96px] resize-none"
              placeholder="What this agent is for, how it should behave"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <SkillsEditor bot={bot} />
          <AttachedSkills bot={bot} />

          <div className="rounded-2xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <Crown size={14} className="text-muted-foreground" />
              <span className="text-[13.5px] font-semibold text-foreground">Seniority</span>
            </div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              In a room the most senior agent speaks last, reviews everyone else's work, and makes
              the final call. Give seniors your most capable model and juniors cheaper ones.
            </div>
            <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
              {(
                [
                  [1, "Junior"],
                  [3, "Mid"],
                  [5, "Lead"],
                ] as const
              ).map(([level, label]) => {
                const current = bot.seniority ?? 1;
                const on = level === 5 ? current >= 4 : level === 3 ? current === 3 : current <= 2;
                return (
                  <button
                    key={level}
                    onClick={() => patch({ seniority: level })}
                    className={cn(
                      "flex-1 rounded-lg py-1 text-[12.5px] transition-colors duration-150",
                      on
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-4">
            <div className="text-[13.5px] font-semibold text-foreground">Reasoning effort</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              How hard the engine thinks, where the engine has the dial
            </div>
            <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
              {(
                [
                  [undefined, "Default"],
                  ["low", "Low"],
                  ["medium", "Medium"],
                  ["high", "High"],
                ] as const
              ).map(([level, label]) => (
                <button
                  key={label}
                  onClick={() => patch({ effort: level })}
                  className={cn(
                    "flex-1 rounded-lg py-1 text-[12.5px] transition-colors duration-150",
                    bot.effort === level
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl border bg-card p-4">
            <div>
              <div className="text-[13.5px] font-semibold text-foreground">Model</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                The provider this agent runs on
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          <div className="rounded-2xl border bg-card p-4">
            <div className="text-[13.5px] font-semibold text-foreground">Computer</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              Where this agent's computer runs{bot.computer ? "" : " (currently: auto)"}
            </div>
            {/* Four homes for an agent's hands. A 2x2 grid, because four
                options in one row is where segmented controls stop being
                readable. */}
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] text-foreground">Automatic</div>
                <div className="text-[12px] text-muted-foreground">
                  The cloud box when one exists, else this computer
                </div>
              </div>
              <Switch
                checked={!bot.computer}
                onCheckedChange={(on) => patch({ computer: on ? null : "local" })}
              />
            </div>
            {/* Auto's fallback should never be a surprise: with no box
                configured it means "this Mac", and the person deciding
                deserves to know that at the moment they decide it. */}
            {!bot.computer && !state.config?.box?.configured && (
              <div className="mt-2 rounded-xl bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
                No cloud box is set up, so Auto will use this computer.{" "}
                <button
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => dispatch({ type: "toggleComputer", open: true })}
                >
                  Set one up
                </button>
              </div>
            )}
            <div
              className={cn(
                "mt-3 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 transition-opacity duration-150",
                !bot.computer && "pointer-events-none opacity-45",
              )}
            >
                          {(
                [
                  ["cloud", "Cloud box"],
                  ["sandbox", "Local VM"],
                  ["local", "This computer"],
                  ["off", "Off"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => patch({ computer: mode })}
                  className={cn(
                    "rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                    bot.computer === mode
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <VoiceCard bot={bot} />
          <ApprovalsCard bot={bot} />
          <WorkingFolderCard bot={bot} />
          <ConnectedAppsCard bot={bot} patch={patch} />
          <McpAttachCard bot={bot} />
          <MemoryCard bot={bot} />
          <AnswersCard bot={bot} patch={patch} />
          <IdentityCard bot={bot} />
          <TakeItWithYouCard bot={bot} />

          <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl border bg-card p-4">
            <div>
              <div className="text-[13.5px] font-semibold text-foreground">Notifications</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                Let {bot.name} interrupt you when a reply lands
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              onCheckedChange={(notifications) => patch({ notifications })}
            />
          </div>
          {/* The rule, stated. A person deciding whether to leave this on
              deserves to know what it does and does not cover, rather
              than discovering the shape of it over a week. */}
          <div className="mt-2 rounded-xl bg-muted/50 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            Approvals always interrupt, even with this off: a waiting agent has
            stopped working. Agents talking to each other in a room stay quiet
            unless they name you. Nothing interrupts you about the conversation
            already on your screen.
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


/**
 * How much this agent may do without asking. Three positions, widening:
 * everything cards, file edits wave through, everything waves through.
 * Deny rules in Settings > Rules outrank all three, so "auto" is a
 * shorter leash than it sounds when the user has written any.
 */
function ApprovalsCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const mode = bot.approvals ?? "ask";
  const OPTIONS = [
    { id: "ask" as const, label: "Ask", hint: "Every consequential action cards" },
    { id: "edits" as const, label: "Accept edits", hint: "File changes go ahead; the rest asks" },
    { id: "auto" as const, label: "Auto", hint: "Everything goes ahead; deny rules still refuse" },
  ];
  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-foreground">
        Approvals
        <InfoTip text="A mode only widens what is allowed. Anything you have forbidden under Settings > Rules stays refused in every mode, and answers you chose to remember from approval cards keep working too." />
      </div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
        {OPTIONS.find((o) => o.id === mode)?.hint}
      </div>
      <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
        {OPTIONS.map((option) => (
          <button
            key={option.id}
            onClick={() =>
              dispatch({ type: "updateBot", botId: bot.id, patch: { approvals: option.id } })
            }
            className={cn(
              "flex-1 rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
              mode === option.id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The folder this agent's new tasks run in. Server-validated: a typo'd
 * path is refused with the reason rather than silently kept. */
function WorkingFolderCard({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(bot.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = (next: string | null) => {
    setError(null);
    api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: next }) })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
        if (next === null) setValue("");
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-semibold text-foreground">Working folder</div>
        {saved && (
          <span className="flex items-center gap-1 text-[11.5px] text-success">
            <Check size={12} /> Saved
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Where new tasks run.
        <InfoTip text="Point it at a project to work in that repo; leave it empty and the agent uses its own workspace. Running tasks keep the folder they started in." />
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save(value.trim() || null)}
          placeholder="~/Projects/my-app"
          spellCheck={false}
          className="h-8 font-mono text-[12px]"
        />
        <BrowseFolderButton
          onPick={(path) => {
            setValue(path);
            save(path);
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => save(value.trim() || null)}>
          Save
        </Button>
      </div>
      {error && <div className="mt-1.5 text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

/** The per-agent connector grant. The Composio key is shared by the
 * whole workspace; whether THIS agent may use it is decided here. */
function McpAttachCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { servers } = useMcpServers();
  if (!servers?.length) return null;
  const attached = bot.mcpServers ?? [];

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">MCP servers</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Which of your registered servers this agent may use.
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {servers.map((server: McpServerRow) => {
          const on = attached.includes(server.id);
          return (
            <div key={server.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-foreground">{server.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {server.transport === "http" ? server.target : `runs ${server.target}`}
                </div>
              </div>
              <Switch
                checked={on}
                onCheckedChange={(next) =>
                  dispatch({
                    type: "updateBot",
                    botId: bot.id,
                    patch: {
                      mcpServers: next
                        ? [...attached, server.id]
                        : attached.filter((id) => id !== server.id),
                    },
                  })
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConnectedAppsCard({
  bot,
  patch,
}: {
  bot: Bot;
  patch: (p: { composio: boolean }) => void;
}) {
  const { state } = useStore();
  const configured = state.config?.composio?.configured ?? false;
  const allowed = bot.composio !== false;

  return (
    <div className="mt-4 flex items-center justify-between rounded-2xl border bg-card p-4">
      <div className="min-w-0 pr-3">
        <div className="text-[13.5px] font-semibold text-foreground">Connected apps</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {configured
            ? allowed
              ? "This agent can use your connected apps (Slack, Gmail, and the rest)."
              : "Blocked from your connected apps; it works with its own tools only."
            : "No connector key yet. Add one in Settings → Apps."}
        </div>
      </div>
      <Switch
        checked={allowed}
        disabled={!configured && allowed === false}
        onCheckedChange={(on) => patch({ composio: on })}
      />
    </div>
  );
}

const COMPONENTS: Array<[string, string]> = [
  ["chart", "Charts"],
  ["table", "Tables"],
  ["decision", "Decisions"],
  ["steps", "Step lists"],
  ["quote", "Quotes"],
  ["refused", "Refusals"],
];

/**
 * What this agent may answer with instead of prose.
 *
 * By exclusion, so switching one off for one agent leaves everybody else
 * alone. All on by default: the point of the gallery is that an answer
 * that is really a table arrives as a table, and making somebody opt into
 * that one shape at a time would mean nobody ever sees it.
 */
function AnswersCard({ bot, patch }: { bot: Bot; patch: (p: { withoutComponents: string[] }) => void }) {
  const without = bot.withoutComponents ?? [];
  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">Answers</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {bot.name} can answer with these instead of describing them in prose. Switch one off and it
        will write that kind of answer out in words instead.
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {COMPONENTS.map(([kind, label]) => {
          const on = !without.includes(kind);
          return (
            <label key={kind} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-foreground">{label}</span>
              <Switch
                checked={on}
                onCheckedChange={(next) =>
                  patch({
                    withoutComponents: next ? without.filter((k) => k !== kind) : [...without, kind],
                  })
                }
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Who this agent is, as something checkable.
 *
 * Shown rather than managed: there is no button to make a key, rotate one
 * or turn signing off, because every one of those is a way to end up with
 * a record that says less than it appears to. The agent has a key, the
 * record carries what it signed, and this is where a person can see the
 * public half of it.
 */
function IdentityCard({ bot }: { bot: Bot }) {
  const [full, setFull] = useState(false);
  const print = bot.fingerprint ?? "";
  if (!print) return null;
  // both ends, never just the front: a prefix is cheap to imitate
  const short = `${print.slice(0, 8)}…${print.slice(-4)}`;

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Fingerprint size={14} className="text-muted-foreground" />
        <span className="text-[13.5px] font-semibold text-foreground">Signature</span>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {bot.name} signs what it does in the record, so afterwards you can tell what it really did
        from what something merely says it did. The private half of the key never leaves this Mac.
      </div>
      <button
        onClick={() => setFull((v) => !v)}
        title={full ? "Show it short" : "Show all of it"}
        className="mt-2.5 w-full rounded-xl bg-muted/60 px-3 py-2 text-left font-mono text-[12px] leading-relaxed text-foreground transition-colors duration-150 hover:bg-muted"
      >
        {full ? <span className="break-all">{print}</span> : short}
      </button>
    </div>
  );
}

/** What the agent believes, in its own words: MEMORY.md, editable, plus
 * the topic files it keeps for the long tail. */
/** An agent as a file. What leaves is the agent: who it is, the skills it
 * carries and what it has learned. Its conversations stay here, because
 * they belong to this workspace rather than to the agent. */
function TakeItWithYouCard({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}/export`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "export failed");
      // the filename the server chose, so what lands on disk is what the
      // server says it is rather than something guessed here
      const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = named?.[1] ?? "agent.bloks-agent.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Take {bot.name} with you</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            One file with everything that makes {bot.name} itself: the role, the
            look, the skills and the memory. Drop it into Bloks on another
            machine and the same agent is there.
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled={busy} onClick={save}>
          <Download size={13} />
          {busy ? "Saving" : "Export"}
        </Button>
      </div>
      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {error}
        </div>
      )}
      <div className="mt-2 rounded-xl bg-muted/50 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        Conversations stay here. The file is the agent, not the history, and it
        carries no keys: whoever opens it uses their own.
      </div>
    </div>
  );
}

function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<Array<{ name: string; bytes: number }>>([]);
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () => {
    api(`/api/bots/${bot.id}/memory`)
      .then((r) => {
        setText(r.text ?? "");
        setTruncated(Boolean(r.truncated));
        setTopics(r.topics ?? []);
        setDirty(false);
      })
      .catch((e: Error) => setError(e.message));
  };

  const save = () => {
    setError(null);
    api(`/api/bots/${bot.id}/memory`, { method: "PUT", body: JSON.stringify({ text }) })
      .then((r) => {
        setDirty(false);
        setTruncated(Boolean(r.truncated));
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
      })
      .catch((e: Error) => setError(e.message));
  };

  const size = (bytes: number) =>
    bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={() => {
          const next = !open;
          setOpen(next);
          // re-read on every expand: the agent may have written notes
          // mid-session, and stale memory in an editor is a lie
          if (next) load();
        }}
      >
        <div>
          <div className="text-[13.5px] font-semibold text-foreground">Memory</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            What this agent remembers between conversations. Yours to read and correct.
          </div>
        </div>
        <span className="text-[12px] text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {viewing ? (
            <>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] text-muted-foreground">
                  memory/{viewing.name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setViewing(null)}>
                  Back
                </Button>
              </div>
              <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-3 font-mono text-[12px] leading-relaxed text-foreground">
                {viewing.text}
              </pre>
            </>
          ) : (
            <>
              <Textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
                placeholder="Nothing remembered yet. The agent writes here as it learns; you can too."
                className="min-h-[150px] font-mono text-[12px]"
              />
              {truncated && (
                <div className="mt-1.5 text-[12px] text-warning">
                  Over the load budget. Only the top of this file reaches the agent each turn.
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" onClick={save} disabled={!dirty}>
                  Save
                </Button>
                {saved && (
                  <span className="flex items-center gap-1 text-[11.5px] text-success">
                    <Check size={12} /> Saved
                  </span>
                )}
              </div>
              {topics.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Topic files
                  </div>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {topics.map((topic) => (
                      <button
                        key={topic.name}
                        onClick={() =>
                          api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(topic.name)}`)
                            .then((r) => setViewing({ name: topic.name, text: r.text }))
                            .catch((e: Error) => setError(e.message))
                        }
                        className="flex items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                      >
                        <span className="font-mono text-[12px] text-foreground">{topic.name}</span>
                        <span className="text-[11px] text-muted-foreground">{size(topic.bytes)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}
