/**
 * Builtin loop hooks.
 */
import type { HookRegistration, StepContinuingEvent } from '../contract/hook';

export const MAX_STEPS_REASON = 'max_steps';

export function createMaxStepsHook(
  getMaxSteps: () => number | undefined,
  shouldBypass: (event: StepContinuingEvent) => boolean = () => false,
): HookRegistration {
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
