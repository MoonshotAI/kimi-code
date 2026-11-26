import { BusinessMembershipRevokedError } from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import type { ErrorCode } from '#/errors';

import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import { nonEmpty } from '#/provider-catalog/model/model-auth';
import { IModelOAuthTokens } from '#/provider-catalog/model/model-oauth';
import type { OAuthRef } from '#/provider-catalog/provider/provider';

export class ModelOAuthTokenAdapter implements IModelOAuthTokens {
  declare readonly _serviceBrand: undefined;

  constructor(@IOAuthService private readonly oauth: IOAuthService) {}

  async hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean> {
    try {
      const token = await this.oauth.getCachedAccessToken(provider, oauthRef);
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }

  async getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string> {
    const tokenProvider = this.oauth.resolveTokenProvider(provider, oauthRef);
    if (tokenProvider === undefined) throw loginRequired(provider);
    try {
      const token = await tokenProvider.getAccessToken(
        options?.force === true ? { force: true } : undefined,
      );
      if (token.trim().length === 0) throw loginRequired(provider);
      return token;
    } catch (error) {
      if (error instanceof BusinessMembershipRevokedError) {
        throw Object.assign(
          new Error2('provider.auth_error' as ErrorCode, error.message, {
            details: { statusCode: 401, providerErrorCode: error.reasonCode },
          }),
          { statusCode: 401, retryable: false },
        );
      }
      throw error;
    }
  }
}

function loginRequired(providerKey: string): Error2 {
  return new Error2(
    AuthErrors.codes.AUTH_LOGIN_REQUIRED,
    `OAuth provider "${providerKey}" requires login before it can be used.`,
  );
}

registerScopedService(
LifecycleScope.App,
  IModelOAuthTokens,
  ModelOAuthTokenAdapter,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
