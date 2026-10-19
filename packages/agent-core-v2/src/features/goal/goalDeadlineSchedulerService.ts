import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';

import { IGoalDeadlineScheduler } from './goalDeadlineScheduler';

export class GoalDeadlineSchedulerService implements IGoalDeadlineScheduler {
  declare readonly _serviceBrand: undefined;

  now(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  schedule(delayMs: number, callback: () => void): IDisposable {
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timeout = undefined;
      callback();
    }, Math.max(0, delayMs));
    timeout.unref?.();
    return toDisposable(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    });
  }
}
