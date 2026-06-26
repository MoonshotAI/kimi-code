/**
 * `auth` domain (cross-cutting) — core-scope OAuth + auth summary contracts.
 *
 * Defines the public contracts of authentication: the `AuthStatus` model, the
 * `IOAuthService` used to drive device-code login / logout / flow inspection
 * and to resolve a per-provider `BearerTokenProvider`, and the
 * `IAuthSummaryService` used to summarize auth state and assert readiness.
 * Core-scoped — shared across the application.
 */

import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { OAuthRef } from '#/provider/provider';

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
  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined;
}

export const IOAuthService: ServiceIdentifier<IOAuthService> =
  createDecorator<IOAuthService>('oauthService');

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;
  summarize(): Promise<readonly AuthStatus[]>;
  ensureReady(provider?: string): Promise<void>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');
