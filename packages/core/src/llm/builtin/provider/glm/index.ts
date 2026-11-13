import { createRequester } from '#/llm/requester';

import { glmProtocol } from './protocol';

export { glmProtocol, inferGlmCapability } from './protocol';

export const GLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const GLM_ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

export const glmRequester = createRequester().with({
  protocol: { base: glmProtocol, options: { reasoningKey: 'reasoning_content' } },
  endpoint: {
    defaultBaseUrl: GLM_DEFAULT_BASE_URL,
  },
});
