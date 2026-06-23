import { WORKING_TIPS, type ToolbarTip } from '#/tui/constant/tips';

import { buildWeightedTips } from './footer';

export { WORKING_TIPS };

const TIP_ROTATE_INTERVAL_MS = 10_000;

const WORKING_TIP_ROTATION = buildWeightedTips(WORKING_TIPS);

export function currentWorkingTip(now = Date.now()): ToolbarTip | undefined {
  if (WORKING_TIP_ROTATION.length === 0) return undefined;
  const index = Math.floor(now / TIP_ROTATE_INTERVAL_MS) % WORKING_TIP_ROTATION.length;
  return WORKING_TIP_ROTATION[index];
}
