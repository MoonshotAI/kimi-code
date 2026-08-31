import { randomUUID } from 'node:crypto';

import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  kimiRegionLoginHosts,
  OAuthError,
  applyManagedKimiCodeConfig,
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  resolveKimiRegion,
  type AuthManagedUserInfoResult,
  type AuthManagedUsageResult,
  type BearerTokenProvider,
  type DeviceAuthorization,
  type KimiRegion,
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

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ILogService } from '#/_base/log/log';
import {
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
  resolveModelForReady,
  providerNameFromFlatModel,
  type ModelReadyFailureReason,
} from '#/kosong/model/modelAuth';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import { ModelCatalogChanged } from '#/app/kosongConfig/discovery';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
  type ProvidersChangedEvent,
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
  type OAuthLoginOptions,
} from './auth';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;
const SERVICES_SECTION = 'services';

type TerminalOAuthFlowStatus = Exclude<OAuthFlowStatus, 'pending'>;

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: OAuthRef | undefined;
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
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this._register(providerService.onDidChangeProviders((event) => {
      this.invalidateFlows(event);
    }));
  }

  async startLogin(
    provider = KIMI_CODE_PROVIDER_NAME,
    options: OAuthLoginOptions = {},
  ): Promise<OAuthFlowStart> {
    this.log.info('oauth startLogin: enter', { provider });
    const loginAuth = this.resolveLoginAuth(provider, options.region);
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
      startedAt: Date.now(),
      device: undefined,
      status: 'pending',
      tokenGranted: false,
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

  getManagedUsage(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthManagedUsageResult> {
    const configured = this.providerService.get(provider);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: configured?.baseUrl,
      configuredOAuthRef: configured?.oauth,
    });
    return this.toolkit.getManagedUsage(provider, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  getManagedUserInfo(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthManagedUserInfoResult> {
    const configured = this.providerService.get(provider);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: configured?.baseUrl,
      configuredOAuthRef: configured?.oauth,
    });
    return this.toolkit.getManagedUserInfo(provider, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
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
    const finish = (): RefreshOAuthProviderModelsResponse => {
      this.telemetry.track2('oauth_models_refresh_finished', {
        changed_count: changed.length,
        unchanged_count: unchanged.length,
        failed_count: failed.length,
      });
      return { changed, unchanged, failed };
    };

    try {
      await this.config.reload();
    } catch (error) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: error instanceof Error ? error.message : String(error),
      });
      finish();
      throw error;
    }
    const current = this.readUserConfigShape();
    const provider = current.providers[KIMI_CODE_PROVIDER_NAME];
    if (!isOAuthCatalogProvider(provider)) {
      return finish();
    }

    try {
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: provider.baseUrl,
        configuredOAuthRef: provider.oauth,
      });
      const tokenProvider = this.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (tokenProvider === undefined) {
        throw new Error2(ErrorCodes.AUTH_TOKEN_MISSING, 'OAuth token provider is not configured.', {
          details: { provider_id: KIMI_CODE_PROVIDER_NAME },
        });
      }
      const token = await tokenProvider.getAccessToken();
      const models = await fetchManagedKimiCodeModels({
        accessToken: token,
        baseUrl: auth.baseUrl,
      });
      if (models.length === 0) {
        return finish();
      }

      await this.config.reload();
      const fresh = this.readUserConfigShape();
      const freshProvider = fresh.providers[KIMI_CODE_PROVIDER_NAME];
      if (!isOAuthCatalogProvider(freshProvider)) {
        return finish();
      }
      if (
        freshProvider.baseUrl !== provider.baseUrl ||
        freshProvider.oauth.storage !== provider.oauth.storage ||
        freshProvider.oauth.key !== provider.oauth.key ||
        freshProvider.oauth.oauthHost !== provider.oauth.oauthHost
      ) {
        return finish();
      }

      const next = structuredClone(fresh);
      applyManagedKimiCodeConfig(next, {
        models,
        baseUrl: auth.baseUrl,
        oauthKey: auth.oauthRef.key,
        oauthHost: auth.oauthRef.oauthHost,
        preserveDefaultModel: true,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        fresh,
        next,
        KIMI_CODE_PROVIDER_NAME,
        `${KIMI_CODE_PLATFORM_ID}/`,
      );
      restoreProviderAliases(
        next,
        preserveUserProviderAliases(fresh, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
      );
      restoreDefaultSelection(next, fresh.defaultModel, fresh.thinking?.enabled);
      clampDanglingDefault(next);

      if (providerModelsEqual(fresh, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
        unchanged.push(KIMI_CODE_PROVIDER_NAME);
      } else {
        const { added, removed } = computeChanges(
          collectModelIdsForAliases(fresh, refreshedAliasKeys),
          collectModelIdsForAliases(next, refreshedAliasKeys),
        );
        await this.config.replace(PROVIDERS_SECTION, next.providers);
        await this.config.replace(MODELS_SECTION, next.models ?? {});
        await this.config.replace(DEFAULT_MODEL_SECTION, next.defaultModel);
        await this.config.replace(THINKING_SECTION, next.thinking);
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

    const result = finish();
    if (result.changed.length > 0) {
      this.events.publish(new ModelCatalogChanged({ payload: result }));
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

  getRegion(): KimiRegion {
    const oauth = this.providerService.get(KIMI_CODE_PROVIDER_NAME)?.oauth;
    return resolveKimiRegion({
      configuredOAuthHost: oauth?.oauthHost,
      configuredOAuthKey: oauth?.key,
      readMarker:
        (this.bootstrap.getEnv('KIMI_CODE_REGION_MARKER') ??
          process.env['KIMI_CODE_REGION_MARKER']) !== 'off',
      homeDir: this.bootstrap.homeDir,
    });
  }

  private resolveLoginAuth(
    provider: string,
    region?: KimiRegion,
  ): {
    readonly oauthRef: OAuthRef | undefined;
    readonly baseUrl: string | undefined;
    readonly oauthHost: string | undefined;
  } {
    const config = this.providerService.get(provider);
    if (provider !== KIMI_CODE_PROVIDER_NAME) {
      return { oauthRef: config?.oauth, baseUrl: undefined, oauthHost: undefined };
    }
    const hosts = region === undefined ? undefined : kimiRegionLoginHosts(region);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: config?.baseUrl,
      configuredOAuthRef: config?.oauth,
      requestedBaseUrl: hosts?.baseUrl,
      requestedOAuthHost: hosts?.oauthHost,
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
      if (state.tokenGranted) continue;
      state.controller.abort();
      state.errorMessage = 'Provider configuration changed during login.';
      this.setTerminal(state, 'cancelled');
    }
  }

  private handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return;
    state.tokenGranted = true;
    void this.provisionAfterSuccess(state);
  }

  private async completeAlreadyAuthenticatedLogin(state: FlowState): Promise<void> {
    if (state.status !== 'pending') return;
    state.tokenGranted = true;
    await this.provisionAfterSuccess(state);
  }

  private async provisionAfterSuccess(state: FlowState): Promise<void> {
    try {
      await this.provisionProvider(state.provider, state.oauthRef, state.loginBaseUrl);
      if (this.flows.get(state.provider) !== state) return;
      if (state.provider === KIMI_CODE_PROVIDER_NAME) {
        await this.refreshOAuthProviderModelsBestEffort(state.provider);
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
      await this.config.replace(DEFAULT_MODEL_SECTION, undefined);
      await this.config.replace(THINKING_SECTION, undefined);
    }
  }

  private handleFailure(state: FlowState, err: unknown): void {
    if (state.status !== 'pending') return;
    state.errorMessage = err instanceof Error ? err.message : String(err);
    this.setTerminal(state, classifyFailure(err));
  }

  private setTerminal(state: FlowState, status: TerminalOAuthFlowStatus): void {
    state.status = status;
    state.resolvedAt = new Date().toISOString();
    this.telemetry.track2('oauth_login_finished', {
      provider: state.provider,
      status,
      duration_ms: Date.now() - state.startedAt,
    });
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
    @IModelService private readonly modelService: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
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
    try {
      await this.config.reload();
      const providers = this.providerService.list();
      const models = this.modelService.list();
      const modelId = modelOverride ?? this.modelService.getDefaultModel();
      const configured = modelId === undefined || modelId === '' ? undefined : models[modelId];
      if (Object.keys(providers).length === 0 && !isProviderlessModel(configured)) {
        throw new AuthProvisioningRequiredError();
      }
      const resolution = resolveModelForReady(modelId, models, providers, this.providerService.getDefaultProvider());
      if (!resolution.resolved) {
        throw unresolvedModelError(modelId, resolution.reason, configured);
      }

      const model = effectiveModelConfig(configured as ModelRecord);
      const providerId = model.providerId ?? model.provider ?? this.providerService.getDefaultProvider();
      const provider = providerId === undefined ? undefined : this.providerService.get(providerId);
      const providerName = (providerId ?? providerNameFromFlatModel(model)) as string;

      const auth = resolveModelAuthMaterial({
        modelId: modelId as string,
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
    } catch (error) {
      this.telemetry.track2('auth_ensure_ready_failed', {
        reason: ensureReadyFailureReason(error) ?? 'unexpected',
        has_model_override: modelOverride !== undefined,
      });
      throw error;
    }
  }
}

function unresolvedModelError(
  modelId: string | undefined,
  reason: ModelReadyFailureReason,
  configured: ModelRecord | undefined,
): AuthModelNotResolvedError {
  if (reason === 'no-default') {
    return new AuthModelNotResolvedError(undefined);
  }
  if (reason === 'provider-missing' && configured !== undefined) {
    const model = effectiveModelConfig(configured);
    return new AuthModelNotResolvedError(modelId, model.providerId ?? model.provider);
  }
  return new AuthModelNotResolvedError(modelId);
}

function ensureReadyFailureReason(
  error: unknown,
): 'provisioning_required' | 'model_not_resolved' | 'token_missing' | undefined {
  if (error instanceof AuthProvisioningRequiredError) return 'provisioning_required';
  if (error instanceof AuthModelNotResolvedError) return 'model_not_resolved';
  if (error instanceof AuthTokenMissingError) return 'token_missing';
  return undefined;
}

function classifyFailure(err: unknown): TerminalOAuthFlowStatus {
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

interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

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
  return JSON.stringify({ defaultModel: config.defaultModel ?? null, models: snapshots });
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
    super({ homeDir: bootstrap.homeDir, identity: bootstrap.clientIdentity });
  }
}

registerScopedService(LifecycleScope.App, IOAuthService, OAuthService, ScopeActivation.OnScopeCreated, 'auth');
registerScopedService(LifecycleScope.App, IOAuthToolkit, OAuthToolkitService, ScopeActivation.OnScopeCreated, 'auth');
registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, ScopeActivation.OnScopeCreated, 'auth');
