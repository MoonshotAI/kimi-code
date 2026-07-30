import {
  WORKING_TIPS,
  getWorkingTips,
  tipsConfigVersion,
  type ToolbarTip,
} from '#/tui/constant/tips';

import { buildWeightedTips } from './footer';

export { WORKING_TIPS };

const TIP_ROTATE_INTERVAL_MS = 10_000;

/**
 * Rotation over the effective working tips (built-ins plus/minus custom tips
 * from `[tips]` in tui.toml). Memoized against `tipsConfigVersion()` so a
 * `/reload-tui` that changes tips rebuilds the rotation exactly once.
 */
let rotationCache: { version: number; rotation: readonly ToolbarTip[] } | null = null;

function getRotation(): readonly ToolbarTip[] {
  const version = tipsConfigVersion();
  if (rotationCache === null || rotationCache.version !== version) {
    rotationCache = { version, rotation: buildWeightedTips(getWorkingTips()) };
  }
  return rotationCache.rotation;
}

export function currentWorkingTip(now = Date.now()): ToolbarTip | undefined {
  const rotation = getRotation();
  if (rotation.length === 0) return undefined;
  const index = Math.floor(now / TIP_ROTATE_INTERVAL_MS) % rotation.length;
  return rotation[index];
}

/**
 * Pick a random tip from the weighted working-tip rotation.
 * If `excludeText` is provided and there are other tips available, avoid
 * returning the same text twice in a row.
 */
export function pickRandomWorkingTip(excludeText?: string): ToolbarTip | undefined {
  const rotation = getRotation();
  if (rotation.length === 0) return undefined;
  const candidates =
    excludeText === undefined || rotation.length === 1
      ? rotation
      : rotation.filter((t) => t.text !== excludeText);
  const pool = candidates.length > 0 ? candidates : rotation;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}
