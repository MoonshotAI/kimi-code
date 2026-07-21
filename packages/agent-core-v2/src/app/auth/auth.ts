/**
 * `auth` domain (cross-cutting) — app-scope OAuth + auth summary contracts.
 *
 * Defines the public contracts of authentication: the `AuthStatus` model, the
 * `IOAuthService` used to drive device-code login / logout / flow inspection,
 * to resolve a per-provider `BearerTokenProvider`, and to refresh a managed
 * OAuth provider's server-side model configuration, the `IOAuthToolkit`
 * device-code client that `IOAuthService` delegates the OAuth protocol to, and
 * the `IAuthSummaryService` used to summarize auth state and provide the
 * prompt auth-readiness gate. App-scoped — shared across the application.
 */

import type {
  BearerTokenProvider,
  KimiOAuthLoginOptions,
  KimiOAuthLoginResult,
  KimiOAuthLogoutResult,
  KimiOAuthTokenRef,
} from '@moonshot-ai/kimi-code-oauth';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';

import type { OAuthRef } from '#/kosong/provider/provider';

import { AuthErrors } from './errors';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from './oauthProtocol';

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
  ensureReady(modelOverride?: string): Promise<void>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');

export class AuthProvisioningRequiredError extends Error2 {
  constructor() {
    super(
      AuthErrors.codes.AUTH_PROVISIONING_REQUIRED,
      'no provider configured; complete onboarding via /login or the providers endpoint',
      { name: 'AuthProvisioningRequiredError' },
    );
  }
}

export class AuthTokenMissingError extends Error2 {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      AuthErrors.codes.AUTH_TOKEN_MISSING,
      `provider ${providerId} has no credential configured`,
      { details: { provider_id: providerId }, name: 'AuthTokenMissingError' },
    );
    this.providerId = providerId;
  }
}

export class AuthModelNotResolvedError extends Error2 {
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;

  constructor(modelId: string | undefined, providerId?: string) {
    const details: Record<string, unknown> = {};
    if (modelId !== undefined) details['model_id'] = modelId;
    if (providerId !== undefined) details['provider_id'] = providerId;
    super(
      AuthErrors.codes.AUTH_MODEL_NOT_RESOLVED,
      modelId === undefined
        ? 'no default model configured'
        : `model ${modelId} does not resolve to a configured provider`,
      {
        details: Object.keys(details).length === 0 ? undefined : details,
        name: 'AuthModelNotResolvedError',
      },
    );
    this.modelId = modelId;
    this.providerId = providerId;
  }
}
