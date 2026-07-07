import { ErrorCodes, KimiError } from '@moonshot-ai/agent-core';
import {
  OAuthConnectionError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from '@moonshot-ai/kimi-code-oauth';

/**
 * Classify an OAuth token-fetch failure into the public {@link KimiError}
 * protocol so callers (turn serialization, SDK clients, ACP) can react on
 * `code` rather than on class identity.
 *
 * Only errors we can positively identify are mapped:
 *  - `OAuthUnauthorizedError` → `auth.login_required` (drive the user through
 *    `/login`).
 *  - `OAuthConnectionError` / `RetryableRefreshError` →
 *    `provider.connection_error` (transient; the user can retry).
 *
 * Anything else returns `undefined` so the caller rethrows it raw and lets it
 * surface as `internal` with the original message preserved. We deliberately do
 * **not** guess a category for unrecognized errors — masking e.g. a storage or
 * lock failure as `auth.login_required` would send the user down the wrong
 * remediation path.
 */
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
