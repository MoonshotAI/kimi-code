import type { OAuthFlowConfig } from './types';

export const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';

export const KIMI_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost:
    process.env['KIMI_CODE_OAUTH_HOST'] ??
    process.env['KIMI_OAUTH_HOST'] ??
    DEFAULT_KIMI_CODE_OAUTH_HOST,
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};
