import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const NOTIFY_USER_FLAG_ID = 'notify_user';
export const NOTIFY_USER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER';

export const notifyUserFlag: FlagDefinitionInput = {
  id: NOTIFY_USER_FLAG_ID,
  title: 'NotifyUser tool',
  description:
    'Show live progress updates from the main agent and subagents in the TUI Updates panel.',
  env: NOTIFY_USER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(notifyUserFlag);
