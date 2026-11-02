// Inviting one person: a QR, a code and a link that are all the same
// single invite (design: Mac-Invite).
//
// The invite is made as the sheet opens, so the code is there to read out
// the moment it appears; who it is for and their role can still change
// until somebody uses it. Closing with Done keeps it; Cancel invite ends
// it. The QR carries the link, with the workspace's mark in its middle,
// at the error correction that leaves the code readable under the mark.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Lock, Upload, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { membersApi, whenWords, type Invite, type Workspace, type WorkspaceRole } from "@/lib/members";
import { needsName } from "@/lib/yourName";
import { askYourName } from "@/components/YourNameDialog";
import { WorkspaceMark } from "@/components/WorkspaceMark";
import { t, type MessageKey } from "@/lib/i18n";

const ROLE_LINE: Record<WorkspaceRole, MessageKey> = {
  member: "inviteSheet.roleLine.member",
  admin: "inviteSheet.roleLine.admin",
};

/** The QR as one SVG path: a module per dark cell, high error correction
 * so the mark in the middle hides nothing the code needs. */
function qrPath(text: string): { d: string; size: number } | null {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: "H" });
    const size = qr.modules.size;
    let d = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    }
    return { d, size };
  } catch {
    return null;
  }
}

/** "Copied" for a moment after a copy, then back: quiet feedback where
 * the press was, nothing anywhere else. */
function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1600);
    });
  }, []);
  return [copied, copy];
}

function CopyButton({ copied, onClick, copies, className }: { copied: boolean; onClick: () => void; copies: "code" | "link"; className?: string }) {
  const label = copies === "code" ? (copied ? t("inviteSheet.codeCopied") : t("inviteSheet.copyCode")) : copied ? t("inviteSheet.linkCopied") : t("inviteSheet.copyLink");
  return (
    <Button variant="secondary" size="sm" onClick={onClick} aria-label={label} className={cn("min-w-[78px]", className)}>
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      <span aria-live="polite">{copied ? t("common.copied") : t("common.copy")}</span>
    </Button>
  );
}

