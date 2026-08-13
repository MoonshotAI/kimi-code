import type { OAuthFlowConfig } from './types';

export const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';

/** Node-side env override lookup. Browser consumers of the ./device entry have
    no `process` global; without the guard the bare reference would throw at
    module load, and they always land on the default host anyway. */
function envOverride(key: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env[key];
}

export const KIMI_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost:
    envOverride('KIMI_CODE_OAUTH_HOST') ??
    envOverride('KIMI_OAUTH_HOST') ??
    DEFAULT_KIMI_CODE_OAUTH_HOST,
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};
