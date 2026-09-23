import { type FlagDefinitionInput, registerFlagDefinition } from '@moonshot-ai/agent-core-v2';

export const WEB_MULTI_SESSION_FLAG_ID = 'web_multi_session';
export const WEB_MULTI_SESSION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_WEB_MULTI_SESSION';

export const webMultiSessionFlag: FlagDefinitionInput = {
  id: WEB_MULTI_SESSION_FLAG_ID,
  title: 'Web multi-session',
  description:
    'Let the kimi web server resume sessions on WebSocket subscribe, resume or list live sessions in batch, and unload idle sessions beyond [server] max_live_sessions or session_idle_timeout_ms.',
  env: WEB_MULTI_SESSION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(webMultiSessionFlag);
