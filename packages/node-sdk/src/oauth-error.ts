import { ErrorCodes, KimiError } from '#/errors';
import {
  OAuthConnectionError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from '@moonshot-ai/kimi-code-oauth';

export function mapOAuthTokenError(error: unknown, providerName: string): KimiError | undefined {
  if (error instanceof OAuthUnauthorizedError) {
    return new KimiError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `OAuth provider "${providerName}" requires login before it can be used.`,
      { cause: error },
    );
  }
  if (error instanceof OAuthConnectionError || error instanceof RetryableRefreshError) {
    return new KimiError(
      ErrorCodes.PROVIDER_CONNECTION_ERROR,
      `OAuth provider "${providerName}" failed to fetch an access token: ${error.message}`,
      { cause: error },
    );
  }
  return undefined;
}
