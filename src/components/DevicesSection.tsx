// Pairing phones, without typing.
//
// Turning pairing on opens the server to the local network; a pairing
// window mints a six digit code and a QR that carries a high-entropy
// token. The QR replaces typing, never consent: the phone still shows
// what it scanned and waits for a tap. Codes last minutes, work once,
// and a handful of wrong guesses closes the window (server/pairing.ts).
//
// The card is two things. For someone who has never paired a phone it is
// a short onboarding: what pairing gives them, the three steps, and one
// button. For someone who has, it is their phones, the switch, and Pair
// another phone. Either way no code exists until somebody asks for one,
// and the one they get lives only as long as they are looking at it: it
// renews itself quietly while the panel is open and visible, and is
// closed on the server the moment the panel closes, the window hides or
// the page goes. A code the server closed early, which is what wrong
// guesses do, is not replaced until somebody asks again.
//
// A phone arriving is the end of the flow, so it gets a moment of its own
// before it joins the list, and the card becomes the list.
//
// The window can be on another computer than the workspace, a server with
// no screen among them (GitHub 403). Then the card names the computer the
// phones reach, the QR still sends them there and never here, and a server
// that answers nothing on its network (bloks-server) pairs with a link
// through Bloks Cloud instead of a code no phone could trade in. Turning
// phone access off stays with that computer, which the card says rather
// than offering a switch that would cut this window off.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check } from "@/components/icons";
import { Copy } from "@/components/icons";
import { Globe } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { RotateCw } from "@/components/icons";
import { Smartphone } from "@/components/icons";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { deviceLabels } from "@/lib/deviceLabels";
import { usePageVisible } from "@/lib/pageVisible";
import { cloudOnly, isOverlayAddress, pairingAway, pairingTrouble, pairLink } from "@/lib/pairing";
import { ThisComputer, thisComputer } from "@/lib/thisComputer";
import { ConnectionError, ConnectionHeader, ConnectionNote, HealthLine, PairedMoment, type Health } from "./ConnectionKit";
import { t } from "@/lib/i18n";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(pairingTrouble(res.status, body.error, `${res.status} ${res.statusText}`));
  return body;
}

interface Device {
  id: string;
  name: string;
  pairedAt: number;
  /** When it last made a request, since this computer started. */
  lastSeen?: number;
  /** The app build the device last said it runs, once it has made a
   * request since this Mac started. */
  client?: string;
}

interface PairStatus {
  enabled: boolean;
  pending: boolean;
  /** The switch and what the server is actually listening on disagree,
   * because listening is decided at start. Until a restart, a phone on
   * the network cannot reach this machine whatever the switch says. */
  restartRequired?: boolean;
  addresses: string[];
  devices: Device[];
  /** What the server listens on: loopback with no restart pending is a
   * server only Bloks Cloud reaches. */
  listening?: "loopback" | "network";
  /** The computer the phones reach, and whether it is this one. */
  computer?: string;
  here?: boolean;
  /** This window's own device, when it is one of the paired ones. */
  thisDevice?: string;
}

/** The code on screen: what the server minted, drawn. */
interface PairCode {
  code: string;
  qr: string | null;
  /** What the QR carries, which the desktop app takes pasted (Settings,
   * Phone and devices, Your servers), the link `bloks-server pair` prints. */
  link?: string | null;
  expiresAt: number;
  /** Where the phone should dial, for somebody typing the code by hand. */
  address: string | null;
  /** Every address of this computer a phone could dial, and the one the
   * QR carries: a Tailscale address and a wifi one are both offered, and
   * the person picks which network the phone will come over. */
  addresses: string[];
  chosen: string | null;
  /** When it arrived here, so a status read that left before it did is
   * not taken as news about it. */
  mintedAt: number;
}

/** What the server minted, kept so the QR can be drawn again for another
 * of this computer's addresses without spending a new code. */
interface Minted {
  token: string;
  code: string;
  port: number;
  name?: string;
  /** A server reached at addresses of its owner's own (server/self-host.ts)
   * says the link for each, since only it knows how each is written. */
  links?: Array<{ url: string; link: string }>;
}

/** An address that is a whole URL: one its owner gave a server, rather
 * than one of this computer's own on its network. */
const isUrl = (address: string) => /^https?:\/\//.test(address);

