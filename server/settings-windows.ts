import { randomBytes, randomUUID } from "node:crypto";
import { MAX_SSE_CLIENTS } from "./limits.ts";
import { deviceSettingsSnapshot, type DeviceSettingsSnapshot } from "../src/lib/settings-observation.ts";

export const SETTINGS_LEASE_MS = 60_000;
export const SETTINGS_REMOTE_WINDOWS = 64;
export const SETTINGS_DEVICE_WINDOWS = 4;

// Constructed only AFTER route authentication. No request body selects these.
export type SettingsWindowSource =
  | { path: "direct"; deviceId: string | null }
  | { path: "remote"; deviceId: string };
export interface SettingsAdmission {
  label: string;
  generation: string;
  capability: string;
  issuedAt: number;
  lifetimeMs: number;
}
type LastObservation = {
  snapshot: DeviceSettingsSnapshot;
  generation: string;
  sequence: number;
  issuedAt: number;
  receivedAt: number;
};
type WindowRecord = {
  source: SettingsWindowSource;
  windowKey: string;
  admission: SettingsAdmission;
  deadline: number;
  created: number;
  open: boolean;
  closure: "observed" | "revoked" | null;
  last: LastObservation | null;
  sequence: number;
};

// This object is held by the owning direct response or proxy-window binding.
// It is NOT a serializable renderer/report credential. An expired report
// admission therefore cannot be used to renew or resurrect a window.
export type SettingsWindowBinding = object;

/** Volatile recent observations, not a preference store. No probes or timers.
 * Authentication/liveness must be established by the actual transport owner;
 * a recent client report is never independent attestation of current UI. */
export class SettingsWindows {
  private readonly records = new Map<SettingsWindowBinding, WindowRecord>();
  private evicted = 0;
  private elapsed = -Infinity;
  private readonly clocks: { monotonic: () => number; wall: () => number };

  constructor(clocks = { monotonic: () => performance.now(), wall: () => Date.now() }) { this.clocks = clocks; }

  private now() {
    // performance.now is monotonic within this boot. Clamping also makes an
    // injected faulty clock fail conservatively instead of extending a lease.
    this.elapsed = Math.max(this.elapsed, this.clocks.monotonic());
    return this.elapsed;
  }

  private issue(label: string): SettingsAdmission {
    return {
      label, generation: randomUUID(), capability: randomBytes(32).toString("base64url"),
      issuedAt: this.clocks.wall(), lifetimeMs: SETTINGS_LEASE_MS,
    };
  }

  /** Call once for a new, authenticated, still-open transport window. A lost
   * reply must not trigger an automatic retry. Its bounded orphan may remain. */
  open(source: SettingsWindowSource): { binding: SettingsWindowBinding; windowKey: string; admission: SettingsAdmission } | null {
    const now = this.now();
    const candidates = [...this.records.entries()];
    const removed = new Set<SettingsWindowBinding>();
    const relevant = (record: WindowRecord, kind: "path" | "device") => kind === "path"
      ? record.source.path === source.path
      : source.deviceId !== null && record.source.deviceId === source.deviceId;
    // Plan eviction before mutating so an all-live capacity refusal does not
    // destroy another useful observation while still failing admission.
    for (const [kind, limit] of [
      ["path", source.path === "direct" ? MAX_SSE_CLIENTS : SETTINGS_REMOTE_WINDOWS],
      ["device", source.deviceId === null ? Infinity : SETTINGS_DEVICE_WINDOWS],
    ] as const) {
      while (candidates.filter(([key, record]) => !removed.has(key) && relevant(record, kind)).length >= limit) {
        const victim = candidates.filter(([key, record]) => !removed.has(key) && relevant(record, kind) &&
          (!record.open || now >= record.deadline)).sort((a, b) => a[1].created - b[1].created)[0];
        if (!victim) return null;
        removed.add(victim[0]);
      }
    }
    for (const key of removed) this.records.delete(key);
    this.evicted = Math.min(Number.MAX_SAFE_INTEGER, this.evicted + removed.size);
    const admission = this.issue(randomUUID());
    const binding = {};
    const windowKey = randomBytes(32).toString("base64url");
    this.records.set(binding, {
      source: { ...source }, windowKey, admission, deadline: now + SETTINGS_LEASE_MS,
      created: now, open: true, closure: null, last: null, sequence: -1,
    });
    return { binding, windowKey, admission: { ...admission } };
  }

