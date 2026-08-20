// Where every provider's output becomes one stream.
//
// Each running instance emits its own normalised events. They all arrive
// here, get stamped with which instance produced them, and go two places
// at once: an append-only log on disk, and whoever is subscribed (the SSE
// endpoint, and the folder in server/index.ts that turns events into
// transcript messages).
//
// The log is the reason this is a bus rather than a callback. A turn that
// went wrong is reconstructable afterwards from `~/.bloks/events/<thread>
// .ndjson` without having had a debugger attached at the time, which is
// most of how anything here gets diagnosed.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";

export class EventBus {
  private subscribers = new Set<RuntimeEventListener>();
  private detachers: Array<() => void> = [];

  /** Start relaying from these instances. Safe to call again after a
   * `detachAll`, which is what a config reload does. */
  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      const detach = instance.adapter.onEvent((event) => {
        // An adapter speaking for a driver other than its own means two
        // instances have got tangled, and the resulting transcript would
        // be attributed to the wrong agent. Drop it loudly instead.
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.detachers.push(detach);
    }
  }

  publish(event: RuntimeEvent) {
    this.record(event);
    // Iterate a copy: a subscriber is allowed to unsubscribe from inside
    // its own callback, and mutating the set mid-loop would skip someone.
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        // One bad subscriber must not cost the others their event.
        console.error("bus: listener threw", error);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Stop relaying, without disturbing subscribers: they stay attached and
   * pick up again when new instances are attached. */
  detachAll() {
    for (const detach of this.detachers.splice(0)) detach();
  }

  /** One line per event, per thread. Failures are swallowed on purpose.
   * A full disk or a missing directory is a reason to lose the log, never
   * a reason to lose the turn it belongs to. */
  private record(event: RuntimeEvent) {
    try {
      appendFileSync(join(EVENTS_DIR, `${event.threadId}.ndjson`), JSON.stringify(event) + "\n");
    } catch {
      /* logging is best effort by design */
    }
  }
}
