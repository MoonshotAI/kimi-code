/**
 * `auth` domain (cross-cutting) — `IOAuthService` / `IAuthSummaryService`
 * implementation.
 *
 * Owns the device-code OAuth flows and the auth readiness view; reads and
 * writes provider configuration through `provider`, refreshes the managed
 * OAuth provider's server-side model configuration through `config`, reports
 * through `telemetry`, logs through `log`, and delegates the device-code
 * protocol, token storage, and token refresh to `IOAuthToolkit` (provided by
 * `OAuthToolkitService` over `@moonshot-ai/kimi-code-oauth`, which locates
 * token storage through `bootstrap`). Bound at App scope.
 */

import { randomUUID } from 'node:crypto';

import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  OAuthError,
  applyManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  type BearerTokenProvider,
  type DeviceAuthorization,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ILogService } from '#/_base/log/log';
import { type ModelAlias, MODELS_SECTION } from '#/app/model/model';
import { IProviderService, type OAuthRef, type ProviderConfig, PROVIDERS_SECTION } from '#/app/provider/provider';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { type AuthStatus, IAuthSummaryService, IOAuthService, IOAuthToolkit } from './auth';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;
const DEFAULT_MODEL_SECTION = 'defaultModel';
const DEFAULT_THINKING_SECTION = 'defaultThinking';

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: OAuthRef | undefined;
  device: DeviceAuthorization | undefined;
  status: OAuthFlowStatus;
  expiresAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  errorMessage: string | undefined;
  resolvedAt: string | undefined;
}

export class OAuthService extends Disposable implements IOAuthService {
  declare readonly _serviceBrand: undefined;
  private readonly flows = new Map<string, FlowState>();

  constructor(
    @IOAuthToolkit private readonly toolkit: IOAuthToolkit,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly events: IEventService,
  ) {
    super();
    this._register(providerService.onDidChangeProviders(() => this.invalidateFlows()));
  }