async function drawCode(minted: Minted, address: string | null): Promise<{ qr: string | null; hostPort: string | null; link: string | null }> {
  const link = !address
    ? null
    : isUrl(address)
      ? (minted.links?.find((l) => l.url === address)?.link ?? null)
      : pairLink(address, minted.port, minted.token, minted.code, minted.name);
  const qr = link
    ? await QRCode.toDataURL(link, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 288,
        color: { dark: "#111111", light: "#ffffff" },
      }).catch(() => null)
    : null;
  // A bracketed IPv6 literal stays readable as host:port; IPv4 needs nothing;
  // a URL is already what to type.
  const hostPort = !address ? null : isUrl(address) ? address : `${address.includes(":") ? `[${address}]` : address}:${minted.port}`;
  return { qr, hostPort, link };
}

/** A browser rather than a phone, by the name it paired under. */
const isBrowser = (name: string) => /\b(Chrome|Safari|Firefox|Edge|browser)\b/i.test(name);

/** How long a new phone holds the stage before it joins the list. */
const ARRIVAL_MS = 2800;

/** How far ahead of its expiry a code is replaced, so the new one is on
 * screen before the old one stops working. */
const RENEW_EARLY_MS = 1500;

export function DevicesSection() {
  // Running at bloks.dev/web: this UI is itself a paired device, said
  // first, and one of the owner's own, which may pair another (a server
  // with no screen has no other place to do it), as the desktop app
  // reaching a server does.
  if (window.bloksWeb) {
    return (
      <>
        <ThisBrowser />
        <PairingControls />
      </>
    );
  }
  return <PairingControls />;
}

function ThisBrowser() {
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="mb-9 rounded-2xl border bg-card p-5 last:mb-0">
      <ConnectionHeader
        icon={<Globe size={14} className="shrink-0 text-muted-foreground" />}
        title={t("devicesSection.thisBrowser")}
        says={
          window.bloksWeb?.host
            ? t("devicesSection.connectedToHost", { host: window.bloksWeb.host })
            : t("devicesSection.connectedToYourComputer")
        }
        health={<HealthLine tone="on" label={t("common.connected")} />}
      />
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        disabled={leaving}
        onClick={() => {
          setLeaving(true);
          void window.bloksWeb?.forget();
        }}
      >
        {leaving ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
        {t("devicesSection.disconnectThisBrowser")}
      </Button>
    </div>
  );
}

function PairLinkRow({
  label,
  link,
  copied,
  onCopy,
}: {
  label: string;
  link: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-2.5">
      <div className="text-small text-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 font-mono text-small text-muted-foreground">
          {link}
        </code>
        <Button size="sm" variant="secondary" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
    </div>
  );
}

/** The phones and browsers that can reach this computer, each with what
 * tells it apart, and a quiet Remove that asks first: a removed phone has
 * to pair again from scratch. */
