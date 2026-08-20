// The buzz, and nothing else.
//
// The relay cannot read a single frame it carries, so a push can only
// ever say that something happened: the words below are fixed at compile
// time and the payload names no agent, no message, no content. What the
// phone shows when tapped comes from its own sealed stream, not from
// here.
//
// Token auth (the .p8 key), not certificates: one key signs for every
// app on the team, does not expire annually, and rotates by replacing an
// environment variable. The JWT is cached well inside Apple's one hour
// window. HTTP/2 comes from node:http2 rather than a dependency, because
// the whole exchange is one request per push.
import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

export interface ApnsConfig {
  /** The .p8 private key, PEM text. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id, e.g. dev.bloks.app. */
  topic: string;
  /** Fallback when a token arrives without its own environment. */
  env?: string;
}

/** Where a token lives. Dev-signed builds get sandbox tokens, TestFlight
 * and the App Store get production ones, and one relay serves both. */
export type ApnsEnv = "sandbox" | "production";

/** What a wake reason reads as on a lock screen. Generic on purpose. */
const WORDING: Record<string, string> = {
  "needs-you": "An agent is waiting for your approval.",
};
const FALLBACK = "Something needs you in Bloks.";

const b64url = (value: object | Buffer): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");

export function apnsFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  return {
    // Fly secrets flatten newlines; put them back before parsing the PEM.
    key: env.APNS_KEY.replace(/\\n/g, "\n"),
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC || "dev.bloks.app",
    env: env.APNS_ENV,
  };
}

export class ApnsSender {
  private readonly config: ApnsConfig;
  private jwt: { value: string; at: number } | null = null;

  constructor(config: ApnsConfig) {
    this.config = config;
  }

  /** ES256, cached for 45 minutes of Apple's 60 minute allowance. */
  private bearer(): string {
    if (this.jwt && Date.now() - this.jwt.at < 45 * 60_000) return this.jwt.value;
    const header = b64url({ alg: "ES256", kid: this.config.keyId });
    const claims = b64url({ iss: this.config.teamId, iat: Math.floor(Date.now() / 1000) });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: createPrivateKey(this.config.key),
      dsaEncoding: "ieee-p1363",
    });
    this.jwt = { value: `${header}.${claims}.${b64url(signature)}`, at: Date.now() };
    return this.jwt.value;
  }

  /**
   * One buzz to one device. Resolves to "gone" when Apple says the token
   * is dead, so the caller can drop it; any other failure is swallowed
   * after a log line, because a missed buzz must never break the wake
   * path that carried it.
   */
  send(token: string, reason: string, env?: ApnsEnv): Promise<"ok" | "gone" | "failed"> {
    const where = env ?? (this.config.env === "sandbox" ? "sandbox" : "production");
    const host =
      where === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const body = JSON.stringify({
      aps: {
        alert: { title: "Bloks", body: WORDING[reason] ?? FALLBACK },
        sound: "default",
        "thread-id": "bloks-wake",
      },
    });

    return new Promise((resolve) => {
      const session = connect(host);
      let settled = false;
      const done = (result: "ok" | "gone" | "failed") => {
        if (settled) return;
        settled = true;
        // destroy, not close: close waits politely for streams that a
        // timeout has just proven are not finishing
        session.destroy();
        resolve(result);
      };
      session.on("error", () => done("failed"));
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.bearer()}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        // one banner per wake reason: repeated wakes for the same pending
        // approval collapse instead of stacking on the lock screen
        "apns-collapse-id": `bloks-${reason}`.slice(0, 64),
        "content-type": "application/json",
      });
      req.setTimeout(10_000, () => done("failed"));
      req.on("close", () => done("failed"));
      req.on("response", (headers) => {
        const status = Number(headers[":status"] ?? 0);
        let payload = "";
        req.on("data", (c) => (payload += c));
        req.on("end", () => {
          if (status === 200) return done("ok");
          let reasonWord = "";
          try {
            reasonWord = String(JSON.parse(payload).reason ?? "");
          } catch {}
          console.warn(`[relay] apns ${where} ${status} ${reasonWord} for …${token.slice(-8)}`);
          // a stale provider token sticks for 45 minutes unless dropped
          if (status === 403 && reasonWord === "ExpiredProviderToken") this.jwt = null;
          // all of these mean: this token will never work again
          const dead =
            status === 410 ||
            ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reasonWord);
          done(dead ? "gone" : "failed");
        });
      });
      req.on("error", () => done("failed"));
      req.end(body);
    });
  }
}
