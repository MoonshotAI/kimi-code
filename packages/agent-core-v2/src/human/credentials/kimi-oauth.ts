import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import { createOAuthCredentialProvider } from '#/credentials/credentials';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

export function kimiOAuthCredentialProvider(tokens: BearerTokenProvider): LlmCredentialProvider {
  return createOAuthCredentialProvider((options) => tokens.getAccessToken(options));
}
