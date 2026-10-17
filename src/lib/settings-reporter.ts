import { deviceSettingsSnapshot, type DeviceSettingsSnapshot } from "./settings-observation.ts";

export interface ReportAdmission {
  label: string;
  generation: string;
  capability: string;
  lifetimeMs: number;
}
export interface SettingsReportTransport {
  // Only the private control-frame owner constructs this transport. Admission
  // uses its current window binding, not an expired report capability.
  admit(): Promise<ReportAdmission | null>;
  post(admission: ReportAdmission, sequence: number, snapshot: DeviceSettingsSnapshot): Promise<void>;
}
type ReporterOptions = {
  capture: () => unknown;
  native?: () => Promise<unknown>;
  monotonic?: () => number;
  wall?: () => number;
};

/** Reports committed owners without changing preferences. One serialized
 * admission/report, one latest replacement and one finite native read. No
 * timers, retries, read-triggered work or acknowledgement feedback. */
export class SettingsReporter {
  private readonly options: ReporterOptions;
  private transport: SettingsReportTransport | null = null;
  private epoch = 0;
  private revision = 0;
  private admission: ReportAdmission | null = null;
  private deadline = 0;
  private sequence = 0;
  private pending = false;
  private renewalAllowed = false;
  private busy = false;
  private scheduled = false;
  private nativeBusy = false;
  private nativeRequested = false;
  private nativeValue: { epoch: number; revision: number; values: unknown } | null = null;

  constructor(options: ReporterOptions) { this.options = options; }

  connect(transport: SettingsReportTransport) {
    this.disconnect();
    this.transport = transport;
    this.changed();
  }

  disconnect() {
    this.epoch++;
    this.transport = null;
    this.admission = null;
    this.nativeValue = null;
    this.pending = false;
    this.renewalAllowed = false;
    this.nativeRequested = false;
  }

  // Called after the actual preference/layout owner commits, including a
  // change it could not persist. A report failure never rolls that owner back.
  changed() {
    this.revision++;
    if (!this.transport) return;
    this.pending = true;
    this.renewalAllowed = true;
    this.nativeRequested = Boolean(this.options.native);
    this.schedule();
  }

  private now() { return (this.options.monotonic ?? (() => performance.now()))(); }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private captureNative(epoch: number, revision: number) {
    if (!this.options.native || this.nativeBusy || !this.nativeRequested) return;
    this.nativeRequested = false;
    this.nativeBusy = true;
    // Synchronous bridge failures are neutral observations too.
    void Promise.resolve().then(() => this.options.native!()).then((values) => {
      if (this.transport && this.epoch === epoch && this.revision === revision) {
        this.nativeValue = { epoch, revision, values };
        this.pending = true;
        // Publication does NOT request another native capture or renewal.
      }
    }, () => {}).finally(() => {
      this.nativeBusy = false;
      if (this.pending || this.nativeRequested) this.schedule();
    });
  }

  private async drain() {
    if (this.busy || !this.transport) return;
    this.busy = true;
    try {
      while (this.transport && (this.pending || this.nativeRequested && !this.nativeBusy)) {
        const transport: SettingsReportTransport = this.transport;
        const epoch = this.epoch;
        if (!this.admission || this.now() >= this.deadline) {
          if (!this.renewalAllowed) { this.pending = false; this.nativeRequested = false; break; }
          this.renewalAllowed = false;
          const started = this.now();
          let admitted: ReportAdmission | null;
          try { admitted = await transport.admit(); }
          catch { admitted = null; }
          if (epoch !== this.epoch || transport !== this.transport) continue;
          if (!admitted || !Number.isFinite(admitted.lifetimeMs) || admitted.lifetimeMs <= 0 ||
              this.now() >= started + admitted.lifetimeMs) {
            // Ambiguous admission is never automatically replayed. All
            // changes coalesced behind this attempt await a new real change.
            this.pending = false;
            this.nativeRequested = false;
            this.renewalAllowed = false;
            break;
          }
          this.admission = admitted;
          // Conservative local estimate includes request transit; the server
          // alone enforces the actual monotonic deadline.
          this.deadline = started + admitted.lifetimeMs;
          this.sequence = 0;
        }
        // Capture AFTER admission, not before a slow renewal. Changes while
        // it was pending are now represented by one latest complete snapshot.
        const revision = this.revision;
        this.captureNative(epoch, revision);
        if (!this.pending) break;
        this.pending = false;
        this.renewalAllowed = false;
        let values: unknown;
        try { values = this.options.capture(); } catch { continue; }
        const native = this.nativeValue;
        const nativeValues = native?.epoch === epoch && native.revision === revision ? native.values : {};
        const nativeSnapshot = deviceSettingsSnapshot({ schema: 1, revision, observedAt: 0, values: nativeValues })!;
        const webSnapshot = deviceSettingsSnapshot({ schema: 1, revision, observedAt: 0, values })!;
        const snapshot = deviceSettingsSnapshot({
          schema: 1, revision, observedAt: (this.options.wall ?? Date.now)(),
          values: { ...webSnapshot.values, ...Object.fromEntries(Object.entries(nativeSnapshot.values)
            .filter(([key]) => key.startsWith("native.") || key.startsWith("window."))) },
        });
        if (!snapshot || epoch !== this.epoch || transport !== this.transport) continue;
        try { await transport.post(this.admission!, ++this.sequence, snapshot); }
        catch {
          // No automatic replay or preference rollback. A subsequent actual
          // change re-establishes window authority before a new observation.
          this.admission = null;
        }
      }
    } finally {
      this.busy = false;
      if (this.transport && (this.pending || this.nativeRequested && !this.nativeBusy)) this.schedule();
    }
  }
}
