/**
 * JSON canonicalization used by tool-call telemetry and dedup.
 * Recursively sorts object keys so semantically-equal args produce identical keys.
 */
export function canonicalTelemetryArgs(args: unknown): string {
  const json = JSON.stringify(sortJsonValue(args));
  return json ?? String(args);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
