export interface ArtexTaskClock {
  readonly deadlineUnixSec: number;
  readonly final: boolean;
}

export const ARTEX_NO_TASK_CLOCK: ArtexTaskClock = { deadlineUnixSec: 0, final: false };

export function deadlineFromTimeout(timeoutSeconds: number, nowMs: number = Date.now()): number {
  if (timeoutSeconds <= 0) return 0;
  return Math.floor(nowMs / 1000) + timeoutSeconds;
}

export interface ClampMaxDurationResult {
  readonly effMs: number;
  readonly clamped: boolean;
}

export function clampMaxDuration(
  deadlineUnixSec: number,
  ownBudgetMs: number,
  nowMs: number = Date.now(),
): ClampMaxDurationResult {
  if (deadlineUnixSec <= 0) {
    return { effMs: ownBudgetMs, clamped: false };
  }
  let remainingMs = deadlineUnixSec * 1000 - nowMs;
  if (remainingMs < 1000) {
    remainingMs = 1000;
  }
  const clamped = ownBudgetMs <= 0 || remainingMs <= ownBudgetMs;
  let effMs = remainingMs;
  if (ownBudgetMs > 0 && ownBudgetMs < remainingMs) {
    effMs = ownBudgetMs;
  }
  return { effMs, clamped };
}
