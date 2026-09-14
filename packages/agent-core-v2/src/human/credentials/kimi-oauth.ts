import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import { oauthCredentials } from '#/credentials/credentials';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

export function kimiOAuthCredentialProvider(tokens: BearerTokenProvider): LlmCredentialProvider {
  return oauthCredentials((options) => tokens.getAccessToken(options));
}