  async startLogin(provider = KIMI_CODE_PROVIDER_NAME): Promise<OAuthFlowStart> {
    this.log.info('oauth startLogin: enter', { provider });
    const oauthRef = this.resolveOAuthRef(provider);
    this.log.info('oauth startLogin: resolved oauthRef', {
      provider,
      hasOAuthRef: oauthRef !== undefined,
    });
    this.abortExisting(provider);

    const state: FlowState = {
      flowId: `oauth_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      oauthRef,
      device: undefined,
      status: 'pending',
      expiresAt: Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
      gcTimer: undefined,
      errorMessage: undefined,
      resolvedAt: undefined,
    };
    this.flows.set(provider, state);

    let resolveDevice!: (auth: DeviceAuthorization) => void;
    let rejectDevice!: (error: unknown) => void;
    const deviceReady = new Promise<DeviceAuthorization>((resolve, reject) => {
      resolveDevice = resolve;
      rejectDevice = reject;
    });

    this.log.info('oauth startLogin: calling toolkit.login', { provider });
    const loginPromise = this.toolkit.login(provider, {
      signal: state.controller.signal,
      oauthRef,
      onDeviceCode: (auth) => {
        this.log.info('oauth startLogin: onDeviceCode fired', { provider });
        state.device = auth;
        if (auth.expiresIn !== null) {
          state.expiresAt = Date.now() + auth.expiresIn * 1000;
        }
        resolveDevice(auth);
      },
    });
    loginPromise.then(
      () => {
        this.log.info('oauth startLogin: toolkit.login resolved', {
          provider,
          deviceArrived: state.device !== undefined,
        });
        if (state.device === undefined) {
          this.flows.delete(provider);
          rejectDevice(
            new Error('OAuth login completed without issuing a device code (already authenticated).'),
          );
          return;
        }
        this.handleSuccess(state);
      },
      (error) => {
        this.log.warn('oauth startLogin: toolkit.login rejected', {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        this.handleFailure(state, error);
        rejectDevice(error);
      },
    );

    this.log.info('oauth startLogin: awaiting deviceReady', { provider });
    const device = await deviceReady;
    this.log.info('oauth startLogin: deviceReady resolved', { provider });
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
    const result = await this.toolkit.logout(provider, oauthRef);
    this.abortExisting(provider);
    return { logged_out: true, provider: result.providerName };
  }

  async status(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthStatus> {
    this.log.info('oauth status: enter', { provider });
    const oauthRef = this.readOAuthRefOptional(provider);
    try {
      const token = await this.toolkit.getCachedAccessToken(provider, oauthRef);
      this.log.info('oauth status: got token', { provider, hasToken: token !== undefined });
      return token === undefined ? { loggedIn: false } : { loggedIn: true, provider };
    } catch (error) {
      this.log.warn('oauth status: getCachedAccessToken threw', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined {
    return this.toolkit.tokenProvider(provider, oauthRef);
  }

  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(provider, oauthRef);
  }

  async refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const changed: RefreshOAuthProviderModelsResponse['changed'] = [];
    const unchanged: string[] = [];
    const failed: RefreshOAuthProviderModelsResponse['failed'] = [];

    await this.config.reload();
    const current = this.readUserConfigShape();
    const provider = current.providers[KIMI_CODE_PROVIDER_NAME];
    if (!isKimiOAuthProvider(provider)) {
      return { changed, unchanged, failed };
    }

    try {
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: provider.baseUrl,
        configuredOAuthRef: provider.oauth,
      });
      const tokenProvider = this.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (tokenProvider === undefined) {
        throw new Error('OAuth token provider is not configured.');
      }
      const token = await tokenProvider.getAccessToken();
      const models = await fetchManagedKimiCodeModels({
        accessToken: token,
        baseUrl: auth.baseUrl,
      });
      if (models.length === 0) {
        return { changed, unchanged, failed };
      }

      const next = structuredClone(current);
      applyManagedKimiCodeConfig(next, {
        models,
        baseUrl: auth.baseUrl,
        oauthKey: auth.oauthRef.key,
        oauthHost: auth.oauthRef.oauthHost,
        preserveDefaultModel: true,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        current,
        next,
        KIMI_CODE_PROVIDER_NAME,
        `${KIMI_CODE_PLATFORM_ID}/`,
      );
      restoreProviderAliases(
        next,
        preserveUserProviderAliases(current, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
      );
      restoreDefaultSelection(next, current.defaultModel, current.defaultThinking);
      clampDanglingDefault(next);

      if (providerModelsEqual(current, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
        unchanged.push(KIMI_CODE_PROVIDER_NAME);
      } else {
        const { added, removed } = computeChanges(
          collectModelIdsForAliases(current, refreshedAliasKeys),
          collectModelIdsForAliases(next, refreshedAliasKeys),
        );
        await this.config.replace(PROVIDERS_SECTION, next.providers);
        await this.config.replace(MODELS_SECTION, next.models ?? {});
        await this.config.set(DEFAULT_MODEL_SECTION, next.defaultModel);
        await this.config.set(DEFAULT_THINKING_SECTION, next.defaultThinking);
        changed.push({
          provider_id: KIMI_CODE_PROVIDER_NAME,
          provider_name: 'Kimi Code',
          added,
          removed,
        });
      }
    } catch (err) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const result = { changed, unchanged, failed };
    if (result.changed.length > 0) {
      this.events.publish({ type: 'event.model_catalog.changed', payload: result });
    }
    return result;
  }

  private readUserConfigShape(): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models = this.config.inspect<Record<string, ModelAlias>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const defaultThinking = this.config.inspect<boolean>(DEFAULT_THINKING_SECTION).userValue;
    return {
      providers: { ...providers } as ManagedKimiConfigShape['providers'],
      models: { ...models } as ManagedKimiConfigShape['models'],
      defaultModel,
      defaultThinking,
    };
  }

  private resolveOAuthRef(provider: string): OAuthRef | undefined {
    const config = this.providerService.get(provider);
    if (config?.oauth !== undefined) return config.oauth;
    if (provider !== KIMI_CODE_PROVIDER_NAME) return undefined;
    return resolveKimiCodeOAuthRef({ baseUrl: config?.baseUrl });
  }

  private readOAuthRefOptional(provider: string): OAuthRef | undefined {
    return this.providerService.get(provider)?.oauth;
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
    void this.provisionProvider(state.provider, state.oauthRef);
  }

  private async provisionProvider(provider: string, oauthRef: OAuthRef | undefined): Promise<void> {
    if (oauthRef === undefined) return;
    const baseUrl = this.providerService.get(provider)?.baseUrl ?? kimiCodeBaseUrl();
    try {
      await this.providerService.set(provider, {
        type: 'kimi',
        baseUrl,
        apiKey: '',
        oauth: oauthRef,
      });
    } catch (error) {
      this.log.warn('oauth provider provisioning failed', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    @IProviderService private readonly providerService: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @ILogService private readonly log: ILogService,
  ) {}

  async summarize(): Promise<readonly AuthStatus[]> {
    const providers = this.providerService.list();
    const oauthProviders = Object.entries(providers).filter(
      ([, config]) => config.oauth !== undefined,
    );
    this.log.info('auth summarize: enter', {
      total: Object.keys(providers).length,
      oauthProviders: oauthProviders.map(([name]) => name),
    });
    const statuses: AuthStatus[] = [];
    for (const [name] of oauthProviders) {
      try {
        statuses.push(await this.oauth.status(name));
      } catch (error) {
        this.log.warn('auth summarize: status threw', {
          provider: name,
          error: error instanceof Error ? error.message : String(error),
        });
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

/** Structural view of a managed-config model alias (the fields the refresh reads/writes). */
interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

function isKimiOAuthProvider(
  provider: ProviderConfig | Record<string, unknown> | undefined,
): provider is ProviderConfig & { oauth: OAuthRef } {
  return (
    provider !== undefined &&
    (provider as ProviderConfig).type === 'kimi' &&
    (provider as ProviderConfig).oauth !== undefined
  );
}

function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = managedModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) ids.add(alias.model);
  }
  return ids;
}

function providerAliasKeys(config: ManagedKimiConfigShape, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId && alias.startsWith(aliasPrefix)) {
      keys.add(alias);
    }
  }
  return keys;
}

function computeChanges(
  oldIds: Set<string>,
  newIds: Set<string>,
): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: Array<{ alias: string; model: ManagedModel }> = [];
  for (const alias of aliasKeys) {
    const model = managedModel(config, alias);
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities:
          model.capabilities === undefined ? undefined : [...model.capabilities].sort(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedModel> {
  const preserved: Record<string, ManagedModel> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const entry = model as ManagedModel;
    if (entry.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(entry);
  }
  return preserved;
}

function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedModel>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  } as ManagedKimiConfigShape['models'];
}

function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultThinking: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined) return;
  config.defaultModel = defaultModel;
  const capabilities = managedModel(config, defaultModel)?.capabilities ?? [];
  config.defaultThinking = capabilities.includes('always_thinking') ? true : defaultThinking;
}

function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.defaultThinking = undefined;
  }
}

function managedModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedModel | undefined {
  return config.models?.[alias] as ManagedModel | undefined;
}

class OAuthToolkitService extends KimiOAuthToolkit implements IOAuthToolkit {
  declare readonly _serviceBrand: undefined;
  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super({ homeDir: bootstrap.homeDir });
  }
}

registerScopedService(LifecycleScope.App, IOAuthService, OAuthService, InstantiationType.Delayed, 'auth');
registerScopedService(LifecycleScope.App, IOAuthToolkit, OAuthToolkitService, InstantiationType.Delayed, 'auth');
registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed, 'auth');
