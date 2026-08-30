// Setting up the Local VM, as a checklist that checks itself.
//
// Four steps stand between a bare Mac and an agent with its own Linux
// desktop: a container runtime, that runtime running, the Cua desktop
// image prepared, and the VM created. The server reports which are done;
// finished steps cross themselves out, the current one carries the
// button, and a slow poll keeps the list honest while things install.
// The commands behind the buttons sit one disclosure away, for people
// who want to see the wires.
import { useCallback, useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

interface VmStatus {
  runtime: string | null;
  daemonUp: boolean;
  imageReady: boolean;
  container: "running" | "stopped" | "missing";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewerUrl: string | null;
  workspace: string;
  imageRef: string;
  baseRef: string;
  driverVersion: string;
  inUseBy: string | null;
  commands: { pull: string; run: string };
}

function CommandReveal({ label, command }: { label: string; command: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && (
        <code className="mt-1.5 block overflow-x-auto whitespace-nowrap rounded-lg bg-foreground/[0.05] px-3 py-2 font-mono text-[11px] text-foreground">
          {command}
        </code>
      )}
    </div>
  );
}

function Step({
  index,
  done,
  title,
  children,
}: {
  index: number;
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
          done ? "bg-success text-white" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <Check size={11} strokeWidth={3} /> : index}
      </span>
      <div className="min-w-0 flex-1 pb-3.5">
        <div
          className={cn(
            "text-[13px]",
            done ? "text-muted-foreground line-through decoration-muted-foreground/50" : "font-medium text-foreground",
          )}
        >
          {title}
        </div>
        {!done && children}
      </div>
    </div>
  );
}

export function LocalVmSection() {
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    api("/api/local-vm")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inflight.current = false;
      });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [load]);

  const act = (verb: "prepare" | "create" | "remove", confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setActing(verb);
    setError(null);
    api(`/api/local-vm/${verb}`, { method: "POST" })
      .then((s) => setStatus((cur) => ({ ...cur, ...s }) as VmStatus))
      .catch((e: Error) => setError(e.message))
      .finally(() => setActing(null));
  };

  const s = status;
  const staleOrStopped = s?.container === "stopped" || (s?.container === "running" && !s.desktopReady && s.imageReady && Boolean(s.problem?.includes("older")));

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-semibold text-foreground">Local VM</div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={load}>
          <RefreshCw size={12} />
          Re-check
        </Button>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        A Cua Linux desktop in a container on this Mac. Free, isolated from your own desktop, and
        recycled after 8 quiet hours; files in its workspace survive.
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {s === null ? (
        <Loader2 size={14} className="mt-3 animate-spin text-muted-foreground" />
      ) : s.ready ? (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-[13px] text-foreground">
            <span className="size-2 rounded-full bg-success" />
            Ready
            {s.inUseBy && <span className="text-muted-foreground">· {s.inUseBy} is using it</span>}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            {s.viewerUrl && (
              <a href={s.viewerUrl} target="_blank" rel="noreferrer">
                <Button variant="secondary" size="sm">
                  <ExternalLink size={12} />
                  Watch its screen
                </Button>
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={acting !== null}
              onClick={() => act("remove", "Remove the Local VM? Files in its workspace are kept.")}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3.5">
          <Step index={1} done={s.runtime !== null} title="Install a container runtime">
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              Apple's container CLI or Docker Desktop, either works.
            </div>
          </Step>
          <Step index={2} done={s.daemonUp} title="Start the container runtime">
            {s.runtime && (
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                Open {s.runtime === "container" ? "it with: container system start" : "Docker and wait for it to settle"}.
              </div>
            )}
          </Step>
          <Step index={3} done={s.imageReady} title="Prepare the Cua desktop (one-time download)">
            {s.daemonUp && (
              <Button
                size="sm"
                className="mt-1.5"
                disabled={acting !== null}
                onClick={() => act("prepare")}
              >
                {acting === "prepare" && <Loader2 size={12} className="animate-spin" />}
                {acting === "prepare" ? "Preparing, takes a few minutes" : "Prepare Cua desktop"}
              </Button>
            )}
            <CommandReveal label="Show base-image download" command={s.commands.pull} />
          </Step>
          <Step index={4} done={s.container === "running" && s.desktopReady} title="Create and start the Local VM">
            {s.imageReady &&
              (staleOrStopped ? (
                <Button
                  size="sm"
                  className="mt-1.5"
                  disabled={acting !== null}
                  onClick={() =>
                    act(
                      "remove",
                      "Recreate the Local VM? Files in its workspace are kept, everything else resets.",
                    )
                  }
                >
                  {acting === "remove" && <Loader2 size={12} className="animate-spin" />}
                  Remove, then create again
                </Button>
              ) : s.container === "missing" ? (
                <Button
                  size="sm"
                  className="mt-1.5"
                  disabled={acting !== null}
                  onClick={() => act("create")}
                >
                  {acting === "create" && <Loader2 size={12} className="animate-spin" />}
                  Create Local VM
                </Button>
              ) : (
                <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Loader2 size={11} className="animate-spin" />
                  {s.problem ?? "Waiting for the desktop…"}
                </div>
              ))}
            <CommandReveal label="Show command" command={s.commands.run} />
          </Step>

          <div className="mt-1 rounded-xl bg-muted/50 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            The VM gets 4GB, 2 CPUs, and a viewer only this Mac can open. One host folder is
            mounted as its workspace; browser sign-ins and files there survive recreation.
            <div className="mt-1 text-muted-foreground/70">
              Workspace: {s.workspace} · Driver {s.driverVersion}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
