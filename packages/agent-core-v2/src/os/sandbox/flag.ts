import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from '#/app/flag/flagRegistry';

export const SANDBOX_FLAG_ID = 'sandbox';
export const SANDBOX_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SANDBOX';

export const sandboxFlag: FlagDefinitionInput = {
  id: SANDBOX_FLAG_ID,
  title: 'OS sandbox for agent commands',
  description:
    'Run agent-initiated shell commands inside an OS sandbox (macOS Seatbelt, Linux bubblewrap) with restricted filesystem and network access.',
  env: SANDBOX_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(sandboxFlag);
