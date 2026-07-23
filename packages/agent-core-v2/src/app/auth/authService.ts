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
import { join } from 'node:path';

import {
  applyOpenAICodexConfig,
  clearOpenAICodexConfig,
  createOpenAICodexTokenProvider,
  DeviceCodeTimeoutError,
  FileTokenStorage,
  fetchOpenAICodexModels,
  isOpenAICodexAuth,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  loginOpenAICodexDeviceCode,
  ManagedKimiCodeModelsAuthError,
  openAICodexOAuthRef,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_MODELS,
  OPENAI_CODEX_OAUTH_KEY,
  OPENAI_CODEX_PROVIDER_NAME,
  OAuthError,
  OAuthUnauthorizedError,
  applyManagedKimiCodeConfig,
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiTokenStorageName,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  type AuthManagedUsageResult,
  type BearerTokenProvider,
  type DeviceAuthorization,
  type KimiOAuthLoginOptions,
  type KimiOAuthLoginResult,
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
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
  type ProvidersChangedEvent,
} from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  type AuthStatus,
  IAuthSummaryService,
  IOAuthService,
  IOAuthToolkit,
  type OAuthEntitlementStatus,
  type OAuthLoginOptions,
} from './auth';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;
const SERVICES_SECTION = 'services';
const AUTH_STATE_KEY = 'oauth-entitlements.json';

