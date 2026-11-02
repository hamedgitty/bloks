// The page a server's web door shows before anybody is in (server/web-door.ts):
// signing in with the household's or the team's own identity provider,
// and joining from an invite link with nothing but a browser.
//
// One card, centred, on the app's own background, with the workspace's
// mark at the top so it is plain whose door this is. Joining reads like
// the app's own Join dialog (src/components/members/JoinWorkspaceDialog.tsx):
// the invite found, then the same four words the owner sees, and every
// way it can end said in the same words.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, Hourglass, Loader2, LogIn, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { cn } from "@/lib/cn";
import { formatList, t } from "@/lib/i18n";
import { codeIn, whenWords } from "@/lib/members";
import { signIn, signInProblem, webJoinApi, type DoorInvite, type DoorProblem, type WebDoorSession } from "@/lib/webDoor";

const POLL_MS = 2_500;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The ?signin= or ?error= the door sent the browser back with, read
 * once and then taken off the address, so a reload does not say it again. */
function takeParam(name: string): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value === null) return null;
  url.searchParams.delete(name);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return value;
}

function Shell({ session, children }: { session: WebDoorSession; children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-[420px] animate-rise-in flex-col gap-6 rounded-2xl border bg-card p-7 shadow-[0_1px_2px_rgb(0_0_0/0.04)] max-sm:p-5">
        <WorkspaceMark mark={session.workspace.mark} size={44} label={session.workspace.name} />
        {children}
      </div>
    </main>
  );
}

function Problem({ text, note }: { text: string; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5" role="alert">
      <span className="text-pretty text-body text-destructive">{text}</span>
      {note && <span className="text-pretty text-small text-muted-foreground">{note}</span>}
    </div>
  );
}

export function WebDoor({ session }: { session: WebDoorSession }) {
  return window.location.pathname === "/join" ? <JoinPage session={session} /> : <SignInPage session={session} />;
}

function SignInPage({ session }: { session: WebDoorSession }) {
  const [problem, setProblem] = useState<string | null>(() => signInProblem(takeParam("signin"), session));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    const said = await signIn({ next: `${window.location.pathname}${window.location.search}` });
    if (said) {
      setBusy(false);
      setProblem(signInProblem(said.code ?? "failed", session));
    }
  };
  return (
    <Shell session={session}>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-balance text-heading font-bold text-foreground">{t("webDoor.signInTo", { workspace: session.workspace.name })}</h1>
        <p className="text-pretty text-body leading-relaxed text-muted-foreground">{t("webDoor.whose", { owner: firstName(session.owner) })}</p>
      </div>
      {problem && <Problem text={problem} />}
      <Button size="lg" className="h-11 w-full" disabled={busy} onClick={() => void go()} autoFocus>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
        {t("webDoor.signInWith", { provider: session.provider })}
      </Button>
      <p className="text-pretty text-small text-muted-foreground">{t("webDoor.newHere", { owner: firstName(session.owner) })}</p>
    </Shell>
  );
}

type JoinStage =
  | { kind: "enter" }
  | { kind: "found"; code: string; invite: DoorInvite }
  | { kind: "waiting"; phrase: string; inviter: string }
  | { kind: "ended"; code: string; inviter: string | null };

/** What an invite that cannot be used says, in the Join dialog's words. */
function endedWords(code: string, inviter: string | null, workspace: string): { title: string; body: string } {
  const who = { name: inviter ?? "" };
  const named = inviter !== null;
  const pick = (key: "expired" | "cancelled" | "used" | "closed") => ({
    title: t(`membersJoinWorkspaceDialog.ended.${key}.title`),
    body: named ? t(`membersJoinWorkspaceDialog.ended.${key}.body`, who) : t(`membersJoinWorkspaceDialog.ended.${key}.bodyAnyone`),
  });
  switch (code) {
    case "expired":
    case "cancelled":
    case "used":
    case "closed":
      return pick(code);
    case "declined":
      return {
        title: named ? t("membersJoinWorkspaceDialog.ended.declined.title", who) : t("membersJoinWorkspaceDialog.ended.declined.titleAnyone"),
        body: named ? t("membersJoinWorkspaceDialog.ended.declined.body", who) : t("membersJoinWorkspaceDialog.ended.declined.bodyAnyone"),
      };
    case "already_member":
      return { title: t("membersJoinWorkspaceDialog.ended.already.title", { workspace }), body: t("membersJoinWorkspaceDialog.ended.already.body") };
    case "full":
      return { title: t("membersJoinWorkspaceDialog.ended.full.title", { workspace }), body: t("webDoor.problem.full", { workspace, owner: inviter ?? "" }) };
    case "not_allowed":
      return { title: t("membersJoinWorkspaceDialog.ended.other.title"), body: t("webDoor.problem.notAllowed", { workspace, owner: inviter ?? "" }) };
    default:
      return { title: t("membersJoinWorkspaceDialog.ended.other.title"), body: t("webDoor.join.tryAgain") };
  }
}

