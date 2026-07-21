/**
 * `auth` domain (cross-cutting) — `IOAuthService` / `IAuthSummaryService`
 * implementation.
 *
 * Owns the device-code OAuth flows and the auth readiness view; reads and
 * writes provider configuration through `provider`, refreshes the managed
 * OAuth provider's server-side model configuration through `config`, publishes
 * model-catalog changes through `event`, reports through `telemetry`,
 * logs through `log`, and delegates
 * the device-code protocol, token storage, and token refresh to `IOAuthToolkit`
 * (provided by `OAuthToolkitService` over `@moonshot-ai/kimi-code-oauth`,
 * which locates token storage through `bootstrap`). Bound at App scope.
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
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  type BearerTokenProvider,
  type DeviceAuthorization,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStartPending,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from './oauthProtocol';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ILogService } from '#/_base/log/log';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
} from '#/kosong/model/modelAuth';
import { DEFAULT_MODEL_SECTION, type ModelRecord, MODELS_SECTION } from '#/kosong/model/model';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
  type ProvidersChangedEvent,
  PROVIDERS_SECTION,
} from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  type AuthStatus,
  IAuthSummaryService,
  IOAuthService,
  IOAuthToolkit,
} from './auth';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;
const THINKING_SECTION = 'thinking';
const SERVICES_SECTION = 'services';

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: OAuthRef | undefined;
  readonly loginBaseUrl: string | undefined;
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

  private refreshChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IOAuthToolkit private readonly toolkit: IOAuthToolkit,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly events: IEventService,
  ) {
    super();
    this._register(providerService.onDidChangeProviders((event) => {
      this.invalidateFlows(event);
    }));
  }

  async startLogin(provider = KIMI_CODE_PROVIDER_NAME): Promise<OAuthFlowStart> {
    this.log.info('oauth startLogin: enter', { provider });
    const loginAuth = this.resolveLoginAuth(provider);
    this.log.info('oauth startLogin: resolved login auth', {
      provider,
      hasOAuthRef: loginAuth.oauthRef !== undefined,
      hasBaseUrl: loginAuth.baseUrl !== undefined,
      hasOAuthHost: loginAuth.oauthHost !== undefined,
    });
    this.abortExisting(provider);

    const state: FlowState = {
      flowId: `oauth_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      oauthRef: loginAuth.oauthRef,
      loginBaseUrl: loginAuth.baseUrl,
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
      oauthRef: loginAuth.oauthRef,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      onDeviceCode: (auth) => {
        this.log.info('oauth startLogin: onDeviceCode fired', { provider });
        state.device = auth;
        if (auth.expiresIn !== null) {
          state.expiresAt = Date.now() + auth.expiresIn * 1000;
        }
        resolveDevice(auth);
      },
    });
    const fastPath: Promise<OAuthFlowStart | undefined> = loginPromise.then(async () => {
      if (state.device !== undefined) return undefined;
      this.log.info('oauth startLogin: toolkit resolved without device code (already authenticated)', {
        provider,
      });
      await this.completeAlreadyAuthenticatedLogin(state);
      return {
        flow_id: state.flowId,
        provider: state.provider,
        status: 'authenticated',
      };
    });

    loginPromise.then(
      () => {
        this.log.info('oauth startLogin: toolkit.login resolved', {
          provider,
          deviceArrived: state.device !== undefined,
        });
        if (state.device !== undefined) {
          this.handleSuccess(state);
        }
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

    this.log.info('oauth startLogin: awaiting device flow start', { provider });
    const winner = await Promise.race([
      deviceReady.then((device) => ({ kind: 'device' as const, device })),
      fastPath.then((result) => ({ kind: 'fast' as const, result })),
    ]);
    if (winner.kind === 'fast' && winner.result !== undefined) {
      this.log.info('oauth startLogin: fast path returned authenticated', { provider });
      return winner.result;
    }
    const device = winner.kind === 'device' ? winner.device : await deviceReady;
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
    const oauthRef =
      provider === KIMI_CODE_PROVIDER_NAME
        ? this.resolveRuntimeOAuthRef(provider)
        : this.readOAuthRefOptional(provider);
    const result = await this.toolkit.logout(provider, oauthRef);
    this.abortExisting(provider);
    await this.deprovisionProvider(provider);
    return { logged_out: true, provider: result.providerName };
  }

  async status(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthStatus> {
    this.log.info('oauth status: enter', { provider });
    const oauthRef = this.readOAuthRefOptional(provider);
    try {
      const token = await this.getCachedAccessToken(provider, oauthRef);
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
    return this.toolkit.tokenProvider(provider, this.resolveRuntimeOAuthRef(provider, oauthRef));
  }

  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(provider, this.resolveRuntimeOAuthRef(provider, oauthRef));
  }

  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const run = this.refreshChain.then(() => this.doRefreshOAuthProviderModels());
    this.refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRefreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const changed: RefreshOAuthProviderModelsResponse['changed'] = [];
    const unchanged: string[] = [];
    const failed: RefreshOAuthProviderModelsResponse['failed'] = [];

    await this.config.reload();
    const current = this.readUserConfigShape();
    const provider = current.providers[KIMI_CODE_PROVIDER_NAME];
    if (!isOAuthCatalogProvider(provider)) {
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
      restoreDefaultSelection(next, current.defaultModel, current.thinking?.enabled);
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
        await this.config.set(THINKING_SECTION, next.thinking);
        changed.push({
          provider_id: KIMI_CODE_PROVIDER_NAME,
          provider_name: 'Kimi Code',
          added,
          removed,
        });
      }
    } catch (error) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: error instanceof Error ? error.message : String(error),
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
    const models = this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const services =
      this.config.inspect<ManagedKimiConfigShape['services']>(SERVICES_SECTION).userValue;
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking =
      this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue;
    return {
      providers: { ...providers } as ManagedKimiConfigShape['providers'],
      models: { ...models } as ManagedKimiConfigShape['models'],
      services: services === undefined ? undefined : { ...services },
      defaultModel,
      thinking: thinking === undefined ? undefined : { ...thinking },
    };
  }

  private resolveLoginAuth(provider: string): {
    readonly oauthRef: OAuthRef | undefined;
    readonly baseUrl: string | undefined;
    readonly oauthHost: string | undefined;
  } {
    const config = this.providerService.get(provider);
    if (provider !== KIMI_CODE_PROVIDER_NAME) {
      return { oauthRef: config?.oauth, baseUrl: undefined, oauthHost: undefined };
    }
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: config?.baseUrl,
      configuredOAuthRef: config?.oauth,
    });
    const oauthRef =
      loginAuth.oauthRef ??
      resolveKimiCodeOAuthRef({
        oauthHost: loginAuth.oauthHost,
        baseUrl: loginAuth.baseUrl,
      });
    return {
      oauthRef,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
    };
  }

  private readOAuthRefOptional(provider: string): OAuthRef | undefined {
    return this.providerService.get(provider)?.oauth;
  }

  private resolveRuntimeOAuthRef(provider: string, oauthRef?: OAuthRef): OAuthRef | undefined {
    if (provider !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const config = this.providerService.get(provider);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: config?.baseUrl,
      configuredOAuthRef: oauthRef ?? config?.oauth,
    }).oauthRef;
  }

  private abortExisting(provider: string): void {
    const existing = this.flows.get(provider);
    if (existing !== undefined && existing.status === 'pending') {
      existing.controller.abort();
      this.setTerminal(existing, 'cancelled');
    }
  }

  private invalidateFlows(event: ProvidersChangedEvent): void {
    const affected = new Set([...event.removed, ...event.changed]);
    if (affected.size === 0) return;
    for (const state of this.flows.values()) {
      if (!affected.has(state.provider)) continue;
      if (state.status !== 'pending') continue;
      state.controller.abort();
      state.errorMessage = 'Provider configuration changed during login.';
      this.setTerminal(state, 'cancelled');
    }
  }

  private handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return;
    void this.finalizeAuthentication(state);
  }

  private async completeAlreadyAuthenticatedLogin(state: FlowState): Promise<void> {
    await this.finalizeAuthentication(state);
  }

  private async finalizeAuthentication(state: FlowState): Promise<void> {
    try {
      await this.provisionProvider(state.provider, state.oauthRef, state.loginBaseUrl);
      if (state.status !== 'pending') return;
      if (state.provider === KIMI_CODE_PROVIDER_NAME) {
        await this.refreshOAuthProviderModelsBestEffort(state.provider);
        if (state.status !== 'pending') return;
      }
    } catch (error) {
      this.log.warn('oauth provider provisioning failed', {
        provider: state.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (state.status === 'pending') {
        this.setTerminal(state, 'authenticated');
      }
    }
  }

  private async provisionProvider(
    provider: string,
    oauthRef: OAuthRef | undefined,
    loginBaseUrl: string | undefined,
  ): Promise<void> {
    if (oauthRef === undefined && provider !== KIMI_CODE_PROVIDER_NAME) return;
    const baseUrl =
      loginBaseUrl ?? this.providerService.get(provider)?.baseUrl ?? kimiCodeBaseUrl();
    await this.providerService.set(provider, {
      type: 'kimi',
      baseUrl,
      apiKey: '',
      oauth: oauthRef,
    });
  }

  private async refreshOAuthProviderModelsBestEffort(provider: string): Promise<void> {
    const result = await this.refreshOAuthProviderModels();
    if (result.failed.length > 0) {
      this.log.warn('oauth startLogin: model refresh failed on already-authenticated fast path', {
        provider,
        failures: result.failed,
      });
    }
  }

  private async deprovisionProvider(provider: string): Promise<void> {
    if (provider !== KIMI_CODE_PROVIDER_NAME) return;
    const next = structuredClone(this.readUserConfigShape());
    const cleanup = clearManagedKimiCodeConfig(next);
    if (
      !cleanup.removedProvider &&
      cleanup.removedModels.length === 0 &&
      !cleanup.defaultModelCleared &&
      cleanup.removedServices.length === 0
    ) {
      return;
    }
    if (cleanup.defaultModelCleared) {
      next.thinking = undefined;
    }
    if (cleanup.removedProvider) {
      await this.config.replace(PROVIDERS_SECTION, next.providers);
    }
    if (cleanup.removedModels.length > 0) {
      await this.config.replace(MODELS_SECTION, next.models ?? {});
    }
    if (cleanup.removedServices.length > 0) {
      await this.config.replace(SERVICES_SECTION, next.services);
    }
    if (cleanup.defaultModelCleared) {
      await this.config.set(DEFAULT_MODEL_SECTION, undefined);
      await this.config.set(THINKING_SECTION, undefined);
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

  private toFlowStart(state: FlowState, device: DeviceAuthorization): OAuthFlowStartPending {
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
    @IConfigService private readonly config: IConfigService,
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

  async ensureReady(modelOverride?: string): Promise<void> {
    await this.config.reload();
    const providers = this.providerService.list();
    const models = this.config.get<Record<string, ModelRecord> | undefined>(MODELS_SECTION) ?? {};
    const modelId = modelOverride ?? this.config.get<string | undefined>(DEFAULT_MODEL_SECTION);
    const configured = modelId === undefined || modelId === '' ? undefined : models[modelId];
    if (Object.keys(providers).length === 0 && !isProviderlessModel(configured)) {
      throw new AuthProvisioningRequiredError();
    }
    if (modelId === undefined || modelId === '') {
      throw new AuthModelNotResolvedError(undefined);
    }
    if (configured === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const model = effectiveModelConfig(configured);
    const providerId = model.providerId ?? model.provider;
    const provider = providerId === undefined ? undefined : this.providerService.get(providerId);
    if (providerId !== undefined && provider === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerId);
    }

    const providerName = providerId ?? providerNameFromFlatModel(model);
    if (providerName === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const auth = resolveModelAuthMaterial({
      modelId,
      model,
      provider,
      providerName,
    });
    if (auth.apiKey !== undefined) return;
    if (auth.oauth !== undefined) {
      const providerKey = auth.oauthProviderKey ?? providerName;
      const token = await this.oauth.getCachedAccessToken(providerKey, auth.oauth);
      if (nonEmpty(token) !== undefined) return;
      throw new AuthTokenMissingError(providerKey);
    }
    throw new AuthTokenMissingError(providerName);
  }
}

function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return 'expired';
  if (err instanceof OAuthError) {
    return err.message.toLowerCase().includes('aborted') ? 'cancelled' : 'denied';
  }
  return 'denied';
}

function isProviderlessModel(model: ModelRecord | undefined): boolean {
  if (model === undefined) return false;
  const effective = effectiveModelConfig(model);
  return (
    effective.providerId === undefined &&
    effective.provider === undefined &&
    providerNameFromFlatModel(effective) !== undefined
  );
}

function providerNameFromFlatModel(model: ModelRecord): string | undefined {
  const baseUrl = nonEmpty(model.baseUrl);
  return baseUrl === undefined ? undefined : deriveProviderId(baseUrl);
}

interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

/**
 * Whether the provider is backed by the OAuth model catalog: the vendor's
 * provider definitions declare `modelSource: 'oauth-catalog'` (a registry
 * answer, not a vendor string compare) and the provider config carries an
 * OAuth ref.
 */
function isOAuthCatalogProvider(
  provider: ProviderConfig | Record<string, unknown> | undefined,
): provider is ProviderConfig & { oauth: OAuthRef } {
  const type = (provider as ProviderConfig | undefined)?.type;
  return (
    provider !== undefined &&
    isOAuthCatalogVendor(type) &&
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
          model.capabilities === undefined ? undefined : model.capabilities.toSorted(),
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
  defaultEnabled: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined) return;
  config.defaultModel = defaultModel;
  const capabilities = managedModel(config, defaultModel)?.capabilities ?? [];
  const enabled = capabilities.includes('always_thinking') ? true : defaultEnabled;
  if (enabled !== undefined) {
    config.thinking = { ...config.thinking, enabled };
  }
}

function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.thinking = undefined;
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

registerScopedService(LifecycleScope.App, IOAuthService, OAuthService, InstantiationType.Eager, 'auth');
registerScopedService(LifecycleScope.App, IOAuthToolkit, OAuthToolkitService, InstantiationType.Eager, 'auth');
registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, InstantiationType.Eager, 'auth');
