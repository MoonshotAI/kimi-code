/**
 * `multi_server` experimental flag — gates the multi-server shared-homedir work.
 *
 * When enabled, a kap-server instance registers itself under
 * `<home>/server/instances/<serverId>.json` instead of taking the legacy
 * single-instance `<home>/server/lock`, so multiple servers can share one home
 * directory. Off by default; enable via `KIMI_CODE_EXPERIMENTAL_MULTI_SERVER`,
 * the master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section. Imported for its side effect (registers the definition) from the
 * package barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MULTI_SERVER_FLAG_ID = 'multi_server';
export const MULTI_SERVER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MULTI_SERVER';

export const multiServerFlag: FlagDefinitionInput = {
  id: MULTI_SERVER_FLAG_ID,
  title: 'multi-server shared home',
  description:
    'Allow multiple kap-server instances to share one home directory by registering each instance under server/instances/ instead of taking a single homedir lock.',
  env: MULTI_SERVER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(multiServerFlag);