function PairedList({
  devices,
  now,
  fresh,
  place,
  self,
  onRemove,
}: {
  devices: Device[];
  now: number;
  fresh: string | null;
  /** The computer they reach, as a sentence says it. */
  place: string;
  /** The device this window is, which is removed from another one. */
  self?: string;
  onRemove: (device: Device) => void;
}) {
  const labels = deviceLabels(devices, now);
  return (
    <ul aria-label={t("devicesSection.paired")} className="mt-4 flex flex-col border-t pt-2">
      {devices.map((device) => {
        const label = labels.get(device.id) ?? { name: device.name, detail: "" };
        return (
          <li
            key={device.id}
            className={cn(
              "-mx-1.5 flex items-center gap-3 rounded-lg px-1.5 py-2 transition-colors duration-700",
              fresh === device.id && "bg-brand-soft",
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {isBrowser(device.name) ? <Globe size={15} /> : <Smartphone size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium text-foreground">{label.name}</div>
              {label.detail && <div className="truncate text-small tabular-nums text-muted-foreground">{label.detail}</div>}
            </div>
            {device.id === self ? (
              <span className="shrink-0 px-2 text-small text-muted-foreground">{ThisComputer()}</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("devicesSection.removeDevice", { name: label.name })}
                className="hover:bg-destructive/10 hover:text-destructive"
                onClick={async () => {
                  const yes = await confirm({
                    title: t("devicesSection.removeDeviceTitle", { name: label.name }),
                    body: t("devicesSection.removeDeviceBody", { place }),
                    confirmLabel: t("common.remove"),
                    destructive: true,
                  });
                  if (yes) onRemove(device);
                }}
              >
                {t("common.remove")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One of the three steps in the onboarding: a number, or a tick once the
 * server says it is done, and the words. */
function OnboardingStep({ n, done, children, control }: { n: number; done?: boolean; children: React.ReactNode; control?: React.ReactNode }) {
  return (
    <li className="flex min-h-8 items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-small font-medium tabular-nums",
          done ? "bg-success/15 text-success" : "border text-muted-foreground",
        )}
      >
        {done ? <Check size={12} strokeWidth={3} /> : n}
      </span>
      <span className="min-w-0 flex-1 text-pretty text-body text-foreground">
        {children}
        {done && <span className="sr-only"> {t("devicesSection.done")}</span>}
      </span>
      {control}
    </li>
  );
}

function PairingControls() {
  const [status, setStatus] = useState<PairStatus | null>(null);
  /** Somebody asked to pair a phone, and the code panel is open. */
  const [flow, setFlow] = useState(false);
  const [code, setCode] = useState<PairCode | null>(null);
  /** No code on screen, and none asked for until somebody says so: the
   * server closed the last one early, or could not make one. */
  const [stopped, setStopped] = useState<"closed" | "failed" | null>(null);
  const [browserLink, setBrowserLink] = useState<{ web: string; pair: string; expiresAt: number; qr: string | null } | null>(null);
  const [copied, setCopied] = useState<"web" | "pair" | null>(null);
  /** The last link asked for could not be made. */
  const [linkFailed, setLinkFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  /** The phone that just paired, holding the stage for a moment. */
  const [arrived, setArrived] = useState<Device | null>(null);
  /** And its row in the list, lit for a little longer after that. */
  const [fresh, setFresh] = useState<string | null>(null);
  const inflight = useRef(false);
  // Every device seen so far, so a new one can be told from an old one.
  // Unset until the first answer: the phones already paired when the
  // screen opens are not arrivals.
  const known = useRef<Set<string> | null>(null);
  // The code as the async paths see it, without waiting for a render.
  const held = useRef<PairCode | null>(null);
  const minting = useRef(false);
  /** Whether a code belongs on screen right now. A code that arrives
   * after this went false is closed at once rather than shown. */
  const wanted = useRef(false);
  const linking = useRef(false);

  const hold = useCallback((next: PairCode | null) => {
    held.current = next;
    setCode(next);
  }, []);

  const load = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    const asked = Date.now();
    api("/api/pair")
      .then((s: PairStatus) => {
        setStatus(s);
        setError(null);
        const ids = new Set(s.devices.map((d) => d.id));
        const newcomer = known.current ? s.devices.find((d) => !known.current!.has(d.id)) : undefined;
        known.current = ids;
        if (newcomer) {
          // the phone the flow was for has come: the flow is over
          setArrived(newcomer);
          setFresh(newcomer.id);
          setFlow(false);
        }
        // The window closed on the server while ours still had time on
        // it: used by the phone that just arrived, or closed by wrong
        // guesses, a restart, or another window asking for its own.
        const mine = held.current;
        if (!s.pending && mine && asked > mine.mintedAt && Date.now() < mine.expiresAt - RENEW_EARLY_MS) {
          hold(null);
          if (!newcomer) setStopped("closed");
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inflight.current = false;
      });
  }, [hold]);

  const minted = useRef<Minted | null>(null);
  // the address picked last, kept for the next code as long as it is
  // still one of this computer's
  const picked = useRef<string | null>(null);
  const mint = useCallback(() => {
    if (minting.current) return;
    minting.current = true;
    api("/api/pair/start", { method: "POST" })
      .then(async (started) => {
        const addresses = ((started.addresses as string[] | undefined) ?? []).filter((a: string) => a !== "127.0.0.1");
        const address = (picked.current && addresses.includes(picked.current) ? picked.current : addresses[0]) ?? started.addresses?.[0] ?? null;
        const made: Minted = {
          token: started.token,
          code: started.code,
          port: started.port,
          name: typeof started.name === "string" ? started.name : undefined,
          links: Array.isArray(started.links) ? started.links : undefined,
        };
        const { qr, hostPort, link } = await drawCode(made, address);
        if (!wanted.current) {
          // the panel closed while this was on its way: the door closes
          // with it rather than staying open for nobody
          void api("/api/pair/cancel", { method: "POST" }).catch(() => {});
          return;
        }
        minted.current = made;
        hold({ code: started.code, qr, link, expiresAt: started.expiresAt, address: hostPort, addresses, chosen: address, mintedAt: Date.now() });
        setStopped(null);
      })
      .catch((e: Error) => {
        setError(e.message);
        setStopped("failed");
      })
      .finally(() => {
        minting.current = false;
      });
  }, [hold]);

  const visible = usePageVisible();
  // While a code is out, somebody is standing there with a phone, so the
  // answer is looked for twice as often.
  const waiting = Boolean(code);
  useEffect(() => {
    if (!visible) return;
    load();
    const poll = setInterval(load, waiting ? 2_000 : 4_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, visible, waiting]);

  useEffect(() => {
    if (!arrived) return;
    const timer = setTimeout(() => setArrived(null), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, [arrived]);
  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(() => setFresh(null), ARRIVAL_MS + 1_600);
    return () => clearTimeout(timer);
  }, [fresh]);

  const listening = Boolean(status?.enabled && !status.restartRequired);
  // only Bloks Cloud reaches the workspace, so the panel is a link
  const viaCloud = cloudOnly(status);
  const want = flow && listening && visible && !arrived && !viaCloud;
  // the computer the phones reach, named when it is not this one
  const away = pairingAway(status);
  const place = away ?? thisComputer();
  // no switch on another computer: on is how this window got here, and
  // off from here would cut it off too, so the server keeps that for itself
  const offElsewhere = away
    ? t("devicesSection.offElsewhere", { away, computer: thisComputer() })
    : undefined;

  // The code lives exactly as long as this: the panel open, phone access
  // on, the page in view, and no phone mid-arrival. When any of that
  // stops, the window on the server is closed too.
  useEffect(() => {
    wanted.current = want;
    if (!want) return;
    return () => {
      wanted.current = false;
      if (held.current) {
        void api("/api/pair/cancel", { method: "POST" }).catch(() => {});
        hold(null);
      }
      setStopped(null);
    };
  }, [want, hold]);

  // Ask for one when the panel opens, and for the next one just before
  // this one runs out, unless the server closed the last one early.
  const msLeft = code ? code.expiresAt - now : 0;
  useEffect(() => {
    if (!want || stopped) return;
    if (!code || msLeft <= RENEW_EARLY_MS) mint();
  }, [want, stopped, code, msLeft, mint]);

  const setEnabled = (enabled: boolean) => {
    if (!enabled) setFlow(false);
    api("/api/pair", { method: "PUT", body: JSON.stringify({ enabled }) })
      .then(load)
      .catch((e: Error) => setError(e.message));
  };

  /** Pair a phone: phone access on if it is not, and the panel open. */
  const pairPhone = () => {
    setError(null);
    setStopped(null);
    if (!status?.enabled) setEnabled(true);
    setFlow(true);
  };

  // A link for Bloks in a browser: one use, fifteen minutes, through
  // Bloks Cloud. Shown here only, because the link is the whole key.
  // The server hands back the same pairing twice, once for a browser and
  // once for the Bloks app or another computer. Both are shown: keeping
  // only the browser one left people building the other by hand.
  // It is drawn as a QR too, for the iPhone's camera, which reads it the
  // way the Bloks app does: through Bloks Cloud to the computer the
  // workspace runs on, from any network, and never to this one.
  const makeBrowserLink = useCallback(() => {
    if (linking.current) return;
    linking.current = true;
    setError(null);
    setCopied(null);
    api("/api/pair/link", { method: "POST" })
      .then(async (made) => {
        const qr = await QRCode.toDataURL(made.link, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 288,
          color: { dark: "#111111", light: "#ffffff" },
        }).catch(() => null);
        setNow(Date.now());
        setBrowserLink({ web: made.webLink ?? made.link, pair: made.link, expiresAt: made.expiresAt, qr });
      })
      .catch((e: Error) => {
        setError(e.message);
        setLinkFailed(true);
      })
      .finally(() => {
        linking.current = false;
      });
  }, []);
  const browserSecondsLeft = browserLink ? Math.max(0, Math.round((browserLink.expiresAt - now) / 1000)) : 0;

  // Where a link is the only way in, opening the panel is asking for one.
  // One that could not be made is not asked for again until somebody does.
  const wantLink = flow && viaCloud && visible && !arrived;
  useEffect(() => {
    if (!wantLink) setLinkFailed(false);
  }, [wantLink]);
  useEffect(() => {
    if (wantLink && !browserLink && !linkFailed && !linking.current) {
      makeBrowserLink();
    }
  }, [wantLink, browserLink, linkFailed, makeBrowserLink]);

  // the link the cloud panel shows, while it still works
  const panelLink = viaCloud && browserLink && browserSecondsLeft > 0 ? browserLink : null;

  const devices = status?.devices ?? [];
  // Someone who has never paired a phone is shown how; someone who has
  // is shown their phones.
  const onboarding = Boolean(status) && devices.length === 0 && !arrived;

  const health: { tone: Health; label: string } | null = !status
    ? null
    : status.restartRequired
      ? { tone: "wait", label: t("devicesSection.restartNeeded") }
      : !status.enabled
        ? { tone: "off", label: t("common.off") }
        : code || (panelLink && flow)
          ? { tone: "wait", label: t("devicesSection.waiting") }
          : devices.length > 0
            ? { tone: "on", label: t("devicesSection.pairedCount", { count: devices.length }) }
            : { tone: "on", label: t("devicesSection.on") };

  // The switch alone does not open the door: the server decides what it
  // listens on when it starts. Without saying so, somebody turns this on
  // and watches their phone fail to connect for no reason they can see,
  // so the code waits for the restart. On another computer it is that
  // computer's Bloks to restart, which this app's own restart never is.
  const restart = status?.restartRequired ? (
    <ConnectionNote className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 flex-1">
        {away
          ? t("devicesSection.restartBloksOn", { away })
          : status.enabled
            ? t("devicesSection.restartBloksToFinishTurning")
            : t("devicesSection.restartBloksToStopListening")}
      </span>
      {away ? null : window.bloks?.relaunch ? (
        <Button size="sm" variant="secondary" onClick={() => void window.bloks?.relaunch?.()}>
          <RotateCw size={13} />
          {t("devicesSection.restartNow")}
        </Button>
      ) : (
        <span>{t("devicesSection.quitBloksAndOpenIt")}</span>
      )}
    </ConnectionNote>
  ) : null;

  const linkRows = (link: { web: string; pair: string }) => (
    <>
      <PairLinkRow
        label={t("devicesSection.openInABrowser")}
        link={link.web}
        copied={copied === "web"}
        onCopy={() => void navigator.clipboard.writeText(link.web).then(() => setCopied("web"))}
      />
      <PairLinkRow
        label={t("devicesSection.pasteIntoTheBloksApp")}
        link={link.pair}
        copied={copied === "pair"}
        onCopy={() => void navigator.clipboard.writeText(link.pair).then(() => setCopied("pair"))}
      />
    </>
  );

  // A code for a phone on the network the workspace answers on, with a
  // link beside it for one that is not; or, where only Bloks Cloud
  // reaches the workspace, the link alone.
  const panel = !(flow && listening && !arrived) ? null : viaCloud ? (
    <PairingLink
      link={panelLink}
      secondsLeft={browserSecondsLeft}
      failed={linkFailed}
      expired={Boolean(browserLink) && browserSecondsLeft === 0}
      place={place}
      rows={panelLink && linkRows(panelLink)}
      onAgain={() => {
        setLinkFailed(false);
        setBrowserLink(null);
      }}
      onClose={() => setFlow(false)}
    />
  ) : (
    <>
      <PairingCode
        code={code}
        onPick={(address) => {
          const made = minted.current;
          const shown = held.current;
          if (!made || !shown || shown.code !== made.code) return;
          picked.current = address;
          void drawCode(made, address).then(({ qr, hostPort, link }) => {
            if (held.current?.code !== made.code) return;
            hold({ ...held.current, qr, link, address: hostPort, chosen: address });
          });
        }}
        msLeft={msLeft}
        stopped={stopped}
        lead={
          away
            ? t("devicesSection.scanOnSameNetwork", { away })
            : onboarding
              ? t("devicesSection.scanThisCodeWithYour")
              : t("devicesSection.onYourIphoneOpenBloks")
        }
        onAgain={() => {
          setError(null);
          setStopped(null);
        }}
        onLink={makeBrowserLink}
        onClose={() => setFlow(false)}
      />
      {browserLink && browserSecondsLeft > 0 && (
        <div className="mt-3 rounded-xl border bg-muted/30 p-4" data-browser-link>
          <div className="text-body font-medium text-foreground">{t("devicesSection.pairWithALink")}</div>
          <div className="mt-0.5 text-small leading-relaxed text-muted-foreground">
            {t("devicesSection.linkWorksOnceKeepPrivate", { count: Math.ceil(browserSecondsLeft / 60) })}
          </div>
          {linkRows(browserLink)}
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setBrowserLink(null)}>
              {t("common.done")}
            </Button>
          </div>
        </div>
      )}
    </>
  );

  // An older server's refusal leaves nothing known about where the phones
  // reach, so the line says only that, and the error line the way on.
  const unanswered = !status && Boolean(error);
  const says = unanswered
    ? t("devicesSection.phonesPairWithWorkspaceComputer")
    : status && !status.enabled
      ? t("devicesSection.offCantReach", { place })
      : away
        ? viaCloud
          ? t("devicesSection.reachAwayViaCloud", { away })
          : t("devicesSection.reachAwayViaNetworkOrCloud", { away })
        : viaCloud
          ? t("devicesSection.reachHereViaCloud", { computer: thisComputer() })
          : t("devicesSection.reachHereViaNetwork", { computer: thisComputer() });

  // The words of the onboarding are the iPhone walkthrough's, word for
  // word, so the two screens read as one set of instructions.
  if (onboarding && status) {
    return (
      <div className="mb-9 rounded-2xl border bg-card p-5 last:mb-0" data-setting-row="phone-access">
        <ConnectionHeader
          icon={<Smartphone size={14} className="shrink-0 text-muted-foreground" />}
          title={t("devicesSection.pairYourIphone")}
          says={
            away
              ? t("devicesSection.talkToAgentsOn", { away })
              : t("devicesSection.talkToYourAgentsFrom")
          }
          info={offElsewhere}
          health={health && <HealthLine tone={health.tone} label={health.label} />}
          control={
            !away && (
              <Switch aria-label={t("devicesSection.phoneAccess")} checked={status.enabled} onCheckedChange={(on) => (on ? pairPhone() : setEnabled(false))} />
            )
          }
        />
        <ConnectionError>{error}</ConnectionError>
        <ol aria-label={t("devicesSection.pairAPhone")} className="mt-4 flex flex-col gap-2">
          <OnboardingStep n={1} done={flow && listening}>
            {t("devicesSection.pressPairAPhoneBelow")}
          </OnboardingStep>
          <OnboardingStep n={2}>{t("devicesSection.onYourIphoneOpenBloks")}</OnboardingStep>
          <OnboardingStep n={3}>{t("devicesSection.pointItAtTheCode")}</OnboardingStep>
        </ol>
        {restart}
        {/* waiting on a restart, the button would only press the same switch again */}
        {panel ??
          (!(status.enabled && status.restartRequired) && (
            <Button variant="brand" className="mt-4" onClick={pairPhone}>
              <Smartphone size={14} />
              {t("devicesSection.pairAPhone")}
            </Button>
          ))}
      </div>
    );
  }

  return (
    <div className="mb-9 rounded-2xl border bg-card p-5 last:mb-0" data-setting-row="phone-access">
      <ConnectionHeader
        icon={<Smartphone size={14} className="shrink-0 text-muted-foreground" />}
        title={t("devicesSection.phoneAccess")}
        says={says}
        info={offElsewhere}
        health={health && <HealthLine tone={health.tone} label={health.label} />}
        control={!away && !unanswered && <Switch aria-label={t("devicesSection.phoneAccess")} checked={status?.enabled ?? false} onCheckedChange={setEnabled} />}
      />

      <ConnectionError>{error}</ConnectionError>
      {restart}

      <AnimatePresence initial={false}>
        {arrived && (
          <PairedMoment
            key={arrived.id}
            icon={isBrowser(arrived.name) ? <Globe size={18} /> : <Smartphone size={18} />}
            title={t("devicesSection.isPaired", { name: arrived.name })}
            detail={t("devicesSection.canReachNow", { place })}
          />
        )}
      </AnimatePresence>

      {devices.length > 0 && (
        <PairedList
          devices={devices}
          now={now}
          fresh={fresh}
          place={place}
          self={status?.thisDevice}
          onRemove={(device) =>
            api(`/api/pair/devices/${device.id}`, { method: "DELETE" })
              .then(load)
              .catch((e: Error) => setError(e.message))
          }
        />
      )}

      {panel ??
        (listening && !arrived && (
          <Button size="sm" variant="secondary" className="mt-3" onClick={pairPhone}>
            <Smartphone size={13} />
            {t("devicesSection.pairAnotherPhone")}
          </Button>
        ))}

      {status === null && !error && <Loader2 size={14} className="mt-3 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** The open window where only Bloks Cloud reaches the workspace: the
 * pairing link as a QR, the same link to copy, and how long it has left.
 * A link is not renewed on its own the way a code is: it lasts fifteen
 * minutes, and whoever opens it in time is one of the owner's devices, so
 * a new one is made only when somebody asks. */
function PairingLink({
  link,
  secondsLeft,
  failed,
  expired,
  place,
  rows,
  onAgain,
  onClose,
}: {
  link: { qr: string | null } | null;
  secondsLeft: number;
  failed: boolean;
  expired: boolean;
  place: string;
  rows: React.ReactNode;
  onAgain: () => void;
  onClose: () => void;
}) {
  const stopped = failed || expired;
  return (
    <div className="relative mt-4 rounded-xl border bg-muted/30 p-4" data-browser-link>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        aria-label={t("devicesSection.closePairing")}
        className="absolute right-2 top-2 text-muted-foreground"
      >
        {t("common.close")}
      </Button>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        {/* the QR always sits on white; a themed QR is an unscannable QR */}
        <div
          className={cn(
            "flex size-[148px] shrink-0 items-center justify-center rounded-lg",
            stopped ? "border border-dashed text-muted-foreground/60" : "bg-white p-2 shadow-sm ring-1 ring-black/5",
          )}
        >
          {stopped ? (
            <Smartphone size={20} aria-hidden />
          ) : link?.qr ? (
            <img src={link.qr} alt={t("devicesSection.pairingCodeToScanWith")} className="size-[132px]" />
          ) : link ? (
            <span className="px-2 text-center text-caption text-neutral-500">{t("devicesSection.copyTheLinkInstead")}</span>
          ) : (
            <Loader2 size={16} className="animate-spin text-neutral-400" />
          )}
        </div>
        <div className="min-w-[220px] flex-1">
          {stopped ? (
            <>
              <p className="text-body font-medium text-foreground">{expired ? t("devicesSection.thatLinkRanOut") : t("devicesSection.noLinkRightNow")}</p>
              <p className="mt-0.5 text-pretty text-small text-muted-foreground">
                {expired ? t("devicesSection.linksWorkForFifteenMinutes") : t("devicesSection.tryAgainInAMoment")}
              </p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onAgain}>
                {t("devicesSection.newLink")}
              </Button>
            </>
          ) : (
            <>
              <p className="pr-14 text-pretty text-body font-medium text-foreground">
                {t("devicesSection.onYourIphoneOpenBloksAnd")}
              </p>
              <p className="mt-1 text-pretty text-small text-muted-foreground">
                {t("devicesSection.linkPairsWith", { place })}
              </p>
              <div className="mt-3 text-small tabular-nums text-muted-foreground">
                {link ? t("devicesSection.worksOnceFor", { count: Math.ceil(secondsLeft / 60) }) : t("devicesSection.worksOnce")}
              </div>
            </>
          )}
        </div>
      </div>
      {!stopped && rows}
    </div>
  );
}

/** The open window: the QR, the same thing as six digits for a camera
 * that will not focus, where to dial, and how long it has left. It
 * renews itself while open, so the clock is how long this one has, not
 * how long the person has. */
function PairingCode({
  code,
  onPick,
  msLeft,
  stopped,
  lead,
  onAgain,
  onLink,
  onClose,
}: {
  code: PairCode | null;
  onPick: (address: string) => void;
  msLeft: number;
  stopped: "closed" | "failed" | null;
  lead: string;
  onAgain: () => void;
  onLink: () => void;
  onClose: () => void;
}) {
  const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  return (
    <div className="relative mt-4 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border bg-muted/30 p-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        aria-label={t("devicesSection.closePairing")}
        className="absolute right-2 top-2 text-muted-foreground"
      >
        {t("common.close")}
      </Button>
      {stopped ? (
        // the same footprint, empty, so nothing jumps when a code returns
        <div aria-hidden className="flex size-[148px] shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground/60">
          <Smartphone size={20} />
        </div>
      ) : (
        // the QR always sits on white; a themed QR is an unscannable QR
        <div className="flex size-[148px] shrink-0 items-center justify-center rounded-lg bg-white p-2 shadow-sm ring-1 ring-black/5">
          {code?.qr ? (
            <img src={code.qr} alt={t("devicesSection.pairingCodeToScanWith")} className="size-[132px]" />
          ) : code ? (
            <span className="px-2 text-center text-caption text-neutral-500">{t("devicesSection.typeTheCodeInstead")}</span>
          ) : (
            <Loader2 size={16} className="animate-spin text-neutral-400" />
          )}
        </div>
      )}

      <div className="min-w-[220px] flex-1">
        {stopped ? (
          <>
            <p className="text-body font-medium text-foreground">
              {stopped === "closed" ? t("devicesSection.thatCodeStoppedWorkingEarly") : t("devicesSection.noCodeRightNow")}
            </p>
            <p className="mt-0.5 text-pretty text-small text-muted-foreground">
              {stopped === "closed" ? t("devicesSection.codesCloseAfterAFew") : t("devicesSection.tryAgainInAMoment")}
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={onAgain}>
              {t("devicesSection.newCode")}
            </Button>
          </>
        ) : (
          <>
            <p className="pr-14 text-pretty text-body font-medium text-foreground">{lead}</p>
            <div className="mt-3 text-small text-muted-foreground">{t("devicesSection.orTypeThisCode")}</div>
            <div
              className={cn(
                "mt-0.5 font-mono text-heading font-semibold tabular-nums tracking-[0.2em] text-foreground transition-opacity duration-200",
                !code && "opacity-30",
              )}
            >
              {code ? (
                code.code
              ) : (
                <>
                  <span aria-hidden>000000</span>
                  <span className="sr-only">{t("devicesSection.makingACode")}</span>
                </>
              )}
            </div>
            {/* The QR carries the address; a code typed by hand does
                not, and the phone asks for it. Without this line the
                by-hand route had no way to find where to dial. */}
            {code?.address && code.addresses.length < 2 && (
              <div className="mt-1.5 text-small text-muted-foreground">
                {t("common.address")} <span className="ml-1 font-mono text-foreground">{code.address}</span>
              </div>
            )}
            {/* More than one network reaches this computer (wifi and
                Tailscale, say): the person picks which one the phone
                comes over, and the code is drawn again for it. */}
            {code && code.addresses.length > 1 && (
              <div className="mt-1.5">
                <div className="text-small text-muted-foreground">{t("devicesSection.phoneComesOver")}</div>
                <div role="radiogroup" aria-label={t("devicesSection.phoneComesOver")} className="mt-1 flex flex-wrap gap-1">
                  {code.addresses.map((a) => (
                    <button
                      key={a}
                      role="radio"
                      aria-checked={code.chosen === a}
                      onClick={() => onPick(a)}
                      className={cn(
                        "rounded-md px-2 py-0.5 font-mono text-small transition-colors duration-150",
                        code.chosen === a ? "bg-background text-foreground ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {isUrl(a) ? a : a.includes(":") ? `[${a}]` : a}
                      {isOverlayAddress(a) && <span className="ml-1 font-sans text-caption text-muted-foreground">{t("devicesSection.tailscale")}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* the same pairing, for the desktop app on another computer:
                the link `bloks-server pair` prints, pasted in its Your
                servers, so no terminal on the server is needed */}
            {code?.link && (
              <PairLinkRow
                label={t("devicesSection.forTheDesktopApp")}
                link={code.link}
                copied={copiedLink === code.link}
                onCopy={() => void navigator.clipboard.writeText(code.link!).then(() => setCopiedLink(code.link!))}
              />
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-small tabular-nums text-muted-foreground">
                {code
                  ? t("devicesSection.newCodeIn", { clock: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` })
                  : t("devicesSection.worksOnce")}
              </span>
              {/* a camera that will not focus, a phone on another network,
                  or a browser: all of them want a link instead */}
              <Button size="sm" variant="ghost" className="-ml-2 sm:ml-auto" onClick={onLink}>
                <Globe size={13} />
                {t("devicesSection.pairWithALink")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
