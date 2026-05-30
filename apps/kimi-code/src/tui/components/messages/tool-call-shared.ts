/**
 * Small helpers shared between `ToolCallComponent` and `SwarmCard`.
 *
 * These live in their own module rather than being duplicated so the two cards
 * cannot drift (tests assert e.g. `1.8k tok` formatting in both).
 */

/** Keeps a running swarm worker's activity to a single dashboard line. */
export const SWARM_ACTIVITY_MAX_LENGTH = 48;

/** Coerce an unknown value to a string, defaulting to '' for non-strings. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Compact token count formatting, e.g. `1.8k tok` / `2.0M tok`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${String(n)} tok`;
}
