/**
 * `auth` domain (cross-cutting) — `IOAuthService` / `IAuthSummaryService`
 * implementation.
 *
 * Owns the device-code OAuth flows and the auth readiness view; reads the
 * `providers` config section through `config`, locates token storage through
 * `environment`, reports through `telemetry`, and delegates token storage,
 * refresh, and the device-code protocol to `@moonshot-ai/kimi-code-oauth`.
 * Bound at Core scope.
 */

import { randomUUID } from 'node:crypto';

import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OAuthError,
  type BearerTokenProvider,
  type DeviceAuthorization,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { IEnvironmentService } from '#/environment/environment';
import { ITelemetryService } from '#/telemetry/telemetry';

import { type AuthStatus, IAuthSummaryService, IOAuthService } from './auth';
import {
  type OAuthRef,
  type ProvidersSection,
  PROVIDERS_SECTION,
  ProvidersSectionSchema,
} from './oauthSchemas';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  device: DeviceAuthorization | undefined;
  status: OAuthFlowStatus;
  expiresAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  errorMessage: string | undefined;
  resolvedAt: string | undefined;
}

export class OAuthService extends Disposable implements IOAuthService {
  declare readonly _serviceBrand: undefined;
  private readonly toolkit: KimiOAuthToolkit;
  private readonly flows = new Map<string, FlowState>();

  constructor(
    toolkit: KimiOAuthToolkit | undefined = undefined,
    @IConfigRegistry registry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
    @IEnvironmentService env: IEnvironmentService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    registry.registerSection(PROVIDERS_SECTION, ProvidersSectionSchema, { defaultValue: {} });
    this.toolkit = toolkit ?? new KimiOAuthToolkit({ homeDir: env.homeDir });
    this._register(
      config.onDidChange((e) => {
        if (e.domain === PROVIDERS_SECTION) {
          this.invalidateFlows();
        }
      }),
    );
  }