export function InviteSheet({
  open,
  onOpenChange,
  workspace,
  passwordSet,
  approveEach,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  passwordSet: boolean;
  approveEach: boolean;
  /** Something about the invitations list changed. */
  onChanged?: () => void;
}) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [online, setOnline] = useState<{ available: boolean; why?: string } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopied();
  const making = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // made as the sheet opens, once per opening
  useEffect(() => {
    if (!open) {
      setInvite(null);
      setName("");
      setRole("member");
      setError(null);
      making.current = false;
      return;
    }
    if (making.current) return;
    making.current = true;
    // An invite says who it is from, so the first one waits for the
    // owner's name: asked right here, then made. Not now closes the sheet.
    membersApi
      .invite({ role: "member" })
      .catch(async (e: Error) => {
        if (!needsName(e)) throw e;
        if (!(await askYourName({ why: t("inviteSheet.nameWhy", { name: workspace.name }) }))) {
          onOpenChange(false);
          return null;
        }
        return membersApi.invite({ role: "member" });
      })
      .then((made) => {
        if (!made) return;
        setInvite(made.invite);
        setOnline(made.online);
        onChanged?.();
      })
      .catch((e: Error) => setError(e.message));
  }, [open, onChanged]);

  // who it is for, saved a moment after typing stops
  useEffect(() => {
    if (!invite) return;
    const wanted = name.trim();
    if (wanted === (invite.name ?? "")) return;
    const timer = setTimeout(() => {
      membersApi
        .updateInvite(invite.id, { name: wanted })
        .then((b) => setInvite(b.invite))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [name, invite]);

  const changeRole = (next: WorkspaceRole) => {
    setRole(next);
    if (!invite) return;
    membersApi
      .updateInvite(invite.id, { role: next })
      .then((b) => {
        setInvite(b.invite);
        onChanged?.();
      })
      .catch((e: Error) => setError(e.message));
  };

  const cancelInvite = async () => {
    if (!invite) return onOpenChange(false);
    await membersApi.cancel(invite.id).catch(() => {});
    onChanged?.();
    onOpenChange(false);
  };

  // a server opened in browsers at its own address hands out that address,
  // where the invite is used by signing in; the code works in the apps too
  const link = invite ? (invite.webLink ?? invite.link) : "";

  const share = async () => {
    if (!invite) return;
    const shared = await window.bloks?.shareLink?.(link).catch(() => false);
    if (!shared) copy("link", link);
  };

  const qr = useMemo(() => (link ? qrPath(link) : null), [link]);
  const named = name.trim();
  const [first, second] = invite ? invite.code.split("-") : ["", ""];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100%-2rem)] max-w-[640px] p-0"
        aria-describedby={undefined}
        // straight into who it is for: the one thing worth typing here
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-3 px-[22px] pb-1.5 pt-5">
          <WorkspaceMark mark={workspace.mark} size={28} />
          <DialogTitle className="flex-1 text-balance">{t("inviteSheet.title", { name: workspace.name })}</DialogTitle>
          <Button variant="ghost" size="icon-sm" aria-label={t("common.close")} onClick={() => onOpenChange(false)}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex items-end gap-3.5 px-[22px] pb-1 pt-3.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-small text-muted-foreground">
            {t("inviteSheet.whoIsItFor")}
            <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("inviteSheet.aNameForYou")} maxLength={40} autoComplete="off" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-small text-muted-foreground">{t("inviteSheet.joinsAs")}</span>
            <Segmented
              aria-label={t("inviteSheet.role")}
              value={role}
              onChange={changeRole}
              className="h-9"
              options={[
                { value: "member", label: t("inviteSheet.member") },
                { value: "admin", label: t("inviteSheet.admin") },
              ]}
            />
          </div>
        </div>
        <DialogDescription className="mt-0 px-[22px] pt-2 text-small">{t(ROLE_LINE[role])}</DialogDescription>

        <div className="mx-[22px] mt-[18px] flex gap-[26px] rounded-2xl border bg-muted/50 p-[22px] max-sm:flex-col max-sm:items-center">
          <div className="flex flex-col items-center gap-2.5">
            <div className="relative grid size-[196px] place-items-center rounded-[14px] bg-white">
              {qr ? (
                <svg width="172" height="172" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label={t("inviteSheet.qrCodeForThisInvite")}>
                  <path d={qr.d} fill="#0b0c0e" />
                </svg>
              ) : (
                <div className="size-[172px] animate-pulse rounded-lg bg-black/5" aria-label={t("inviteSheet.makingTheInvite")} />
              )}
              {qr && (
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[11px] shadow-[0_0_0_4px_#fff]">
                  <WorkspaceMark mark={workspace.mark} size={40} />
                </span>
              )}
            </div>
            <span className="text-small text-muted-foreground">{t("inviteSheet.scanWithTheIphoneCamera")}</span>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-[18px] self-stretch">
            <div className="flex flex-col gap-2">
              <span className="text-small text-muted-foreground">{t("inviteSheet.code")}</span>
              <div className="flex items-center gap-2.5">
                <span className="select-all font-mono text-[30px] font-semibold leading-none tracking-[0.08em] text-foreground tabular-nums" aria-label={invite ? t("inviteSheet.codeSpelled", { code: invite.code.split("").join(" ") }) : undefined}>
                  {invite ? (
                    <>
                      {first}
                      <span className="px-0.5 text-muted-foreground/60">-</span>
                      {second}
                    </>
                  ) : (
                    <span className="inline-block h-[30px] w-[200px] animate-pulse rounded-md bg-muted" />
                  )}
                </span>
                <CopyButton className="ml-auto" copied={copied === "code"} copies="code" onClick={() => invite && copy("code", invite.code)} />
              </div>
              <span className="text-small text-muted-foreground">{t("inviteSheet.easyToReadOutNo")}</span>
            </div>
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-2">
              <span className="text-small text-muted-foreground">{t("inviteSheet.link")}</span>
              <div className="flex items-center gap-2">
                <span className="flex h-[34px] min-w-0 flex-1 items-center truncate rounded-lg border bg-background px-3 font-mono text-body text-foreground/80">
                  {link.replace(/^https:\/\//, "")}
                </span>
                <CopyButton copied={copied === "link"} copies="link" onClick={() => invite && copy("link", link)} />
                <Button size="sm" onClick={() => void share()} disabled={!invite} className="h-[34px]">
                  <Upload size={14} />
                  {t("inviteSheet.share")}
                </Button>
              </div>
              <span className="text-small text-muted-foreground">
                {invite?.webLink
                  ? t("inviteSheet.opensAtWeb", { host: new URL(invite.webLink).host })
                  : online && !online.available
                    ? online.why
                    : t("inviteSheet.showsAsAnInviteCard")}
              </span>
            </div>
          </div>
        </div>

        {passwordSet && (
          <div className="mx-[22px] mt-3.5 flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3">
            <Lock size={18} className="shrink-0 text-warning" />
            <span className="flex-1 text-pretty text-body leading-relaxed text-foreground/85">
              {named ? t("inviteSheet.password.named", { name: named }) : t("inviteSheet.password.they")}
            </span>
          </div>
        )}

        {error && (
          <p role="alert" className="mx-[22px] mt-3 text-body text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 px-[22px] pb-5 pt-[18px]">
          <span className="flex-1 text-pretty text-small text-muted-foreground">
            {invite
              ? `${t("inviteSheet.worksOnce", { when: whenWords(invite.expiresAt) })} ${
                  approveEach
                    ? named
                      ? t("inviteSheet.approve.named", { name: named })
                      : t("inviteSheet.approve.them")
                    : passwordSet
                      ? named
                        ? t("inviteSheet.straightIn.passwordNamed", { name: named })
                        : t("inviteSheet.straightIn.passwordThem")
                      : named
                        ? t("inviteSheet.straightIn.named", { name: named })
                        : t("inviteSheet.straightIn.them")
                }`
              : t("inviteSheet.makingTheInviteDots")}
          </span>
          <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void cancelInvite()}>
            {t("inviteSheet.cancelInvite")}
          </Button>
          <Button size="lg" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