interface PersistedOAuthEntitlements {
  readonly version: 1;
  readonly providers: Readonly<Record<string, OAuthEntitlementStatus>>;
}

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: OAuthRef | undefined;
  readonly loginBaseUrl: string | undefined;
  readonly preserveDefaultModel: boolean;
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
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly events: IEventService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
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
      preserveDefaultModel: options.preserveDefaultModel === true,
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
      if (state.status !== 'authenticated') {
        return {
          flow_id: state.flowId,
          provider: state.provider,
          status: 'denied',
          error_message: state.errorMessage ?? 'OAuth provider setup could not be completed.',
        };
      }
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
      this.log.info('oauth startLogin: fast path completed', {
        provider,
        status: winner.result.status,
      });
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
    const oauthRef = this.resolveRuntimeOAuthRef(provider, this.readOAuthRefOptional(provider));
    const result = await this.toolkit.logout(provider, oauthRef);
    this.abortExisting(provider);
    await this.deprovisionProvider(provider);
    await this.clearEntitlementStatus(provider);
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

  async entitlementStatus(
    provider = KIMI_CODE_PROVIDER_NAME,
  ): Promise<OAuthEntitlementStatus | undefined> {
    return (await this.readEntitlements()).providers[provider];
  }

  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined {
    const runtimeOAuthRef = this.resolveRuntimeOAuthRef(provider, oauthRef);
    if (isOpenAICodexAuth(provider, runtimeOAuthRef)) {
      return createOpenAICodexTokenProvider({
        storage: new FileTokenStorage(join(this.bootstrap.homeDir, 'credentials')),
        providerName: provider,
        oauthRef: runtimeOAuthRef,
      });
    }
    return this.toolkit.tokenProvider(provider, runtimeOAuthRef);
  }

  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(provider, this.resolveRuntimeOAuthRef(provider, oauthRef));
  }

  getManagedUsage(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthManagedUsageResult> {
    // Same resolution path as the managed model refresh: env-aware base url +
    // oauth ref, so a self-hosted/proxied login environment reports its own
    // usage endpoint. The toolkit handles token freshness and error mapping.
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

  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    return this.enqueueOAuthProviderModelsRefresh(false);
  }

  private enqueueOAuthProviderModelsRefresh(
    throwOnFailure: boolean,
  ): Promise<RefreshOAuthProviderModelsResponse> {
    const run = this.refreshChain.then(() =>
      this.doRefreshOAuthProviderModels(throwOnFailure),
    );
    this.refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRefreshOAuthProviderModels(
    throwOnFailure: boolean,
  ): Promise<RefreshOAuthProviderModelsResponse> {
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
        // defaultModel/thinking hold the final computed values — write them
        // with replace (set-undefined cannot delete; set-object would merge
        // stale keys into the previous thinking config).
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
      if (throwOnFailure) throw error;
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
    if (provider === OPENAI_CODEX_PROVIDER_NAME) {
      const oauthRef = config?.oauth ?? openAICodexOAuthRef();
      return {
        oauthRef,
        baseUrl: config?.baseUrl ?? OPENAI_CODEX_BASE_URL,
        oauthHost: oauthRef.oauthHost,
      };
    }
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
    if (isOpenAICodexAuth(provider, oauthRef)) {
      return oauthRef ?? openAICodexOAuthRef();
    }
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
    let shouldRollbackFailedKimiProvision = false;
    try {
      shouldRollbackFailedKimiProvision =
        state.provider === KIMI_CODE_PROVIDER_NAME &&
        providerAliasKeys(this.readUserConfigShape(), KIMI_CODE_PROVIDER_NAME).size === 0;
      if (isOpenAICodexAuth(state.provider, state.oauthRef)) {
        await this.provisionOpenAICodexProvider(state);
      } else {
        await this.provisionProvider(state.provider, state.oauthRef, state.loginBaseUrl);
      }
      if (state.status !== 'pending') return;
      if (state.provider === KIMI_CODE_PROVIDER_NAME) {
        await this.refreshOAuthProviderModelsForLogin(state.provider);
        if (state.status !== 'pending') return;
        await this.clearEntitlementStatus(state.provider);
      }
      this.setTerminal(state, 'authenticated');
    } catch (error) {
      this.log.warn('oauth provider provisioning failed', {
        provider: state.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      if (state.status === 'pending') {
        state.errorMessage = error instanceof Error ? error.message : String(error);
        this.setTerminal(state, 'denied');
      }
      if (
        state.provider === KIMI_CODE_PROVIDER_NAME &&
        error instanceof ManagedKimiCodeModelsAuthError &&
        error.status === 402
      ) {
        await this.recordEntitlementStatus(state.provider, 'membership_required');
      }
      if (shouldRollbackFailedKimiProvision || error instanceof OAuthUnauthorizedError) {
        try {
          await this.deprovisionProvider(state.provider);
        } catch (cleanupError) {
          this.log.warn('oauth provider cleanup after failed provisioning failed', {
            provider: state.provider,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }
  }

  private async provisionOpenAICodexProvider(state: FlowState): Promise<void> {
    const accessToken = await this.toolkit.getCachedAccessToken(state.provider, state.oauthRef);
    if (accessToken === undefined) {
      throw new OAuthUnauthorizedError('OpenAI Codex OAuth token is unavailable after login.');
    }

    let models = OPENAI_CODEX_MODELS;
    try {
      models = await fetchOpenAICodexModels(accessToken, { signal: state.controller.signal });
    } catch (error) {
      this.log.warn('oauth startLogin: OpenAI Codex model refresh failed; using fallback', {
        provider: state.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const selectedModelId =
      models.find((model) => model.id === 'gpt-5.4')?.id ?? models[0]?.id;
    if (selectedModelId === undefined) {
      throw new Error('OpenAI Codex model catalog is empty.');
    }

    const current = this.readUserConfigShape();
    const next = structuredClone(current);
    applyOpenAICodexConfig(next, { selectedModelId, models });
    if (
      state.preserveDefaultModel &&
      current.defaultModel !== undefined &&
      next.models?.[current.defaultModel] !== undefined
    ) {
      next.defaultModel = current.defaultModel;
      next.thinking =
        current.thinking === undefined ? undefined : structuredClone(current.thinking);
    }

    const previousIds = collectModelIdsForAliases(
      current,
      providerAliasKeys(current, OPENAI_CODEX_PROVIDER_NAME),
    );
    const nextIds = collectModelIdsForAliases(
      next,
      providerAliasKeys(next, OPENAI_CODEX_PROVIDER_NAME),
    );
    const { added, removed } = computeChanges(previousIds, nextIds);

    await this.config.replace(PROVIDERS_SECTION, next.providers);
    await this.config.replace(MODELS_SECTION, next.models ?? {});
    await this.config.replace(DEFAULT_MODEL_SECTION, next.defaultModel);
    await this.config.replace(THINKING_SECTION, next.thinking);
    this.events.publish({
      type: 'event.model_catalog.changed',
      payload: {
        changed: [
          {
            provider_id: OPENAI_CODEX_PROVIDER_NAME,
            provider_name: 'OpenAI ChatGPT Plus/Pro',
            added,
            removed,
          },
        ],
        unchanged: [],
        failed: [],
      },
    });
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

  private async refreshOAuthProviderModelsForLogin(provider: string): Promise<void> {
    const result = await this.enqueueOAuthProviderModelsRefresh(true);
    const refreshed =
      result.changed.some((item) => item.provider_id === provider) ||
      result.unchanged.includes(provider);
    if (!refreshed) {
      throw new OAuthUnauthorizedError(
        'No Kimi Code models are available for this account. Verify that your Kimi Code membership is active.',
      );
    }
  }

  private async deprovisionProvider(provider: string): Promise<void> {
    const next = structuredClone(this.readUserConfigShape());
    if (isOpenAICodexAuth(provider, this.providerService.get(provider)?.oauth)) {
      const cleanup = clearOpenAICodexConfig(next);
      if (
        !cleanup.removedProvider &&
        cleanup.removedModels.length === 0 &&
        !cleanup.defaultModelCleared
      ) {
        return;
      }
      if (cleanup.defaultModelCleared) next.thinking = undefined;
      if (cleanup.removedProvider) {
        await this.config.replace(PROVIDERS_SECTION, next.providers);
      }
      if (cleanup.removedModels.length > 0) {
        await this.config.replace(MODELS_SECTION, next.models ?? {});
      }
      if (cleanup.defaultModelCleared) {
        await this.config.replace(DEFAULT_MODEL_SECTION, undefined);
        await this.config.replace(THINKING_SECTION, undefined);
      }
      return;
    }
    if (provider !== KIMI_CODE_PROVIDER_NAME) return;
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
      // Delete, not merge: `set(domain, undefined)` resolves back to the base
      // value by design — only `replace(domain, undefined)` actually removes
      // the key, and leaving defaultModel dangling to a just-removed managed
      // model keeps /api/v1/auth reporting ready=true after logout.
      await this.config.replace(DEFAULT_MODEL_SECTION, undefined);
      await this.config.replace(THINKING_SECTION, undefined);
    }
  }

  private async readEntitlements(): Promise<PersistedOAuthEntitlements> {
    const value = await this.atomicDocs.get<unknown>(
      this.bootstrap.scope('store'),
      AUTH_STATE_KEY,
    );
    if (typeof value !== 'object' || value === null) {
      return { version: 1, providers: {} };
    }
    const providers = (value as { providers?: unknown }).providers;
    if (typeof providers !== 'object' || providers === null) {
      return { version: 1, providers: {} };
    }
    const valid: Record<string, OAuthEntitlementStatus> = {};
    for (const [provider, status] of Object.entries(providers)) {
      if (status === 'membership_required') valid[provider] = status;
    }
    return { version: 1, providers: valid };
  }

  private async recordEntitlementStatus(
    provider: string,
    status: OAuthEntitlementStatus,
  ): Promise<void> {
    try {
      const current = await this.readEntitlements();
      await this.atomicDocs.set(this.bootstrap.scope('store'), AUTH_STATE_KEY, {
        version: 1,
        providers: { ...current.providers, [provider]: status },
      } satisfies PersistedOAuthEntitlements);
    } catch (error) {
      this.log.warn('oauth entitlement status persistence failed', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async clearEntitlementStatus(provider: string): Promise<void> {
    try {
      const current = await this.readEntitlements();
      if (current.providers[provider] === undefined) return;
      const providers = { ...current.providers };
      delete providers[provider];
      if (Object.keys(providers).length === 0) {
        await this.atomicDocs.delete(this.bootstrap.scope('store'), AUTH_STATE_KEY);
        return;
      }
      await this.atomicDocs.set(this.bootstrap.scope('store'), AUTH_STATE_KEY, {
        version: 1,
        providers,
      } satisfies PersistedOAuthEntitlements);
    } catch (error) {
      this.log.warn('oauth entitlement status cleanup failed', {
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
    // Reload so external file edits reach the kosong registries through the
    // persistence bridge, then read the RUNTIME state from the registries —
    // the config sections are only their persistence and may lag a pending
    // kosong-originated persist.
    await this.config.reload();
    const providers = this.providerService.list();
    const models = this.modelService.list();
    const modelId = modelOverride ?? this.modelService.getDefaultModel();
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

export class OAuthToolkitService extends KimiOAuthToolkit implements IOAuthToolkit {
  declare readonly _serviceBrand: undefined;
  private readonly openAICodexStorage: FileTokenStorage;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super({ homeDir: bootstrap.homeDir });
    this.openAICodexStorage = new FileTokenStorage(join(bootstrap.homeDir, 'credentials'));
  }

  override async login(
    providerName?: string,
    options: KimiOAuthLoginOptions = {},
  ): Promise<KimiOAuthLoginResult> {
    const provider = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const configuredOAuthRef =
      options.oauthRef?.key === undefined ? undefined : { key: options.oauthRef.key };
    if (!isOpenAICodexAuth(provider, configuredOAuthRef)) {
      return super.login(provider, options);
    }

    const oauthRef = { key: options.oauthRef?.key ?? OPENAI_CODEX_OAUTH_KEY };
    const tokenProvider = createOpenAICodexTokenProvider({
      storage: this.openAICodexStorage,
      providerName: provider,
      oauthRef,
    });
    try {
      await tokenProvider.getAccessToken();
      return { providerName: provider, ok: true };
    } catch (error) {
      if (!(error instanceof OAuthUnauthorizedError)) throw error;
    }

    const token = await loginOpenAICodexDeviceCode({
      signal: options.signal,
      onDeviceCode: (device) => {
        void options.onDeviceCode?.({
          userCode: device.userCode,
          deviceCode: '',
          verificationUri: device.verificationUri,
          verificationUriComplete: device.verificationUri,
          expiresIn: device.expiresIn,
          interval: device.interval,
        });
      },
    });
    const storageName = resolveKimiTokenStorageName({
      providerName: provider,
      oauthKey: oauthRef.key,
    });
    await this.openAICodexStorage.save(storageName, token);
    return { providerName: provider, ok: true };
  }
}

registerScopedService(LifecycleScope.App, IOAuthService, OAuthService, InstantiationType.Eager, 'auth');
registerScopedService(LifecycleScope.App, IOAuthToolkit, OAuthToolkitService, InstantiationType.Eager, 'auth');
registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, InstantiationType.Eager, 'auth');
