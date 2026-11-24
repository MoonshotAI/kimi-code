import type { AppToolsConfig } from '../api/types';

export const TOWER_MODE_TOOL_NAMES = [
  'TowerComplete',
  'TowerFinding',
  'TowerInbox',
  'TowerInit',
  'TowerMerge',
  'TowerMission',
  'TowerPlan',
  'TowerRebase',
  'TowerReview',
  'TowerSend',
  'TowerSpawn',
  'TowerStatus',
  'TowerTeardown',
] as const;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export function isDefaultToolEnabled(config: AppToolsConfig | undefined, name: string): boolean {
  const enabled = config?.enabled;
  const allowed = enabled === undefined || enabled.length === 0 || enabled.includes(name);
  return allowed && !(config?.disabled ?? []).includes(name);
}

export function setDefaultToolEnabled(
  config: AppToolsConfig | undefined,
  name: string,
  enabled: boolean,
): AppToolsConfig {
  const allowlist = config?.enabled;
  return {
    enabled: allowlist === undefined
      ? undefined
      : enabled && allowlist.length > 0
        ? sortedUnique([...allowlist, name])
        : sortedUnique(allowlist),
    disabled: enabled
      ? sortedUnique((config?.disabled ?? []).filter((candidate) => candidate !== name))
      : sortedUnique([...(config?.disabled ?? []), name]),
  };
}

export function rebaseDefaultToolsConfig(
  base: AppToolsConfig | undefined,
  draft: AppToolsConfig,
  next: AppToolsConfig | undefined,
): AppToolsConfig {
  const candidates = new Set([
    ...(base?.enabled ?? []),
    ...(base?.disabled ?? []),
    ...(draft.enabled ?? []),
    ...(draft.disabled ?? []),
  ]);
  let rebased: AppToolsConfig = {
    enabled: next?.enabled === undefined ? undefined : [...next.enabled],
    disabled: next?.disabled === undefined ? undefined : [...next.disabled],
  };
  for (const name of candidates) {
    if (isDefaultToolEnabled(base, name) === isDefaultToolEnabled(draft, name)) continue;
    rebased = setDefaultToolEnabled(rebased, name, isDefaultToolEnabled(draft, name));
  }
  return rebased;
}
