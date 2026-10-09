import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MONITOR_FLAG_ID = 'monitor';
export const MONITOR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MONITOR';

export const monitorFlag: FlagDefinitionInput = {
  id: MONITOR_FLAG_ID,
  title: 'Monitor tool',
  description:
    'Give the main agent the Monitor tool: a background command whose stdout lines reach the model as notifications while it keeps working.',
  env: MONITOR_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(monitorFlag);
