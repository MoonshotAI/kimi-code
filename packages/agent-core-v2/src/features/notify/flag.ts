import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const NOTIFY_USER_FLAG_ID = 'notify_user';
export const NOTIFY_USER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER';

export const notifyUserFlag: FlagDefinitionInput = {
  id: NOTIFY_USER_FLAG_ID,
  title: 'NotifyUser tool',
  description:
    'Give the model the NotifyUser tool so it can show the user short progress updates while a turn is still running. Only hosts that render the update panel (the TUI) offer the tool.',
  env: NOTIFY_USER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(notifyUserFlag);
