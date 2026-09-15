import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const WAIT_FOR_FLAG_ID = 'wait_for';
export const WAIT_FOR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_WAIT_FOR';

export const waitForFlag: FlagDefinitionInput = {
  id: WAIT_FOR_FLAG_ID,
  title: 'WaitFor tool',
  description:
    'Give the model the WaitFor tool so it can wait for background tasks inside the current turn instead of ending the turn and being re-invoked.',
  env: WAIT_FOR_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(waitForFlag);
