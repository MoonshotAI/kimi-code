/**
 * HTTP helpers for raw-content routes — request header access and single-range
 * `Range` header parsing shared by the file download / content endpoints.
 */

export function pickHeader(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v[0] as string | undefined) : (v as string);
}

/**
 * Parse a single-range `bytes=` header against a known size. Returns null for
 * absent, malformed, multi-range, or unsatisfiable specs (callers then serve
 * the full body with 200).
 */
export function parseRangeHeader(
  raw: string | undefined,
  size: number,
): { start: number; end: number; length: number } | null {
  if (raw === undefined) return null;
  if (!raw.startsWith('bytes=')) return null;
  const spec = raw.slice('bytes='.length);
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const leftRaw = spec.slice(0, dash);
  const rightRaw = spec.slice(dash + 1);
  if (leftRaw === '' && rightRaw === '') return null;
  let start: number;
  let end: number;
  if (leftRaw === '') {
    const suffix = Number.parseInt(rightRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    const a = Number.parseInt(leftRaw, 10);
    if (!Number.isFinite(a) || a < 0) return null;
    start = a;
    if (rightRaw === '') {
      end = size - 1;
    } else {
      const b = Number.parseInt(rightRaw, 10);
      if (!Number.isFinite(b) || b < a) return null;
      end = Math.min(b, size - 1);
    }
  }
  if (start >= size || start > end) return null;
  return { start, end, length: end - start + 1 };
}
