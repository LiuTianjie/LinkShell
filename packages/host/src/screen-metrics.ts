/** Keep diagnostic records parseable: cutting serialized JSON hid different latency fields
 * on each report. Bound scalar fields and known groups instead; frame traces stay off this log. */
export function screenMeasurementLog(message: unknown): string {
  let remaining = 96;
  const groups = new Set(["sender", "latency", "clock", "flexfec", "heard"]);
  function compact(value: unknown, depth: number): Record<string, unknown> {
    const kept: Record<string, unknown> = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return kept;
    for (const [key, entry] of Object.entries(value)) {
      if (remaining-- <= 0) break;
      if (key.length > 48) continue;
      if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) kept[key] = entry;
      else if (typeof entry === "string") kept[key] = entry.slice(0, 128);
      else if (depth < 2 && groups.has(key)) kept[key] = compact(entry, depth + 1);
    }
    return kept;
  }
  const encoded = JSON.stringify(compact(message, 0));
  return encoded.length <= 8192 ? encoded : JSON.stringify({ t: "measure", error: "measurement too large" });
}
