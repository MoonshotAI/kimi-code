import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SESSION_MENTIONS_FLAG_ID = 'session_mentions';
export const SESSION_MENTIONS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS';

export const SIDEBAR_MULTI_TAB_FLAG_ID = 'sidebar_multi_tab';
export const SIDEBAR_MULTI_TAB_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SIDEBAR_MULTI_TAB';

export const sessionMentionsFlag: FlagDefinitionInput = {
  id: SESSION_MENTIONS_FLAG_ID,
  title: 'Session mentions',
  description:
    'Search for and reference other sessions from the @ menu so the agent can read referenced session logs.',
  env: SESSION_MENTIONS_FLAG_ENV,
  stages: {
    desktop: 'experimental',
    web: 'experimental',
  },
  effectTiming: 'immediate',
};

export const sidebarMultiTabFlag: FlagDefinitionInput = {
  id: SIDEBAR_MULTI_TAB_FLAG_ID,
  title: 'Tabbed session list',
  description: 'Split the session sidebar into Open, Done, and Projects tabs.',
  env: SIDEBAR_MULTI_TAB_FLAG_ENV,
  stages: {
    desktop: 'experimental',
    web: 'experimental',
  },
  effectTiming: 'immediate',
};

registerFlagDefinition(sessionMentionsFlag);
registerFlagDefinition(sidebarMultiTabFlag);
