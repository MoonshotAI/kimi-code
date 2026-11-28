import type { LoopHooks, StepContinuingEvent } from '#/loop/contract/hook';
import { MAX_STEPS_REASON } from '#/loop/contract/outcome';
import type { BlockingHookRegistration } from '#/hook/registry';

export function createMaxStepsHook(
  getMaxSteps: () => number | undefined,
  shouldBypass: (event: StepContinuingEvent) => boolean = () => false,
): BlockingHookRegistration<LoopHooks, 'step.continuing'> {
  return {
    point: 'step.continuing',
    id: 'max-steps',
    onFailure: 'block',
    hook: (event) => {
      const maxSteps = getMaxSteps();
      if (maxSteps === undefined || maxSteps === 0 || event.step < maxSteps || shouldBypass(event)) return undefined;
      return {
        type: 'blocked',
        cause: { reason: MAX_STEPS_REASON, message: `Turn reached maxSteps=${maxSteps}.`, details: { maxSteps } },
      };
    },
  };
}
