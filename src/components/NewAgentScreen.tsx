// Full-screen "build a new agent" flow, in two beats:
//   1. describe what it should do
//   2. the field flips to a name we already picked for you
// Suggested roles rotate and skip anything you already have, so the list
// stays useful once you have a few agents.
import { useEffect, useMemo, useRef, useState } from "react";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Upload from "lucide-react/dist/esm/icons/upload.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Input } from "@/components/ui/input";
import { track } from "@/lib/analytics";
import { api, useStore, type NewAgentProfile } from "@/state/store";
import {
  AGENT_TEMPLATES,
  GENERIC_SETUP,
  matchTemplate,
  suggestName,
  suggestTitle,
  type AgentTemplate,
} from "@/lib/agentTemplates";
import {
  BLOK_COLOR_NAMES,
  BLOK_SHAPES,
  type BlokColor,
  type BlokShape,
} from "@/lib/mascot";
import { BlokAvatar } from "./Avatar";
import { BlockField } from "./Brand";
import { AGENT_FILE_ACCEPT, ImportAgentDialog, readAgentFile } from "./ImportAgent";

const isElectron = navigator.userAgent.includes("Electron");
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const SUGGESTION_COUNT = 3;

function randomIdentity(): { color: BlokColor; shape: BlokShape } {
  return {
    color: BLOK_COLOR_NAMES[Math.floor(Math.random() * BLOK_COLOR_NAMES.length)],
    shape: BLOK_SHAPES[Math.floor(Math.random() * BLOK_SHAPES.length)],
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A compact preview of what a role can do, under its suggestion row. */
function TemplateRow({
  template,
  disabled,
  onPick,
}: {
  template: AgentTemplate;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onPick}
      className="group flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-accent active:scale-[0.99]"
    >
      <BlokAvatar
        color={template.color}
        shape={template.shape}
        expression="friendly"
        size={30}
      />
      <span className="min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground">{template.name}</span>
        <span className="ml-2 text-[13.5px] text-muted-foreground">{template.title}</span>
      </span>
      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {template.skills.length} skills
      </span>
    </button>
  );
}

export function NewAgentScreen() {
  const { state, dispatch } = useStore();
  const [step, setStep] = useState<"describe" | "name">("describe");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState(randomIdentity);
  const [creating, setCreating] = useState(false);
  const [naming, setNaming] = useState(false);
  const [rotation, setRotation] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // the text of a file waiting to be looked at; the dialog does the rest
  const [arriving, setArriving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // the role we matched from the description, carried into creation
  const matched = useRef<AgentTemplate | null>(null);

  const canGoBack = state.bots.some((b) => !b.hidden);
  // Setup hands off to this screen, so it doubles as the last onboarding
  // step. Same picker, different framing: you are choosing your first
  // agent rather than adding another one.
  const firstRun = state.newAgentFirstRun;

  // Don't suggest a role the user already has, and rotate what's left so
  // the list is different next time.
  const suggestions = useMemo(() => {
    const taken = new Set(
      state.bots.filter((b) => !b.hidden).map((b) => b.name.trim().toLowerCase()),
    );
    const fresh = AGENT_TEMPLATES.filter((t) => !taken.has(t.name.toLowerCase()));
    // once every role is taken, fall back to the full set rather than none
    return shuffle(fresh.length ? fresh : AGENT_TEMPLATES).slice(0, SUGGESTION_COUNT);
    // rotation is the shuffle trigger; bots length re-filters as agents appear
  }, [state.bots, rotation]);

  useEffect(() => {
    if (step === "name") nameRef.current?.select();
  }, [step]);

  /** What a model proposed for this agent, before the person edits it. */
  const [draft, setDraft] = useState<{ title: string; description: string; skills: string[] } | null>(
    null,
  );

  const close = () => dispatch({ type: "toggleNewAgent", open: false });

  /** A file, from the picker or from a drop. Read here and judged by the
   * server: whether it is really an agent is not this screen's call. */
  const takeFile = async (file: File | null | undefined) => {
    if (!file) return;
    setFileError(null);
    try {
      setArriving(await readAgentFile(file));
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  const create = (profile: NewAgentProfile) => {
    if (creating) return;
    setCreating(true);
    track("bot_created", { from: matched.current?.id ?? "described" });
    // botAdded closes this screen and selects the new agent
    dispatch({ type: "newBot", profile: { ...identity, ...profile } });
  };

  const createFromTemplate = (template: AgentTemplate) => {
    matched.current = template;
    setIdentity({ color: template.color, shape: template.shape });
    create({
      name: template.name,
      title: template.title,
      description: template.description,
      skills: template.skills,
      color: template.color,
      shape: template.shape,
      greeting: template.greeting,
      setup: template.setup,
    });
  };

  /** Beat 1 → 2: keep the description, propose a name, flip the field. */
  const goToNaming = () => {
    const description = text.trim();
    if (!description) return;
    const template = matchTemplate(description);
    matched.current = template;
    if (template) setIdentity({ color: template.color, shape: template.shape });
    setName(suggestName(description));
    setStep("name");

    // upgrade the local guess with a model-written one if a provider is
    // up; the flow never waits on it
    setNaming(true);
    setDraft(null);
    api("/api/agents/suggest", {
      method: "POST",
      body: JSON.stringify({ description }),
    })
      .then((s) => {
        // don't clobber a name the user has already started editing
        if (s?.name && !nameRef.current?.matches(":focus")) setName(s.name);
        // the rest of the draft is shown as editable fields rather than
        // applied quietly: a persona nobody read is one nobody can fix
        if (s?.title || s?.description || s?.skills?.length) {
          setDraft({ title: s.title ?? "", description: s.description ?? "", skills: s.skills ?? [] });
        }
      })
      .catch(() => {})
      .finally(() => setNaming(false));
  };

  const createFromDescription = () => {
    const description = text.trim();
    const finalName = name.trim() || suggestName(description);
    const template = matched.current;
    // A drafted persona is the agent's craft, the same job a template's
    // description does. It wins over the template when both exist,
    // because it was written for this description rather than matched
    // to it, and the person has had it in front of them either way.
    const craft = draft?.description?.trim() || template?.description;
    create({
      name: finalName,
      title: draft?.title?.trim() || template?.title || suggestTitle(description),
      // the user's own words are the persona; a role adds its craft
      description: craft ? `${description}\n\n${craft}` : description,
      skills: draft?.skills.length ? draft.skills : template?.skills,
      greeting: template?.greeting ?? GENERIC_SETUP.greeting,
      setup: template?.setup ?? GENERIC_SETUP.setup,
    });
  };

  const describing = step === "describe";

  return (
    <div
      className="absolute inset-0 z-30 flex animate-fade-in flex-col bg-background"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (step === "name") setStep("describe");
        else if (canGoBack) close();
      }}
      // A whole-screen drop target: an agent file is the one thing you
      // would ever drag onto this screen, so anywhere on it will do.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void takeFile(e.dataTransfer.files[0]);
      }}
    >
      <BlockField />

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-primary/50 bg-background/80 backdrop-blur-sm">
          <Upload size={22} className="text-muted-foreground" />
          <div className="text-[14px] font-medium text-foreground">Drop the agent here</div>
        </div>
      )}

      {/* Top bar. In the desktop shell this overlay covers the whole
          frameless window, so the leading control starts to the right of
          the traffic lights instead of underneath them. */}
      <div
        className={cn(
          "relative flex items-center justify-between px-4 py-3",
          // In the desktop shell the titlebar is hidden and its strip is a
          // drag region: a control inside it cannot be clicked. Clear the
          // strip vertically and the traffic lights horizontally, and mark
          // the row no-drag so its buttons take the click.
          isElectron && "pl-24 pt-9",
        )}
        style={isElectron ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
        {describing ? (
          // On first run there is nothing to go back to, setup is finished.
          // The way out is Nova, who is already waiting.
          firstRun ? (
            <Button variant="ghost" onClick={close}>
              Skip for now
            </Button>
          ) : canGoBack ? (
            <Button variant="ghost" onClick={close}>
              <ArrowLeft size={15} />
              Back
            </Button>
          ) : (
            <span />
          )
        ) : (
          <Button variant="ghost" onClick={() => setStep("describe")}>
            <ArrowLeft size={15} />
            Edit description
          </Button>
        )}
        <Button variant="ghost" onClick={() => create({})} disabled={creating}>
          Start blank
        </Button>
      </div>

      {/* Center */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <button
          onClick={() => setIdentity(randomIdentity())}
          className="group rounded-full outline-none transition-transform duration-150 ease-[var(--ease-out-quart)] hover:scale-105 active:scale-95"
          title="Shuffle the look"
        >
          {/* keyed so each new identity plays the landing pop */}
          <div key={`${identity.color}-${identity.shape}`} className="animate-pop">
            <BlokAvatar
              color={identity.color}
              shape={identity.shape}
              expression="friendly"
              size={72}
            />
          </div>
        </button>
        <div className="mt-1.5 text-[11.5px] text-muted-foreground/70">click to shuffle</div>

        <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-foreground">
          {describing
            ? firstRun
              ? "Who do you need first?"
              : "Build a new agent"
            : "What should we call it?"}
        </h1>
        <p className="mt-1.5 h-5 text-[13.5px] text-muted-foreground">
          {describing
            ? firstRun
              ? "Pick a role or describe the job. You can add more any time."
              : "Describe the job. It'll come with the skills to do it."
            : matched.current
              ? `Set up as a ${matched.current.name.toLowerCase()}, with ${matched.current.skills.length} skills included.`
              : "We picked one from your description. Change it if you like."}
        </p>

        {/* The one field, flipping between the two beats */}
        <div className="mt-5 w-full max-w-[560px] [perspective:1200px]">
          <div
            key={step}
            className="animate-flip-in"
            style={{ transformOrigin: "center" }}
          >
            <div
              className={cn(
                "flex items-center gap-1 rounded-full border bg-background p-1.5 pl-4 shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150",
                "focus-within:border-ring/50",
              )}
            >
              {describing ? (
                <input
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && goToNaming()}
                  placeholder="Describe what it should do"
                  className="w-full min-w-0 bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              ) : (
                <>
                  <input
                    ref={nameRef}
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createFromDescription()}
                    placeholder="Name your agent"
                    className="w-full min-w-0 bg-transparent text-[14.5px] font-medium text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {naming && (
                    <Loader2 size={14} className="mr-1 shrink-0 animate-spin text-muted-foreground" />
                  )}
                </>
              )}
              <button
                onClick={describing ? goToNaming : createFromDescription}
                disabled={creating || (describing ? !text.trim() : !name.trim())}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] duration-150 active:scale-95",
                  (describing ? text.trim() : name.trim()) && !creating
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "cursor-not-allowed bg-muted text-muted-foreground/60",
                )}
                title={describing ? "Continue" : "Create agent"}
              >
                {creating ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <ArrowUp size={17} strokeWidth={2.4} />
                )}
              </button>
            </div>

            {/* What was drafted for this agent, before it exists. Shown
                because a persona nobody read is one nobody can correct
                later, and editable for the same reason. */}
            {!describing && draft && (
              <div className="mx-auto mt-3 w-full max-w-[560px] animate-rise-in rounded-2xl border bg-card p-3 text-left">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Drafted for this agent
                  </span>
                  <button
                    onClick={() => setDraft(null)}
                    className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    title="Create the agent without any of this"
                  >
                    Start it blank
                  </button>
                </div>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="What they do"
                  className="h-8 text-[13px]"
                />
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="How they work"
                  rows={4}
                  className="mt-1.5 w-full resize-none rounded-lg border bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none focus:border-ring/50"
                />
                {draft.skills.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {draft.skills.map((skill, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                        <input
                          value={skill}
                          onChange={(e) => {
                            const skills = [...draft.skills];
                            skills[i] = e.target.value;
                            setDraft({ ...draft, skills });
                          }}
                          className="min-w-0 flex-1 bg-transparent text-[12px] leading-relaxed text-muted-foreground outline-none focus:text-foreground"
                        />
                        <button
                          onClick={() =>
                            setDraft({ ...draft, skills: draft.skills.filter((_, j) => j !== i) })
                          }
                          className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                          title="Drop this skill"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Everything here is editable now and in the agent's settings later.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Suggested roles, only while describing */}
        {describing && (
          <div className="mt-7 w-full max-w-[560px]">
            <div className="mb-1 flex items-center justify-between px-3.5">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Or start from a role
              </span>
              <button
                onClick={() => setRotation((r) => r + 1)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
                title="Show other roles"
              >
                <RefreshCw size={12} />
                Shuffle
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              {suggestions.map((t) => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  disabled={creating}
                  onPick={() => createFromTemplate(t)}
                />
              ))}
            </div>

            {/* Someone who already has an agent should not have to build
                it again. Quiet, because most people arrive without one. */}
            <div className="mt-4 flex items-center justify-center gap-1.5 text-[12.5px] text-muted-foreground">
              Already have one?
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-md px-1 py-0.5 font-medium text-foreground underline-offset-2 transition-colors duration-150 hover:underline"
              >
                Bring it in from a file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={AGENT_FILE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  void takeFile(e.target.files?.[0]);
                  // so picking the same file twice still fires
                  e.target.value = "";
                }}
              />
            </div>
            {fileError && (
              <div className="mt-2 text-center text-[12px] text-destructive">{fileError}</div>
            )}
          </div>
        )}
      </div>

      {arriving !== null && (
        <ImportAgentDialog text={arriving} onClose={() => setArriving(null)} />
      )}
    </div>
  );
}
