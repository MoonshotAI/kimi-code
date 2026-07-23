/**
 * `kosong/model` domain (L2) — the OAuth token port.
 *
 * Kosong needs OAuth tokens at model-assembly time: probing the cached
 * credential state (catalog listings) and building the refreshable request
 * auth closure. The port is owned here so kosong stays free of the
 * `app/auth` service; the implementation lives in the upper layer
 * (`app/kosongConfig/oauthTokenAdapter.ts`), which delegates to
 * `IOAuthService` and owns the `auth.login_required` error contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { OAuthRef } from '../provider/provider';

export interface IModelOAuthTokens {
  readonly _serviceBrand: undefined;

  /** Probes whether a usable cached token exists (never throws). */
  hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean>;
  /**
   * Returns a usable access token, refreshing when needed. Throws
   * `auth.login_required` when the provider is not logged in.
   */
  getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string>;
}

export const IModelOAuthTokens: ServiceIdentifier<IModelOAuthTokens> =
  createDecorator<IModelOAuthTokens>('modelOAuthTokens');
