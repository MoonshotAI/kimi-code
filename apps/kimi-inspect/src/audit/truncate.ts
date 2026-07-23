/**
 * Tail-preserving string truncation for the audit panel: long values are
 * rendered with their total length plus the LAST `keep` characters (the
 * tail is where streaming text, tool output, and prompts carry the newest
 * information). Rendering-only — the underlying state is never truncated,
 * and no field is ever dropped.
 */

export const TRUNCATE_KEEP = 500;

export function tailTrunc(value: string, keep: number = TRUNCATE_KEEP): string {
  if (value.length <= keep) return value;
  return `… [${value.length} chars total, showing last ${keep}]\n${value.slice(-keep)}`;
}
