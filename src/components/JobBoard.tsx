// The job board: work posted without naming who does it.
//
// With one agent you talk to it. With six, saying the same thing six
// times to find out who is the right one is worse than having one. So a
// job goes up, the board offers it to whoever looks most suited, and that
// agent may hand it back, which is what makes taking it mean anything.
//
// What this screen has to show is therefore not a list of tasks: it is
// who took each one, who turned it down and why, and what came of it.
import { useCallback, useEffect, useState } from "react";
import Briefcase from "lucide-react/dist/esm/icons/briefcase.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { api, useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";

interface JobOffer {
  botId: string;
  name: string;
  at: number;
  passed?: string;
}

interface Job {
  id: string;
  title: string;
  brief: string;
  postedAt: number;
  state: "open" | "claimed" | "done" | "failed" | "cancelled";
  offers: JobOffer[];
  claimedBy?: string;
  claimedName?: string;
  claimedAt?: number;
  threadId?: string;
  finishedAt?: number;
  result?: string;
}

const STATE_LABEL: Record<Job["state"], string> = {
  open: "Waiting for someone",
  claimed: "In progress",
  done: "Done",
  failed: "Did not finish",
  cancelled: "Cancelled",
};

function when(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function JobBoard() {
  const { state, dispatch } = useStore();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/jobs")
      .then((r) => {
        setJobs(r.jobs ?? []);
        // a board that is reading again is not a board with an error on
        // it, and a stale one sits there long after it stopped being true
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    // A job's state changes when a turn somewhere else ends, so this
    // watches rather than waits to be told.
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  const post = () => {
    if (!title.trim() && !brief.trim()) return;
    setPosting(true);
    setError(null);
    api("/api/jobs", { method: "POST", body: JSON.stringify({ title, brief }) })
      .then(() => {
        setTitle("");
        setBrief("");
        load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setPosting(false));
  };

  const act = (path: string, init?: RequestInit) =>
    api(path, init)
      .then(load)
      .catch((e: Error) => setError(e.message));

  const agentFor = (id?: string) => state.bots.find((bot) => bot.id === id);

  return (
    <>
      <div className="mt-4 rounded-2xl border bg-card p-4">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
          <Briefcase size={15} className="text-muted-foreground" />
          Post a job
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Say what needs doing, not who should do it. Whoever looks most suited
          is asked first, and can hand it back.
        </div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && post()}
          placeholder="Write the launch note"
          className="mt-3"
        />
        <Textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Anything else worth knowing. Optional."
          rows={2}
          className="mt-2 resize-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-muted-foreground">
            {state.bots.filter((b) => !b.hidden).length} agents can see the board
          </span>
          <Button size="sm" disabled={posting || (!title.trim() && !brief.trim())} onClick={post}>
            {posting && <Loader2 size={12} className="animate-spin" />}
            Post it
          </Button>
        </div>
        {error && (
          <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {jobs === null && (
          <div className="flex items-center gap-2 rounded-2xl border bg-card px-4 py-6 text-[12.5px] text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Reading the board
          </div>
        )}
        {jobs?.length === 0 && (
          <div className="rounded-2xl border border-dashed px-4 py-8 text-center text-[12.5px] text-muted-foreground">
            Nothing on the board. Post something and see who takes it.
          </div>
        )}
        {jobs?.map((job) => {
          const agent = agentFor(job.claimedBy);
          const refusals = job.offers.filter((offer) => offer.passed);
          return (
            <div key={job.id} className="rounded-2xl border bg-card p-4">
              <div className="flex items-start gap-3">
                {agent ? (
                  <AgentAvatar bot={agent} size={30} />
                ) : (
                  <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Briefcase size={14} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-foreground">{job.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                    <span
                      className={cn(
                        job.state === "done" && "text-success",
                        job.state === "failed" && "text-destructive",
                      )}
                    >
                      {STATE_LABEL[job.state]}
                    </span>
                    {job.claimedName && <span>· taken by {job.claimedName}</span>}
                    <span>· posted {when(job.postedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {job.state === "claimed" && agent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        dispatch({ type: "select", id: agent.id });
                        if (job.threadId) {
                          dispatch({ type: "selectTask", botId: agent.id, taskId: job.threadId });
                        }
                      }}
                    >
                      Watch
                    </Button>
                  )}
                  {job.state !== "claimed" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={job.offers.length ? "Ask around again" : "Offer it"}
                      onClick={() =>
                        act(`/api/jobs/${job.id}/offer`, {
                          method: "POST",
                          body: JSON.stringify({ again: job.state !== "open" || refusals.length > 0 }),
                        })
                      }
                    >
                      <RotateCw size={13} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={job.state === "claimed" ? "Cancel it" : "Take it off the board"}
                    onClick={() => act(`/api/jobs/${job.id}`, { method: "DELETE" })}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>

              {job.brief && job.brief !== job.title && (
                <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-muted-foreground">
                  {job.brief}
                </p>
              )}

              {/* Who turned it down is as much of the story as who took it. */}
              {refusals.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {refusals.map((offer) => (
                    <div key={`${offer.botId}-${offer.at}`} className="text-[11.5px] text-muted-foreground">
                      <span className="text-foreground/70">{offer.name}</span> passed: {offer.passed}
                    </div>
                  ))}
                </div>
              )}

              {job.state === "open" && job.offers.length > 0 && (
                <div className="mt-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[12px] text-muted-foreground">
                  Everyone has been asked. Ask around again to start another round.
                </div>
              )}

              {job.result && (
                <div className="mt-2 whitespace-pre-wrap rounded-xl bg-muted/50 px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
                  {job.result}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
