/**
 * `remoteControl` domain — experimental device tunnel gate.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const REMOTE_CONTROL_FLAG_ID = 'remote_control';
export const REMOTE_CONTROL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL';

export const remoteControlFlag: FlagDefinitionInput = {
  id: REMOTE_CONTROL_FLAG_ID,
  title: 'Remote Control',
  description: 'Allow an authenticated relay to proxy this local Kimi Code server.',
  env: REMOTE_CONTROL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(remoteControlFlag);
