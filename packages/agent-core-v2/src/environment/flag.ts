import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const REMOTE_RUNTIME_FLAG_ID = 'remote_runtime';
export const REMOTE_RUNTIME_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME';

export const remoteRuntimeFlag: FlagDefinitionInput = {
  id: REMOTE_RUNTIME_FLAG_ID,
  title: 'Remote environment',
  description:
    'Allow binding sessions to remote environments (SSH hosts and containers) declared in config, so agent tools execute in the target environment instead of the local machine.',
  env: REMOTE_RUNTIME_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(remoteRuntimeFlag);
