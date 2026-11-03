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
  InstanceConfig,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";
import { engineScreens, NO_SCREENS } from "../screens.ts";

/** A configured instance that could not be brought up, kept so it can be
 * displayed and so its config survives the round trip. */
export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** As configured, so a switch in Settings still reads true to it. */
  enabled: boolean;
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
  /** Switched on in Settings. An engine that is off can still be
   * installed and signed in, and its snapshot says so; this is the one
   * thing that says it starts no turns (GitHub 421). */
  enabled: boolean;
  snapshot: ProviderSnapshot;
  models: import("../contracts.ts").ModelCatalog;
  /** The effort levels the engine takes, least first; empty for one
   * with no dial. A model listed with its own narrows them. */
  efforts: readonly import("../effort.ts").Effort[];
  /** The agent's own browser and the computers the engine can be handed
   * (server/screens.ts), so an agent's settings can say which it cannot. */
  screens: import("../screens.ts").EngineScreens;
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
        this.shadow(instanceId, entry.driver, entry.displayName, entry.enabled ?? true, {
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
        this.shadow(instanceId, entry.driver, entry.displayName ?? driver.metadata.displayName, entry.enabled ?? true, {
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

  /** A clone of the input already retained by this owner at its last load.
   * No driver callback, config reread or health observation. This internal
   * value contains credentials and must only reach an explicit projector. */
  configuredInput(instanceId: InstanceId): InstanceConfig | null {
    const bytes = this.built.get(instanceId);
    return bytes === undefined ? null : JSON.parse(bytes) as InstanceConfig;
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
    enabled: boolean,
    { reason }: { reason: string },
  ) {
    this.entries_.set(instanceId, {
      instanceId,
      shadow: { instanceId, driverKind, displayName, enabled, shadow: true, reason },
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
      enabled: entry.shadow.enabled,
      snapshot: { state: "unavailable", reason: entry.shadow.reason },
      models: { default: "", options: [] },
      efforts: [],
      screens: NO_SCREENS,
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
    // read the way a turn's start reads it, so the two never disagree
    enabled: instance.enabled !== false,
    snapshot,
    models: instance.models,
    efforts: instance.adapter.capabilities.efforts ?? [],
    screens: engineScreens(instance.adapter.capabilities),
  };
}
