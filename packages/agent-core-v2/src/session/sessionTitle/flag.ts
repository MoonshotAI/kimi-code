/**
 * `sessionTitle` domain — experimental flag for AI session title generation.
 *
 * Gates every `generateTitle` entry point (the kap-server route, klient, and
 * through them the desktop/web auto trigger and rename-field action). Off by
 * default; enable via `KIMI_CODE_EXPERIMENTAL_AUTO_SESSION_TITLE`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AUTO_SESSION_TITLE_FLAG_ID = 'auto_session_title';
export const AUTO_SESSION_TITLE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AUTO_SESSION_TITLE';

export const sessionTitleFlag: FlagDefinitionInput = {
  id: AUTO_SESSION_TITLE_FLAG_ID,
  title: 'AI session titles',
  description:
    'Generate concise session titles from the conversation through the managed chat_title tool: clients auto-generate once the first turn completes and offer on-demand regeneration in the rename field.',
  env: AUTO_SESSION_TITLE_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(sessionTitleFlag);
