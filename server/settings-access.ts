import type { IncomingMessage } from "node:http";
import type { AppConfig } from "./config.ts";
import { bearerToken, isLocalRequest, isSameOrigin } from "./http-guard.ts";
import { deviceForToken, pairedDevices, remoteEnabled } from "./pairing.ts";
import type { SettingsReader } from "./settings-read-http.ts";
import type { SettingsReportCaller } from "./settings-report-http.ts";

/** Only the three settings paths use this classification. Agent/relay
 * identities are supplied by their EXISTING request authenticators; presented
 * device credentials still identify a member when the socket is loopback.
 * Pairing resolution uses the config owner's last observation, not disk. */
export function settingsAccess(
  req: IncomingMessage, saved: AppConfig, agentId: string | null, relayDeviceId: string | null,
): { reader: SettingsReader; reporter: SettingsReportCaller } {
  const invalid = () => ({reader:{role:"invalid"} as const, reporter:{role:"invalid"} as const});
  const denied = () => ({reader:{role:"member"} as const, reporter:{role:"member"} as const});
  if (agentId) {
    return isLocalRequest(req) ? {reader:{role:"agent",identity:`agent:${agentId}`},reporter:{role:"agent"}}
      : denied();
  }
  const relayHeaders = Object.keys(req.headers).some((name) => name.startsWith("x-bloks-relay"));
  if (relayHeaders && !relayDeviceId) return invalid();
  const device = relayDeviceId ? pairedDevices(saved).find((item) => item.id === relayDeviceId) ?? null
    : deviceForToken(bearerToken(req), saved);
  if (relayDeviceId && !device) return invalid();
  if (!relayDeviceId && req.headers.authorization !== undefined && !device) return invalid();
  if (device?.personId) return denied();
  const local = !relayDeviceId && isLocalRequest(req);
  if (!local && (!remoteEnabled(saved) || !device || (!relayDeviceId && !isSameOrigin(req)))) return invalid();
  return {reader:{role:"owner",identity:"owner"},reporter:{role:"owner",source:relayDeviceId
    ? {path:"remote",deviceId:device!.id} : {path:"direct",deviceId:device?.id ?? null}}};
}
