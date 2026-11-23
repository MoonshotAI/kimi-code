import { powerSaveBlocker } from 'electron';
import type { SleepPreventionMode } from '../../shared/prevent-sleep';

let blockerId: number | undefined;
let mode: SleepPreventionMode = 'allow-sleep';

export function setPowerSaveBlockerMode(next: SleepPreventionMode): void {
  if (mode === next) return;
  const nextId = next === 'allow-sleep' ? undefined : powerSaveBlocker.start(next);
  if (blockerId !== undefined) powerSaveBlocker.stop(blockerId);
  blockerId = nextId;
  mode = next;
}

export function getPowerSaveBlockerMode(): SleepPreventionMode {
  return mode;
}

export function isPowerSaveBlockerEnabled(): boolean {
  return blockerId !== undefined;
}