  /** Only the existing transport binding may renew. The caller re-establishes
   * its direct response/proxy-local window is still current before this call.
   * Changing generations retains exactly one previous accepted observation. */
  renew(binding: SettingsWindowBinding): SettingsAdmission | null {
    const now = this.now();
    const record = this.records.get(binding);
    if (!record?.open) return null;
    record.admission = this.issue(record.admission.label);
    record.deadline = now + SETTINGS_LEASE_MS;
    record.sequence = -1;
    return { ...record.admission };
  }

  /** The direct response gives its private window key to that renderer only.
   * Remote keys stay inside the proxy, whose local stream must still exist
   * before injecting one. Report capabilities can never enter this lookup. */
  renewWindow(source: SettingsWindowSource, windowKey: string): SettingsAdmission | null {
    this.now();
    for (const [binding, record] of this.records) {
      if (record.source.path === source.path && record.source.deviceId === source.deviceId && record.windowKey === windowKey) {
        return this.renew(binding);
      }
    }
    return null;
  }

  private match(source: SettingsWindowSource, admission: SettingsAdmission): WindowRecord | undefined {
    return [...this.records.values()].find((record) =>
      record.source.path === source.path && record.source.deviceId === source.deviceId &&
      record.admission.label === admission.label && record.admission.generation === admission.generation &&
      record.admission.capability === admission.capability);
  }

  report(source: SettingsWindowSource, admission: SettingsAdmission, sequence: number, raw: unknown): boolean {
    const now = this.now();
    const record = this.match(source, admission);
    if (!record?.open || now >= record.deadline || !Number.isSafeInteger(sequence) || sequence < 0 ||
        sequence <= record.sequence) return false;
    const snapshot = deviceSettingsSnapshot(raw);
    // Sequence AND committed revision must advance. A delayed native report
    // at the same revision may complete it once with a larger sequence.
    if (!snapshot || record.last && snapshot.revision < record.last.snapshot.revision) return false;
    record.sequence = sequence;
    record.last = {
      snapshot, generation: admission.generation, sequence,
      issuedAt: record.admission.issuedAt, receivedAt: this.clocks.wall(),
    };
    return true;
  }

  close(binding: SettingsWindowBinding): void {
    this.now();
    const record = this.records.get(binding);
    if (record) { record.open = false; record.closure = "observed"; }
  }

  /** A delayed remote close names only its own report generation. */
  closeAdmission(source: SettingsWindowSource, admission: SettingsAdmission): boolean {
    this.now();
    const record = this.match(source, admission);
    if (!record) return false;
    record.open = false;
    record.closure = "observed";
    return true;
  }

  revoke(deviceId: string): void {
    this.now();
    for (const record of this.records.values()) if (record.source.deviceId === deviceId) {
      record.open = false;
      record.closure = "revoked";
    }
  }

  /** Read does not refresh or probe. Expired/closed values remain dated facts.
   * No capability, generation credential or private binding is projected. */
  inspect() {
    const now = this.now();
    return {
      evictedObservations: this.evicted,
      limits: { direct: MAX_SSE_CLIENTS, remote: SETTINGS_REMOTE_WINDOWS, perDevice: SETTINGS_DEVICE_WINDOWS },
      windows: [...this.records.values()].map((record) => ({
        label: record.admission.label,
        source: { ...record.source, identity: record.source.deviceId === null ? "unverified-window" : "paired-owner-device" },
        transport: record.closure === "revoked" ? "revoked" : !record.open ? "observed-closed"
          : record.source.path === "remote" ? "unconfirmed" : "observed-open",
        freshness: record.open && now < record.deadline && record.last?.generation === record.admission.generation
          ? "recent-observation" : "unknown",
        lastReported: record.last ? structuredClone({
          snapshot: record.last.snapshot, sequence: record.last.sequence,
          issuedAt: record.last.issuedAt, receivedAt: record.last.receivedAt,
          currentGeneration: record.last.generation === record.admission.generation,
        }) : null,
      })),
    };
  }
}
