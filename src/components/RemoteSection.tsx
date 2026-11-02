// Your servers: workspaces on computers you run that never sleep
// (bloks-server), reached through Bloks Cloud or at an address of your
// own (server/self-host.ts), and whether this computer runs workspaces of
// its own at all (GitHub 428).
//
// Desktop only. In a browser or on a phone there is no "this app" to
// pair. Each server is a workspace in the switcher like the ones here:
// paired with a link from `bloks-server pair`, named, opened with the
// keyboard, and removed on its own, so adding or pairing one again never
// touches another. With "Run workspaces on this computer" off, the app
// is a window onto them alone: nothing here starts, and the workspaces
// here wait, as they are, until it is turned back on. Nothing restarts.
import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Server } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";
import { act, useWorkspaces } from "@/lib/workspaces";
import type { WorkspaceInfo } from "@/types/bridge";
import { ConnectionHeader, HealthLine } from "./ConnectionKit";
import { goToWorkspace } from "./WorkspaceSwitcher";
import { WorkspaceMark } from "./WorkspaceMark";
import { t, tr } from "@/lib/i18n";

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 font-mono text-caption text-foreground">{children}</code>
);

/** How a server is doing, as the switcher knows it. */
function health(ws: WorkspaceInfo): { tone: "on" | "wait" | "issue" | "off"; label: string } {
  if (ws.status === "running") return { tone: "on", label: t("common.connected") };
  if (ws.status === "starting") return { tone: "wait", label: t("remoteSection.connecting") };
  if (ws.status === "failed") return { tone: "issue", label: t("remoteSection.cantReachIt") };
  return { tone: "off", label: t("remoteSection.notOpenYet") };
}

/** How a server is reached: through Bloks Cloud, or at the address of
 * its owner's own it was paired at (server/self-host.ts). */
function where(ws: WorkspaceInfo): string {
  if (ws.direct) return ws.host ? t("remoteSection.onHostAt", { host: ws.host, address: ws.direct }) : t("remoteSection.atAddress", { address: ws.direct });
  return ws.host ? t("remoteSection.onHostShort", { host: ws.host }) : t("remoteSection.throughCloud");
}

function ServerRow({ ws, current }: { ws: WorkspaceInfo; current: boolean }) {
  const [busy, setBusy] = useState(false);
  const said = health(ws);
  const remove = async () => {
    const yes = await confirm({
      title: t("remoteSection.removeTitle", { name: ws.name }),
      body: t("remoteSection.removeBody", { computer: thisComputer() }),
      confirmLabel: t("remoteSection.remove"),
      destructive: true,
    });
    if (!yes) return;
    setBusy(true);
    const error = await act(window.bloks?.workspaceDelete?.(ws.id));
    if (error) toast.error(error);
    setBusy(false);
  };
  return (
    <li className="flex items-center gap-3 py-2.5">
      <WorkspaceMark mark={ws.mark} logo={ws.logo} size={22} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium text-foreground">{ws.name}</span>
        <span className="truncate text-small text-muted-foreground" title={ws.problem ?? undefined}>
          {ws.status === "failed" && ws.problem ? ws.problem : where(ws)}
        </span>
      </span>
      <HealthLine tone={said.tone} label={said.label} />
      {!current && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void goToWorkspace(ws.id)}>
          {t("remoteSection.open")}
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()} aria-label={t("remoteSection.removeNamed", { name: ws.name })}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : t("remoteSection.remove")}
      </Button>
    </li>
  );
}

export function RemoteSection() {
  const bridge = typeof window !== "undefined" ? window.bloks : undefined;
  const s = useWorkspaces();
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bridge?.remoteConnect || !s.available) return null;

  const servers = s.workspaces.filter((w) => w.kind === "remote");
  // an app from before this said nothing, and always ran workspaces here
  const local = s.local !== false;
  const pasted = link.trim();

  const add = async () => {
    if (busy || !pasted) return;
    setBusy(true);
    setError(null);
    const result = await bridge.remoteConnect!(pasted, name.trim() || undefined);
    if (result?.error) setError(result.error);
    else {
      setLink("");
      setName("");
    }
    setBusy(false);
  };

  const setLocal = async (on: boolean) => {
    if (!on) {
      const yes = await confirm({
        title: t("remoteSection.localOffTitle", { computer: thisComputer() }),
        body: t("remoteSection.localOffBody", { computer: thisComputer() }),
        confirmLabel: t("remoteSection.turnOff"),
      });
      if (!yes) return;
    }
    const failed = await act(bridge.workspaceLocal?.(on));
    if (failed) toast.error(failed);
  };

  const icon = <Server size={14} className="shrink-0 text-muted-foreground" />;

  return (
    <div className="mb-9 rounded-2xl border bg-card p-5 last:mb-0" data-setting-row="your-servers">
      <ConnectionHeader
        icon={icon}
        title={t("remoteSection.yourServers")}
        says={
          local
            ? servers.length
              ? t("remoteSection.besideThisComputer", { computer: thisComputer() })
              : t("remoteSection.onThisComputer", { computer: thisComputer() })
            : t("remoteSection.serversOnly", { computer: thisComputer() })
        }
      />
      {servers.length > 0 && (
        <ul className="mt-2 divide-y" aria-label={t("remoteSection.yourServers")}>
          {servers.map((ws) => (
            <ServerRow key={ws.id} ws={ws} current={ws.id === s.current} />
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setError(null);
          }}
          aria-label={t("remoteSection.linkFromBloksServer")}
          placeholder={t("remoteSection.pasteALinkFromBloks")}
          autoComplete="off"
          spellCheck={false}
          className={cn("h-8 min-w-[200px] flex-[2] text-body", link && "font-mono")}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("remoteSection.nameIt")}
          placeholder={t("remoteSection.nameOptional")}
          autoComplete="off"
          maxLength={40}
          className="h-8 min-w-[120px] flex-1 text-body"
        />
        {/* grey until there is a link to use, then plainly the thing to press */}
        <Button type="submit" variant={pasted ? "brand" : "secondary"} disabled={busy || !pasted}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {t("remoteSection.addServer")}
        </Button>
      </form>
      {error && (
        <div role="alert" className="mt-2 text-small text-warning">
          {error}
        </div>
      )}
      <details className="group mt-2.5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-small text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} className="transition-transform duration-150 group-open:rotate-90" />
          {t("remoteSection.how")}
        </summary>
        <p className="mt-1.5 max-w-[60ch] pl-4 text-pretty text-small leading-relaxed text-muted-foreground">
          {tr("remoteSection.howSteps", {
            server: <Code>bloks-server</Code>,
            command: <Code>bloks-server pair</Code>,
            computer: thisComputer(),
          })}
        </p>
      </details>
      <label className="mt-4 flex items-start gap-3 border-t pt-4">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui font-medium text-foreground">{t("remoteSection.runHere", { computer: thisComputer() })}</span>
          <span className="text-pretty text-small text-muted-foreground">
            {local ? t("remoteSection.runHereOn") : t("remoteSection.runHereOff", { computer: thisComputer() })}
          </span>
        </span>
        <Switch
          checked={local}
          // somewhere else to open has to be there before nothing runs here
          disabled={local && servers.length === 0}
          onCheckedChange={(on) => void setLocal(on)}
          aria-label={t("remoteSection.runHere", { computer: thisComputer() })}
        />
      </label>
    </div>
  );
}
