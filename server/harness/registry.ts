// Turning configured instances into running ones.
//
// The rule that shapes this file: **a bad entry is never fatal.** An
// instance naming a driver this build has never heard of, or carrying
// config that fails to decode, is kept as a placeholder that reports
// itself unavailable. It is not dropped and it does not stop startup.
//
// That matters because settings round-trip between builds. Someone on a
// newer version configures an engine, opens an older one, and the entry
// has to survive being loaded by a build that cannot run it, or the
// downgrade silently eats their configuration. The placeholder also gives
// the model picker something honest to show, with a reason attached,
// rather than a row that quietly vanished.
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

/** A configured instance that could not be brought up, kept so it can be
 * displayed and so its config survives the round trip. */
export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** One row of what the model picker renders. */
interface InstanceReport {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string;
  snapshot: ProviderSnapshot;
  models: { default: string; options: Array<{ id: string; label: string }> };
}

export class ProviderRegistry {
  private entries_ = new Map<InstanceId, RegistryEntry>();
  /** What each instance was built from, to tell which ones a new config
   * actually changes. */
  private built = new Map<InstanceId, string>();
  private drivers: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.drivers = new Map(drivers.map((driver) => [driver.driverKind, driver]));
  }

  async load(configs: InstanceConfigMap) {
    for (const [instanceId, entry] of Object.entries(configs)) {
      this.built.set(instanceId, JSON.stringify(entry));
      const driver = this.drivers.get(entry.driver);

      if (!driver) {
        this.shadow(instanceId, entry.driver, entry.displayName, {
          reason: `unknown driver "${entry.driver}", kept as configured, unavailable here`,
        });
        continue;
      }

      try {
        // `undefined` means "never configured", which is different from
        // configured-and-empty: only the former gets the driver's defaults.
        const config =
          entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);

        this.entries_.set(instanceId, {
          instanceId,
          live: await driver.create({
            instanceId,
            displayName: entry.displayName ?? driver.metadata.displayName,
            environment: entry.environment ?? {},
            enabled: entry.enabled ?? true,
            config,
          }),
        });
      } catch (error) {
        this.shadow(instanceId, entry.driver, entry.displayName ?? driver.metadata.displayName, {
          reason: describe(error),
        });
      }
    }
  }

  /** The instances a move to `configs` has to rebuild: new, gone, or
   * built from something else, plus any in `also` (an engine whose CLI
   * was updated is built from the same config, and still has to be
   * built again to see its new models). */
  stale(configs: InstanceConfigMap, also: readonly InstanceId[] = []): InstanceId[] {
    const ids = new Set([...this.entries_.keys(), ...Object.keys(configs)]);
    return [...ids].filter(
      (id) => also.includes(id) || !configs[id] || !this.entries_.has(id) || this.built.get(id) !== JSON.stringify(configs[id]),
    );
  }

  /** Rebuild only these from `configs`, leaving every other instance, and
   * the turns running on it, alone. One that `configs` no longer names is
   * gone afterwards. */
  async reload(configs: InstanceConfigMap, instanceIds: readonly InstanceId[]) {
    const going = instanceIds.flatMap((id) => {
      const live = this.entries_.get(id)?.live;
      this.entries_.delete(id);
      this.built.delete(id);
      return live ? [live] : [];
    });
    await Promise.allSettled(going.map((instance) => instance.dispose()));
    await this.load(Object.fromEntries(instanceIds.flatMap((id) => (configs[id] ? [[id, configs[id]]] : []))));
    // in the order the config gives, as a fresh load would have them, so
    // the picker does not reshuffle after a reload
    const order = Object.keys(configs);
    this.entries_ = new Map([...this.entries_].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.entries_.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.entries_.values()];
  }

  instances(): ProviderInstance[] {
    return this.entries().flatMap((entry) => (entry.live ? [entry.live] : []));
  }

  /** Every instance with its current health, for the model picker. Health
   * is asked for fresh each time (a CLI can be installed or signed out
   * between two calls) and a probe that throws is reported, not raised. */
  describe(): Promise<InstanceReport[]> {
    return Promise.all(this.entries().map((entry) => report(entry)));
  }

  /** Tear every instance down. Failures are collected rather than thrown:
   * one driver refusing to die must not leave the rest running. */
  async disposeAll() {
    await Promise.allSettled(this.instances().map((instance) => instance.dispose()));
    this.entries_.clear();
    this.built.clear();
  }

  private shadow(
    instanceId: InstanceId,
    driverKind: string,
    displayName: string | undefined,
    { reason }: { reason: string },
  ) {
    this.entries_.set(instanceId, {
      instanceId,
      shadow: { instanceId, driverKind, displayName, shadow: true, reason },
    });
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function report(entry: RegistryEntry): Promise<InstanceReport> {
  if (entry.shadow) {
    return {
      instanceId: entry.instanceId,
      driverKind: entry.shadow.driverKind,
      displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
      snapshot: { state: "unavailable", reason: entry.shadow.reason },
      models: { default: "", options: [] },
    };
  }

  const instance = entry.live;
  let snapshot: ProviderSnapshot;
  try {
    snapshot = await instance.snapshot();
  } catch (error) {
    snapshot = { state: "unavailable", reason: describe(error) };
  }

  return {
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    displayName: instance.displayName ?? instance.driverKind,
    snapshot,
    models: instance.models,
  };
}
