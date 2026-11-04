import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { SESSION2SESSION_FLAG_ID } from './session2session';

export const SESSION2SESSION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SESSION2SESSION';
export const SESSION2SESSION_DEFAULT_ENABLED = true;

export const session2sessionFlag: FlagDefinitionInput = {
  id: SESSION2SESSION_FLAG_ID,
  title: 'Session-to-session messaging',
  description: 'Enable tools for asynchronous messaging and replies between independent sessions.',
  env: SESSION2SESSION_FLAG_ENV,
  default: SESSION2SESSION_DEFAULT_ENABLED,
  surface: 'both',
};

registerFlagDefinition(session2sessionFlag);
