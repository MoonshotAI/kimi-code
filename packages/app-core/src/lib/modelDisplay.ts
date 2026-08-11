// packages/app-core/src/lib/modelDisplay.ts

import type { AppModel } from '../api/types';

/**
 * Map a bound model alias to its friendly display name, mirroring the composer
 * model pill (useKimiWebClient's status line): an exact catalog id wins over a
 * bare model-name match (names can collide across providers), then
 * displayName → raw model name → the alias with any provider prefix stripped.
 * Returns undefined when there is nothing to show.
 */
export function modelDisplayName(
  alias: string | undefined,
  models: readonly AppModel[] | undefined,
): string | undefined {
  if (alias === undefined || alias.length === 0) return undefined;
  const matched = models?.find((m) => m.id === alias) ?? models?.find((m) => m.model === alias);
  return (
    matched?.displayName ||
    matched?.model ||
    (alias.includes('/') ? alias.split('/').pop()! : alias)
  );
}

/**
 * Effort segment for a subagent surface: concrete levels (low/high/max/…)
 * are always shown; the boolean states carry no level information — 'off'
 * (no thinking) and 'on' (generic thinking) both return undefined.
 */
export function subagentEffortSuffix(effort: string | undefined): string | undefined {
  if (effort === undefined || effort.length === 0 || effort === 'off' || effort === 'on') {
    return undefined;
  }
  return effort;
}
