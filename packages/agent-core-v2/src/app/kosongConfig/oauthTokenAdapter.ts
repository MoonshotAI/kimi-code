/**
 * `kosongConfig` domain (L3) — `IModelOAuthTokens` implementation.
 *
 * Delegates kosong's OAuth token port to `IOAuthService` and owns the
 * `auth.login_required` error contract (the code is registered by
 * `app/auth/errors`): kosong's model catalog only sees the port.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';

import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import { nonEmpty } from '#/kosong/model/modelAuth';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import type { OAuthRef } from '#/kosong/provider/provider';

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
    const token = await tokenProvider.getAccessToken(
      options?.force === true ? { force: true } : undefined,
    );
    if (token.trim().length === 0) throw loginRequired(provider);
    return token;
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
  InstantiationType.Eager,
  'kosongConfig',
);
