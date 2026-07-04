/**
 * `auth` domain (cross-cutting) — app-scope OAuth + auth summary contracts.
 *
 * Defines the public contracts of authentication: the `AuthStatus` model, the
 * `IOAuthService` used to drive device-code login / logout / flow inspection,
 * to resolve a per-provider `BearerTokenProvider`, and to refresh a managed
 * OAuth provider's server-side model configuration, the `IOAuthToolkit`
 * device-code client that `IOAuthService` delegates the OAuth protocol to, and
 * the `IAuthSummaryService` used to summarize auth state and assert readiness.
 * App-scoped — shared across the application.
 */

import type {
  BearerTokenProvider,
  KimiOAuthLoginOptions,
  KimiOAuthLoginResult,
  KimiOAuthLogoutResult,
  KimiOAuthTokenRef,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { OAuthRef } from '#/app/provider/provider';

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

export interface IOAuthService {
  readonly _serviceBrand: undefined;

  startLogin(provider?: string): Promise<OAuthFlowStart>;
  getFlow(provider?: string): OAuthFlowSnapshot | undefined;
  cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
  logout(provider?: string): Promise<OAuthLogoutResponse>;
  status(provider?: string): Promise<AuthStatus>;
  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined;
  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined>;
}

export const IOAuthService: ServiceIdentifier<IOAuthService> =
  createDecorator<IOAuthService>('oauthService');

export interface IOAuthToolkit {
  readonly _serviceBrand: undefined;

  login(providerName?: string, options?: KimiOAuthLoginOptions): Promise<KimiOAuthLoginResult>;
  logout(providerName?: string, oauthRef?: KimiOAuthTokenRef): Promise<KimiOAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): Promise<string | undefined>;
  tokenProvider(providerName?: string, oauthRef?: KimiOAuthTokenRef): BearerTokenProvider;
}

export const IOAuthToolkit: ServiceIdentifier<IOAuthToolkit> =
  createDecorator<IOAuthToolkit>('oauthToolkit');

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  summarize(): Promise<readonly AuthStatus[]>;
  ensureReady(provider?: string): Promise<void>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');
