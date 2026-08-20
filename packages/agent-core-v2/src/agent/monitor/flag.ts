import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MONITOR_FLAG_ID = 'monitor';
export const MONITOR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MONITOR';

export const monitorFlag: FlagDefinitionInput = {
  id: MONITOR_FLAG_ID,
  title: 'Monitor (event-driven watchers)',
  description:
    'Let the agent register one-shot listeners on background task output, arbitrary shell commands, and file changes; a match pushes a notification back into the main loop instead of polling.',
  env: MONITOR_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(monitorFlag);