function JoinPage({ session }: { session: WebDoorSession }) {
  const owner = firstName(session.owner);
  // what the door sent the browser back with, if anything: a password to
  // type again keeps the invite, anything else ends it
  const [back] = useState(() => takeParam("signin") ?? takeParam("error"));
  const retype = back === "wrong_password" || back === "password_required";
  const [stage, setStage] = useState<JoinStage>(() => {
    if (session.waiting) return { kind: "waiting", phrase: session.waiting.phrase, inviter: firstName(session.waiting.about?.inviter ?? session.owner) };
    if (back && !retype) return { kind: "ended", code: back === "denied" || back === "failed" || back === "expired" ? `signin:${back}` : back, inviter: null };
    return { kind: "enter" };
  });
  const [input, setInput] = useState(() => codeIn(window.location.hash.slice(1)) ?? "");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<{ field: "code" | "password" | "form"; text: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const failed = useCallback(
    (said: DoorProblem, inviter: string | null) => {
      const host = inviter ?? owner;
      if (said.code === "wrong_code") return setProblem({ field: "code", text: t("membersJoinWorkspaceDialog.problem.wrongCode"), note: t("membersJoinWorkspaceDialog.problem.wrongCodeNote") });
      if (said.code === "password_required") return setProblem({ field: "password", text: t("membersJoinWorkspaceDialog.problem.passwordRequired", { workspace: session.workspace.name, host }) });
      if (said.code === "wrong_password") return setProblem({ field: "password", text: t("membersJoinWorkspaceDialog.problem.wrongPassword", { host, count: said.triesLeft ?? 0 }), note: t("membersJoinWorkspaceDialog.problem.wrongPasswordNote", { host }) });
      if (said.code === "rate_limited" || said.code === "provider" || said.code === "offline") return setProblem({ field: "form", text: signInProblem(said.code, session)! });
      setStage({ kind: "ended", code: said.code ?? "failed", inviter });
    },
    [owner, session],
  );

  const lookup = useCallback(
    async (raw: string) => {
      const code = codeIn(raw);
      if (!code) return setProblem({ field: "code", text: t("membersJoinWorkspaceDialog.problem.wrongCode") });
      setBusy(true);
      setProblem(null);
      const said = await webJoinApi.lookup(code);
      setBusy(false);
      if (said.status === 200 && said.body.preview) {
        setStage({ kind: "found", code, invite: said.body.preview });
        return said.body.preview;
      }
      failed(said.body, said.body.host ? firstName(said.body.host) : null);
    },
    [failed],
  );

  // the code came in the link: look it up straight away
  const fromLink = useMemo(() => codeIn(window.location.hash.slice(1)), []);
  useEffect(() => {
    if (!fromLink || stage.kind !== "enter") return;
    void lookup(fromLink).then((found) => {
      if (found && retype) setProblem({ field: "password", text: t("webDoor.join.wrongPassword", { host: firstName(found.inviter) }) });
    });
    // once, for the link the page was opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // waiting: ask now and then whether the owner has answered
  useEffect(() => {
    if (stage.kind !== "waiting") return;
    let alive = true;
    const timer = setInterval(async () => {
      const said = await webJoinApi.status();
      if (!alive) return;
      if (said.status === 200 && said.body.status === "approved") {
        window.location.replace("/");
        return;
      }
      if (said.status === 200 || said.status === 0) return;
      setStage({ kind: "ended", code: said.body.code ?? "failed", inviter: stage.inviter });
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [stage]);

  const proceed = async () => {
    if (stage.kind !== "found") return;
    setBusy(true);
    setProblem(null);
    const said = await signIn({ next: "/", join: { code: stage.code, ...(password ? { password } : {}) } });
    if (said) {
      setBusy(false);
      failed(said, firstName(stage.invite.inviter));
    }
  };

  const cancel = async () => {
    await webJoinApi.cancel();
    window.location.replace("/join");
  };

  if (stage.kind === "waiting") {
    const words = stage.phrase.split(" ");
    return (
      <Shell session={session}>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-balance text-heading font-bold text-foreground">{t("membersJoinWorkspaceDialog.waitingFor", { name: stage.inviter })}</h1>
          <p className="text-pretty text-body leading-relaxed text-muted-foreground">{t("membersJoinWorkspaceDialog.waiting.description", { name: stage.inviter })}</p>
        </div>
        <div role="group" aria-label={t("membersJoinWorkspaceDialog.checkWords", { words: formatList(words, { type: "unit", style: "short" }) })} className="grid grid-cols-2 gap-2.5">
          {words.map((word, i) => (
            <div key={i} className="flex animate-rise-in flex-col gap-0.5 rounded-xl border bg-muted/50 px-3.5 py-3" style={{ animationDelay: `${i * 50}ms`, animationFillMode: "backwards" }}>
              <span className="text-caption font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="truncate text-[20px] font-bold leading-tight text-foreground">{word}</span>
            </div>
          ))}
        </div>
        <div role="status" className="flex items-center gap-2.5 text-pretty text-body text-muted-foreground">
          <span className="size-2 shrink-0 rounded-full motion-safe:animate-pulse" style={{ background: session.workspace.mark.color }} />
          {t("webDoor.join.waiting", { name: stage.inviter })}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-pretty text-small text-muted-foreground">{t("webDoor.join.leaveOpen")}</span>
          <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void cancel()}>
            {t("membersJoinWorkspaceDialog.cancelRequest")}
          </Button>
        </div>
      </Shell>
    );
  }

  if (stage.kind === "ended") {
    const signin = stage.code.startsWith("signin:") ? stage.code.slice(7) : null;
    const said = signin ? { title: t("membersJoinWorkspaceDialog.ended.other.title"), body: signInProblem(signin, session)! } : endedWords(stage.code, stage.inviter, session.workspace.name);
    return (
      <Shell session={session}>
        <div className="flex flex-col gap-3">
          <span className="grid size-11 place-items-center rounded-[14px] bg-muted text-muted-foreground" aria-hidden>
            {stage.code === "expired" ? <Hourglass size={22} /> : stage.code === "already_member" ? <Check size={22} /> : stage.code === "full" ? <Users size={22} /> : <Ban size={22} />}
          </span>
          <h1 className="text-balance text-heading font-bold text-foreground">{said.title}</h1>
          <p className="text-pretty text-body leading-relaxed text-muted-foreground">{said.body}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <Button variant="ghost" onClick={() => window.location.replace("/")}>
            {t("webDoor.join.toSignIn")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setStage({ kind: "enter" });
              setInput("");
              window.history.replaceState(null, "", "/join");
            }}
          >
            {t("membersJoinWorkspaceDialog.tryAnotherCode")}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell session={session}>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-balance text-heading font-bold text-foreground">{t("webDoor.join.title", { workspace: session.workspace.name })}</h1>
        <p className="text-pretty text-body leading-relaxed text-muted-foreground">
          {stage.kind === "found" ? t("webDoor.join.howItWorks", { provider: session.provider, name: firstName(stage.invite.inviter) }) : t("membersJoinWorkspaceDialog.pasteTheInviteLinkOr")}
        </p>
      </div>

      {stage.kind === "enter" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(input);
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-small text-muted-foreground">{t("membersJoinWorkspaceDialog.inviteLinkOrCode")}</span>
            <Input
              autoFocus
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setProblem(null);
              }}
              placeholder={t("webDoor.join.codeExample")}
              spellCheck={false}
              autoCapitalize="characters"
              aria-invalid={problem?.field === "code"}
              className={cn("h-[42px] font-mono font-semibold tracking-wide", problem?.field === "code" && "border-destructive focus-visible:border-destructive")}
            />
          </label>
          {problem && <Problem text={problem.text} note={problem.note} />}
          <Button type="submit" size="lg" className="h-11 w-full" disabled={busy || !input.trim()}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? t("membersJoinWorkspaceDialog.lookingItUp") : t("webDoor.join.find")}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void proceed();
          }}
        >
          <div className="flex animate-rise-in items-center gap-3.5 rounded-[14px] border bg-muted/50 p-3.5">
            <WorkspaceMark mark={stage.invite.mark} size={36} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] font-semibold text-foreground">{stage.invite.workspace}</span>
              <span className="text-pretty text-body text-muted-foreground">
                {stage.invite.expiresAt
                  ? t(stage.invite.role === "admin" ? "membersJoinWorkspaceDialog.found.adminExpires" : "membersJoinWorkspaceDialog.found.memberExpires", { name: firstName(stage.invite.inviter), when: whenWords(stage.invite.expiresAt) })
                  : t(stage.invite.role === "admin" ? "membersJoinWorkspaceDialog.found.admin" : "membersJoinWorkspaceDialog.found.member", { name: firstName(stage.invite.inviter) })}
              </span>
            </div>
            <Check size={18} className="shrink-0 text-success" aria-label={t("membersJoinWorkspaceDialog.inviteFound")} />
          </div>
          {stage.invite.password && (
            <label className="flex flex-col gap-1.5">
              <span className={cn("text-small", problem?.field === "password" ? "text-destructive" : "text-muted-foreground")}>{t("membersJoinWorkspaceDialog.joinPassword")}</span>
              <Input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (problem?.field === "password") setProblem(null);
                }}
                autoComplete="off"
                aria-invalid={problem?.field === "password"}
                className={cn("h-10 tracking-[0.12em]", problem?.field === "password" && "border-destructive")}
              />
            </label>
          )}
          {problem && <Problem text={problem.text} note={problem.note} />}
          <Button type="submit" size="lg" className="h-11 w-full" disabled={busy || (stage.invite.password && !password)}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            {t("webDoor.join.continue", { provider: session.provider })}
          </Button>
        </form>
      )}
    </Shell>
  );
}
