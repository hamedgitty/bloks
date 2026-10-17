import { useEffect } from "react";
import { observeCommittedSettings } from "./settings-client.ts";
import type { DeviceSetting, DeviceValue } from "./settings-observation.ts";

/** Observe only committed state, including choices a failed storage write did
 * not save. Reporting never becomes the preference's source of truth. */
export function useSettingsObservation(values: Partial<Record<DeviceSetting, DeviceValue>>) {
  const signature = JSON.stringify(values);
  useEffect(() => observeCommittedSettings(() => JSON.parse(signature)), [signature]);
}
