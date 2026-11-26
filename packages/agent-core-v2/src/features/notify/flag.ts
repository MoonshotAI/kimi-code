import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const NOTIFY_USER_FLAG_ID = 'notify_user';
export const NOTIFY_USER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER';

export const NOTIFY_USER_APP_FLAG_ID = 'notify_user_app';
export const NOTIFY_USER_APP_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER_APP';

export const notifyUserFlag: FlagDefinitionInput = {
  id: NOTIFY_USER_FLAG_ID,
  title: 'NotifyUser tool',
  description:
    'Show live progress updates from the main agent and subagents in the Updates panel.',
  env: NOTIFY_USER_FLAG_ENV,
  stages: {
    tui: 'experimental',
  },
  effectTiming: 'next-session',
};

export const notifyUserAppFlag: FlagDefinitionInput = {
  id: NOTIFY_USER_APP_FLAG_ID,
  title: 'Progress updates',
  description:
    'Show live progress rows from the main agent and subagents in desktop and web conversations.',
  env: NOTIFY_USER_APP_FLAG_ENV,
  fallbackEnv: NOTIFY_USER_FLAG_ENV,
  stages: {
    desktop: 'experimental',
    web: 'experimental',
  },
  effectTiming: 'next-session',
};

registerFlagDefinition(notifyUserFlag);
registerFlagDefinition(notifyUserAppFlag);
