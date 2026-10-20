import type { HookRegistration } from '../contract/hook';

export const MAX_STEPS_REASON = 'max_steps';

export function createMaxStepsHook(getMaxSteps: () => number | undefined): HookRegistration {
  return {
    point: 'step.continuing',
    id: 'max-steps',
    onFailure: 'block',
    hook: ({ step }) => {
      const maxSteps = getMaxSteps();
      if (maxSteps === undefined || step < maxSteps) return undefined;
      return {
        type: 'blocked',
        cause: { reason: MAX_STEPS_REASON, message: `Turn reached maxSteps=${maxSteps}.`, details: { maxSteps } },
      };
    },
  };
}
