// A reported window's identity is presentation data, not a model selection.
// Share its validation between the server's fallback and the web client.
export function reportedPlanWindow(value: unknown): { id: string; name: string; minutes: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const { id, minutes } = value as { id?: unknown; minutes?: unknown };
  if (typeof id !== "string" || (minutes !== null && (!Number.isSafeInteger(minutes) || (minutes as number) <= 0))) return null;
  // bounded by characters, so a long name never ends in half of one
  const name = Array.from(id.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")).slice(0, 80).join("").trim();
  if (!name) return null;
  const namedDuration = id === "five_hour" ? 300
    : ["seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"].includes(id) ? 10_080
      : null;
  // Do not choose between contradictory reports of a named duration.
  if (namedDuration !== null && minutes !== null && minutes !== namedDuration) return null;
  return { id, name, minutes: namedDuration ?? (minutes as number | null) };
}
