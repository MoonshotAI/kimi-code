import { DeviceCodeTimeoutError, OAuthError, type DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';

import type { CatalogOAuthRef } from '#/features/provider-catalog/index';

export const LOGIN_TERMINAL_RETENTION_MS = 5 * 60 * 1000;
export const LOGIN_DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;

export type OAuthFlowStatus = 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';

export interface OAuthFlowStartPending {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: 'pending';
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly interval: number;
  readonly expires_at: string;
}

export interface OAuthFlowStartAuthenticated {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: 'authenticated';
}

export type OAuthFlowStart = OAuthFlowStartPending | OAuthFlowStartAuthenticated;

export interface OAuthFlowSnapshot {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: OAuthFlowStatus;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly expires_at: string;
  readonly interval: number;
  readonly resolved_at?: string;
  readonly error_message?: string;
}

export interface OAuthLoginCancelResult {
  readonly cancelled: boolean;
  readonly status: OAuthFlowStatus;
}

export interface OAuthLogoutResult {
  readonly logged_out: true;
  readonly provider: string;
}

export interface OAuthLoginStartInput {
  readonly provider?: string;
  readonly region?: 'mainland-cn' | 'global';
}

export type ManagedProviderStatus = 'authenticated' | 'expired' | 'revoked' | 'unauthenticated';

export interface ManagedProviderSummary {
  readonly name: string;
  readonly status: ManagedProviderStatus;
}

export interface AuthSummary {
  readonly models_ready: boolean;
  readonly providers_count: number;
  readonly managed_provider: ManagedProviderSummary | null;
}

export interface LoginFlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: CatalogOAuthRef | undefined;
  readonly loginBaseUrl: string | undefined;
  readonly startedAt: number;
  device: DeviceAuthorization | undefined;
  status: OAuthFlowStatus;
  tokenGranted: boolean;
  expiresAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  errorMessage: string | undefined;
  resolvedAt: string | undefined;
}

export function toFlowStart(state: LoginFlowState, device: DeviceAuthorization): OAuthFlowStartPending {
  const expiresIn = device.expiresIn ?? LOGIN_DEFAULT_DEVICE_EXPIRES_IN_SEC;
  return {
    flow_id: state.flowId,
    provider: state.provider,
    verification_uri: device.verificationUri,
    verification_uri_complete: device.verificationUriComplete,
    user_code: device.userCode,
    expires_in: expiresIn,
    interval: device.interval,
    status: 'pending',
    expires_at: new Date(state.expiresAt).toISOString(),
  };
}

export function toFlowSnapshot(state: LoginFlowState, device: DeviceAuthorization): OAuthFlowSnapshot {
  return {
    ...toFlowStart(state, device),
    status: state.status,
    resolved_at: state.resolvedAt,
    error_message: state.errorMessage,
  };
}

export function classifyLoginFailure(error: unknown): Exclude<OAuthFlowStatus, 'pending'> {
  if (error instanceof DeviceCodeTimeoutError) return 'expired';
  if (error instanceof OAuthError) {
    return error.message.toLowerCase().includes('aborted') ? 'cancelled' : 'denied';
  }
  return 'denied';
}
