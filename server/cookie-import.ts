// Borrowing a sign-in, one site at a time.
//
// An agent with a browser and no session can read the public web and
// little else. The useful version is already signed in to the handful
// of sites the task is about, and the only place that session exists is
// the person's own browser.
//
// Two decisions shape this, both deliberate:
//
// It is per site, never the whole jar. Copying every cookie hands an
// agent the bank, the mail and the medical portal in order to let it
// check a delivery. The person names the sites, and only those move.
//
// It reads a copy. Chrome holds a lock on the live database while it is
// running, and more to the point a bug in here should be incapable of
// writing to the person's own browser state.
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch, absent for a session cookie. */
  expires?: number;
}

const SERVICE: Record<string, string> = {
  Chrome: "Chrome Safe Storage",
  Brave: "Brave Safe Storage",
  Edge: "Microsoft Edge Safe Storage",
};

/** Where the browsers on this machine keep their jars. */
export function cookieStores(): Array<{ browser: string; path: string }> {
  const home = homedir();
  const mac = (vendor: string, app: string) =>
    join(home, "Library", "Application Support", vendor, app, "Default", "Cookies");
  const candidates =
    process.platform === "darwin"
      ? [
          { browser: "Chrome", path: mac("Google", "Chrome") },
          { browser: "Brave", path: mac("BraveSoftware", "Brave-Browser") },
          { browser: "Edge", path: mac("Microsoft", "Edge") },
        ]
      : process.platform === "linux"
        ? [{ browser: "Chrome", path: join(home, ".config", "google-chrome", "Default", "Cookies") }]
        : [
            {
              browser: "Chrome",
              path: join(
                home,
                "AppData",
                "Local",
                "Google",
                "Chrome",
                "User Data",
                "Default",
                "Network",
                "Cookies",
              ),
            },
          ];
  return candidates.filter((entry) => existsSync(entry.path));
}

/**
 * The passphrase the browser encrypted its cookies with.
 *
 * On macOS it lives in the login keychain, and asking for it is what
 * raises the system's own permission prompt. That prompt is the point:
 * the person authorises this in the operating system's dialog rather
 * than in one we drew ourselves.
 */
export function safeStorageKey(browser: string): Promise<string> {
  const service = SERVICE[browser];
  if (process.platform !== "darwin" || !service) {
    // Chrome on Linux falls back to a fixed passphrase when there is no
    // keyring, which is the usual case away from a desktop session.
    return Promise.resolve("peanuts");
  }
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-w", "-s", service, "-a", browser],
      { timeout: 60_000 },
      (error, stdout) => {
        if (error) reject(new Error(`could not read the ${browser} key from your keychain`));
        else resolve(stdout.trim());
      },
    );
  });
}

const IV = Buffer.alloc(16, 0x20);

/**
 * Chrome's scheme: PBKDF2 over the keychain passphrase, then AES-CBC
 * with an IV of spaces. A v10 or v11 prefix says the value is encrypted;
 * anything else is already plain.
 */
export function decryptValue(encrypted: Buffer, passphrase: string): string | null {
  if (!encrypted.length) return "";
  const version = encrypted.subarray(0, 3).toString();
  if (version !== "v10" && version !== "v11") return encrypted.toString("utf8");
  const iterations = process.platform === "darwin" ? 1003 : 1;
  const key = pbkdf2Sync(passphrase, "saltysalt", iterations, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    // PKCS#7 unpadded by hand: auto-padding rejects Chrome's own output.
    const pad = plain[plain.length - 1];
    const body = pad > 0 && pad <= 16 ? plain.subarray(0, plain.length - pad) : plain;
    return body.toString("utf8");
  } catch {
    return null;
  }
}

/** Does this cookie's domain belong to one of the sites asked for? */
export function matchesSite(cookieDomain: string, site: string): boolean {
  const host = cookieDomain.replace(/^\./, "").toLowerCase();
  const wanted = site
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/^\./, "")
    .toLowerCase();
  if (!wanted || !host) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}

/**
 * Read the cookies for the named sites out of a browser's jar.
 *
 * A row that will not decrypt is skipped rather than thrown: one
 * unreadable cookie should not cost the person the other forty.
 */
export async function readCookies(
  storePath: string,
  browser: string,
  sites: string[],
): Promise<ImportedCookie[]> {
  if (!sites.length) return [];
  const passphrase = await safeStorageKey(browser);
  const copy = join(tmpdir(), `bloks-cookies-${process.pid}.sqlite`);
  copyFileSync(storePath, copy);
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT host_key, name, encrypted_value, path, is_secure, is_httponly, expires_utc FROM cookies",
      )
      .all() as Array<Record<string, unknown>>;
    db.close();

    const out: ImportedCookie[] = [];
    for (const row of rows) {
      const domain = String(row.host_key ?? "");
      if (!sites.some((site) => matchesSite(domain, site))) continue;
      const value = decryptValue(Buffer.from((row.encrypted_value as Uint8Array) ?? []), passphrase);
      if (value === null) continue;
      const expires = Number(row.expires_utc ?? 0);
      out.push({
        name: String(row.name ?? ""),
        value,
        domain,
        path: String(row.path ?? "/"),
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        // Chrome counts microseconds from 1601; zero means a session cookie.
        ...(expires ? { expires: Math.floor(expires / 1_000_000 - 11_644_473_600) } : {}),
      });
    }
    return out;
  } finally {
    rmSync(copy, { force: true });
  }
}