  async startLogin(provider = KIMI_CODE_PROVIDER_NAME): Promise<OAuthFlowStart> {
    const oauthRef = this.readOAuthRef(provider);
    this.abortExisting(provider);

    const state: FlowState = {
      flowId: `oauth_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      device: undefined,
      status: 'pending',
      expiresAt: Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
      gcTimer: undefined,
      errorMessage: undefined,
      resolvedAt: undefined,
    };
    this.flows.set(provider, state);

    let resolveDevice!: (auth: DeviceAuthorization) => void;
    const deviceReady = new Promise<DeviceAuthorization>((resolve) => {
      resolveDevice = resolve;
    });

    const loginPromise = this.toolkit.login(provider, {
      signal: state.controller.signal,
      oauthRef,
      onDeviceCode: (auth) => {
        state.device = auth;
        if (auth.expiresIn !== null) {
          state.expiresAt = Date.now() + auth.expiresIn * 1000;
        }
        resolveDevice(auth);
      },
    });
    loginPromise.then(
      () => this.handleSuccess(state),
      (error) => this.handleFailure(state, error),
    );

    const device = await deviceReady;
    return this.toFlowStart(state, device);
  }

  getFlow(provider = KIMI_CODE_PROVIDER_NAME): OAuthFlowSnapshot | undefined {
    const state = this.flows.get(provider);
    if (state === undefined || state.device === undefined) return undefined;
    return this.toSnapshot(state, state.device);
  }

  cancelLogin(provider = KIMI_CODE_PROVIDER_NAME): Promise<OAuthLoginCancelResponse> {
    const state = this.flows.get(provider);
    if (state === undefined || state.status !== 'pending') {
      return Promise.resolve({ cancelled: false, status: state?.status ?? 'cancelled' });
    }
    state.controller.abort();
    this.setTerminal(state, 'cancelled');
    return Promise.resolve({ cancelled: true, status: 'cancelled' });
  }

  async logout(provider = KIMI_CODE_PROVIDER_NAME): Promise<OAuthLogoutResponse> {
    const oauthRef = this.readOAuthRefOptional(provider);
    await this.toolkit.logout(provider, oauthRef);
    this.abortExisting(provider);
    return { logged_out: true, provider };
  }

  async status(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthStatus> {
    const oauthRef = this.readOAuthRefOptional(provider);
    const token = await this.toolkit.getCachedAccessToken(provider, oauthRef);
    return token === undefined ? { loggedIn: false } : { loggedIn: true, provider };
  }

  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined {
    return this.toolkit.tokenProvider(provider, oauthRef);
  }

  private readOAuthRef(provider: string): OAuthRef {
    const providers = this.config.get<ProvidersSection>(PROVIDERS_SECTION);
    const oauth = providers?.[provider]?.oauth;
    if (oauth === undefined) {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `Provider "${provider}" is not configured for OAuth.`,
      );
    }
    return oauth;
  }

  private readOAuthRefOptional(provider: string): OAuthRef | undefined {
    const providers = this.config.get<ProvidersSection>(PROVIDERS_SECTION);
    return providers?.[provider]?.oauth;
  }

  private abortExisting(provider: string): void {
    const existing = this.flows.get(provider);
    if (existing !== undefined && existing.status === 'pending') {
      existing.controller.abort();
      this.setTerminal(existing, 'cancelled');
    }
  }

  private invalidateFlows(): void {
    for (const state of this.flows.values()) {
      if (state.status === 'pending') {
        state.controller.abort();
      }
      if (state.gcTimer !== undefined) {
        clearTimeout(state.gcTimer);
      }
    }
    this.flows.clear();
  }

  private handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return;
    this.setTerminal(state, 'authenticated');
  }

  private handleFailure(state: FlowState, err: unknown): void {
    if (state.status !== 'pending') return;
    state.errorMessage = err instanceof Error ? err.message : String(err);
    this.setTerminal(state, classifyFailure(err));
  }

  private setTerminal(state: FlowState, status: OAuthFlowStatus): void {
    state.status = status;
    state.resolvedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      if (this.flows.get(state.provider) === state) {
        this.flows.delete(state.provider);
      }
    }, TERMINAL_RETENTION_MS);
    timer.unref();
    state.gcTimer = timer;
  }

  private toFlowStart(state: FlowState, device: DeviceAuthorization): OAuthFlowStart {
    const expiresIn = device.expiresIn ?? DEFAULT_DEVICE_EXPIRES_IN_SEC;
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

  private toSnapshot(state: FlowState, device: DeviceAuthorization): OAuthFlowSnapshot {
    return {
      ...this.toFlowStart(state, device),
      status: state.status,
      resolved_at: state.resolvedAt,
      error_message: state.errorMessage,
    };
  }
}

export class AuthSummaryService implements IAuthSummaryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  async summarize(): Promise<readonly AuthStatus[]> {
    const providers = this.config.get<ProvidersSection>(PROVIDERS_SECTION) ?? {};
    const statuses: AuthStatus[] = [];
    for (const [name, providerConfig] of Object.entries(providers)) {
      if (providerConfig.oauth !== undefined) {
        statuses.push(await this.oauth.status(name));
      }
    }
    return statuses;
  }

  async ensureReady(provider = KIMI_CODE_PROVIDER_NAME): Promise<void> {
    const status = await this.oauth.status(provider);
    if (!status.loggedIn) {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${provider}" requires login before it can be used.`,
      );
    }
  }
}

function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return 'expired';
  if (err instanceof OAuthError) {
    return err.message.toLowerCase().includes('aborted') ? 'cancelled' : 'denied';
  }
  return 'denied';
}

registerScopedService(LifecycleScope.Core, IOAuthService, OAuthService, InstantiationType.Delayed, 'auth');
registerScopedService(LifecycleScope.Core, IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed, 'auth');
