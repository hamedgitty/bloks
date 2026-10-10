// The words the Backups page says, kept apart from the page so they can
// be held to what the server actually does (server/backup.ts).
//
// A restore replaces everything, so what its confirmation promises has
// to be exactly true: what happens first, what is kept, and what happens
// to the keys. Getting the keys sentence wrong would tell somebody their
// engines stay signed in when they are about to be replaced, or the other
// way round.

export type BackupKind = "manual" | "automatic" | "before-restore";

export interface BackupItem {
  name: string;
  path: string;
  size: number;
  created: number;
  kind: BackupKind;
  version: string;
  undo: boolean;
  secrets: boolean;
  encrypted: boolean;
  damaged?: boolean;
}

export interface RestoreProgress {
  phase: "draining" | "backing-up" | "staging" | "restarting" | "failed" | "cancelled";
  from: string;
  running?: number;
  deadline?: number;
  error?: string;
}

export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function kindLabel(kind: BackupKind): string | null {
  if (kind === "automatic") return "Automatic";
  if (kind === "before-restore") return "Before a restore";
  return null;
}

/** One line under a backup's date: what made it and what it holds. */
export function backupDetails(backup: BackupItem): string {
  if (backup.damaged) return `${sizeText(backup.size)} · cannot be read, so it may be damaged or not a Bloks backup`;
  return [
    backup.version ? `Bloks ${backup.version}` : null,
    sizeText(backup.size),
    backup.encrypted ? "sealed" : null,
    backup.undo ? "with Undo history" : null,
    backup.secrets ? "with saved keys" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where the workspace a restore replaces is moved, as a person would
 * look for it: beside the data folder, which is beside the backups. */
export function asideFolder(backupsFolder: string): string {
  return `${backupsFolder.replace(/-backups$/, "")}.before-restore-…`;
}

/** What happens, in order, and what it means for this backup. */
export function restoreSteps(backup: BackupItem, backupsFolder: string): { steps: string[]; notes: string[] } {
  const steps = [
    "Anything running is let finish first, for up to 10 minutes, and nothing new starts meanwhile.",
    "Your workspace is backed up as it is now.",
    "Every file in this backup is checked before anything changes.",
    `Your current workspace is moved aside to ${asideFolder(backupsFolder)}, not deleted.`,
    "Bloks restarts into the restored workspace.",
  ];
  const notes = [
    backup.secrets
      ? "This backup has its own saved keys, and they replace the ones on this computer."
      : "This backup has no saved keys, so the keys on this computer stay as they are.",
  ];
  if (!backup.undo) notes.push("It has no Undo history, so changes made before it cannot be undone afterwards.");
  return { steps, notes };
}

/** What a restore under way is doing, in a sentence. */
export function restoreLine(progress: RestoreProgress, now = Date.now()): string {
  switch (progress.phase) {
    case "draining": {
      const n = progress.running ?? 0;
      if (n === 0) return "Getting ready to restore…";
      const left = progress.deadline ? Math.max(0, Math.ceil((progress.deadline - now) / 60_000)) : null;
      return `Waiting for ${n} running ${n === 1 ? "turn" : "turns"} to finish${left !== null ? `, up to ${left} more ${left === 1 ? "minute" : "minutes"}` : ""}…`;
    }
    case "backing-up":
      return "Backing up your workspace as it is now…";
    case "staging":
      return "Unpacking the backup and checking every file…";
    case "restarting":
      return "Restarting Bloks into the restored workspace…";
    case "cancelled":
      return "The restore was called off. Nothing was changed.";
    case "failed": {
      const why = progress.error ?? "something went wrong.";
      return `The restore stopped. ${why}${/nothing was changed/i.test(why) ? "" : " Nothing was changed."}`;
    }
  }
}

export function passphraseProblem(passphrase: string, again: string): string | null {
  if (passphrase.length < 8) return "A passphrase needs at least 8 characters.";
  if (passphrase !== again) return "The two passphrases differ.";
  return null;
}
