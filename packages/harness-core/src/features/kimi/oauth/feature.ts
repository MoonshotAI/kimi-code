import {
  CatalogModels,
  ConfigRef,
  createFeature,
  createOAuthCredentialProvider,
  createProvider,
  DEFAULT_MODEL_CONFIG_SECTION,
  matchCatalogBinding,
  MODEL_CATALOG_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  ProviderProtocols,
  THINKING_CONFIG_SECTION,
  useCredentialResolver,
  useProviderCatalog,
  type CatalogOAuthRef,
  type CatalogProviderInfo,
  type FeatureSlots,
  type FeatureSpec,
  type LlmModelSeed,
  type ModelCatalogConfig,
  type ModelsSection,
  type ProtocolBinding,
  type ProvidersSection,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  lineage,
  pushCleanup,
  useCollection,
  useExpose,
  useNode,
  watch,
  type UnitNode,
} from '@moonshot-ai/agent-core/kernel/index';
import {
  fetchManagedKimiCodeModels,
  fetchManagedUsage,
  fetchManagedUserInfo,
  KIMI_CODE_FLOW_CONFIG,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  kimiCodeUsageUrl,
  kimiCodeUserInfoUrl,
  kimiRegionLoginHosts,
  OAuthUnauthorizedError,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  resolveKimiRegion,
  type DeviceAuthorization,
  type KimiRegion,
  type ManagedKimiRuntimeAuth,
  type ManagedUsageResult,
  type ManagedUserInfoResult,
  type OAuthManager,
} from '@moonshot-ai/kimi-code-oauth';

import { SERVICES_CONFIG_SECTION, type ServicesSection } from '../web/configSection';

import {
  classifyLoginFailure,
  LOGIN_DEFAULT_DEVICE_EXPIRES_IN_SEC,
  LOGIN_TERMINAL_RETENTION_MS,
  toFlowSnapshot,
  toFlowStart,
  type AuthSummary,
  type LoginFlowState,
  type ManagedProviderSummary,
  type OAuthFlowStart,
  type OAuthFlowStatus,
} from './auth';
import { managedKimiCodeModelSeed } from './models';
import { createOAuthTokenResolver, resolveOauthHome, type OAuthTokens } from './tokens';

export const OAuthTokensRef = createToken<OAuthTokens>('oauth.tokens');

export const DEFAULT_OAUTH_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CreateOauthProps {
  readonly home?: string;
  readonly fetchImpl?: typeof fetch;
}

export function useOauth(): OAuthTokens {
  return inject(OAuthTokensRef);
}

export function createOauthSlots(props: CreateOauthProps = {}): FeatureSlots {
  const home = resolveOauthHome(props.home);
  return {
    app() {
      const node = useNode();
      const catalog = useProviderCatalog();
      const configEntries = node.providerRef(ConfigRef);
      const tokens = createOAuthTokenResolver(home);
      const protocolFactories = useCollection(ProviderProtocols);
      const bindings = useCollection(CatalogModels);
      const aliasScopeWrites = new Map<string, Promise<void>>();
      const materializing = new Set<string>();
      const flows = new Map<string, LoginFlowState>();
      let refreshOnStartPending = false;
      const fetchCatalog = async (info: CatalogProviderInfo): Promise<readonly LlmModelSeed[]> => {
        const ref = info.oauth;
        if (ref === undefined) return [];
        const token = tokens.resolve(ref);
        if (token === undefined) return [];
        const accessToken = await token.getAccessToken();
        const models = await fetchManagedKimiCodeModels({
          accessToken,
          baseUrl: info.baseUrl,
          fetchImpl: props.fetchImpl,
        });
        return models.map(managedKimiCodeModelSeed);
      };
      const setTerminal = (state: LoginFlowState, status: Exclude<OAuthFlowStatus, 'pending'>): void => {
        state.status = status;
        state.resolvedAt = new Date().toISOString();
        const timer = setTimeout(() => {
          if (flows.get(state.provider) === state) {
            flows.delete(state.provider);
          }
        }, LOGIN_TERMINAL_RETENTION_MS);
        timer.unref();
        state.gcTimer = timer;
      };
      const abortExisting = (provider: string): void => {
        const existing = flows.get(provider);
        if (existing !== undefined && existing.status === 'pending') {
          existing.controller.abort();
          setTerminal(existing, 'cancelled');
        }
      };
      const resolveLoginAuth = (
        provider: string,
        region?: KimiRegion,
      ): {
        readonly oauthRef: CatalogOAuthRef | undefined;
        readonly baseUrl: string | undefined;
        readonly oauthHost: string | undefined;
      } => {
        const info = catalog.providerInfo(provider);
        if (provider !== KIMI_CODE_PROVIDER_NAME) {
          return { oauthRef: info?.oauth, baseUrl: undefined, oauthHost: undefined };
        }
        const hosts = region === undefined ? undefined : kimiRegionLoginHosts(region);
        const loginAuth = resolveKimiCodeLoginAuth({
          configuredBaseUrl: info?.baseUrl,
          configuredOAuthRef: info?.oauth,
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
      };
      const loginManager = (auth: {
        readonly oauthRef: CatalogOAuthRef | undefined;
        readonly baseUrl: string | undefined;
        readonly oauthHost: string | undefined;
      }): OAuthManager | undefined => {
        const oauthHost = auth.oauthRef?.oauthHost ?? auth.oauthHost ?? KIMI_CODE_FLOW_CONFIG.oauthHost;
        const key = auth.oauthRef?.key ?? resolveKimiCodeOAuthKey({ oauthHost, baseUrl: auth.baseUrl });
        return tokens.manager({ storage: 'file', key, oauthHost });
      };
      const provisionAfterLogin = async (
        provider: string,
        oauthRef: CatalogOAuthRef | undefined,
        loginBaseUrl: string | undefined,
      ): Promise<void> => {
        if (oauthRef === undefined && provider !== KIMI_CODE_PROVIDER_NAME) return;
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) return;
        const baseUrl = loginBaseUrl ?? catalog.providerInfo(provider)?.baseUrl ?? kimiCodeBaseUrl();
        await config.set(
          PROVIDERS_CONFIG_SECTION,
          {
            [provider]: {
              type: 'kimi',
              baseUrl,
              apiKey: '',
              oauth: oauthRef,
              modelSource: 'oauth-catalog',
            },
          },
          'user',
        );
      };
      const healDefaultModelAfterManagedLogin = (): void => {
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) return;
        const stop = watch(
          () => catalog.models(KIMI_CODE_PROVIDER_NAME),
          (models) => {
            const first = models[0];
            if (first === undefined) return;
            stop();
            const current = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
            if (current !== undefined && current !== '') {
              const entry = config.get<ModelsSection>(MODELS_CONFIG_SECTION)?.[current];
              if (entry !== undefined && entry.provider !== KIMI_CODE_PROVIDER_NAME) return;
              if (
                matchCatalogBinding(current, bindings.value, (providerId) =>
                  catalog.providerInfo(providerId),
                ) !== undefined
              ) {
                return;
              }
            }
            const scope =
              catalog.providerInfo(KIMI_CODE_PROVIDER_NAME)?.aliasScope ?? KIMI_CODE_PROVIDER_NAME;
            void config.set(DEFAULT_MODEL_CONFIG_SECTION, `${scope}/${first.model}`, 'user').catch(() => {});
          },
          { immediate: true },
        );
        pushCleanup(node, stop);
      };
      const provisionAfterSuccess = async (state: LoginFlowState): Promise<void> => {
        try {
          await provisionAfterLogin(state.provider, state.oauthRef, state.loginBaseUrl);
          if (flows.get(state.provider) !== state) return;
          if (state.provider === KIMI_CODE_PROVIDER_NAME) {
            if (catalog.isLive(KIMI_CODE_PROVIDER_NAME)) facade.refresh();
            healDefaultModelAfterManagedLogin();
          }
        } catch {
        } finally {
          if (state.status === 'pending') {
            setTerminal(state, 'authenticated');
          }
        }
      };
      const handleSuccess = (state: LoginFlowState): void => {
        if (state.status !== 'pending') return;
        state.tokenGranted = true;
        void provisionAfterSuccess(state);
      };
      const completeAlreadyAuthenticated = async (state: LoginFlowState): Promise<void> => {
        if (state.status !== 'pending') return;
        state.tokenGranted = true;
        await provisionAfterSuccess(state);
      };
      const handleFailure = (state: LoginFlowState, error: unknown): void => {
        if (state.status !== 'pending') return;
        state.errorMessage = error instanceof Error ? error.message : String(error);
        setTerminal(state, classifyLoginFailure(error));
      };
      const deprovisionAfterLogout = async (provider: string): Promise<void> => {
        if (provider !== KIMI_CODE_PROVIDER_NAME) return;
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) return;
        await aliasScopeWrites.get(provider);
        const providers = { ...(config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {}) };
        const removedProvider = Object.hasOwn(providers, KIMI_CODE_PROVIDER_NAME);
        delete providers[KIMI_CODE_PROVIDER_NAME];
        const models = { ...(config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {}) };
        const removedModels: string[] = [];
        for (const [key, model] of Object.entries(models)) {
          if (model?.provider !== KIMI_CODE_PROVIDER_NAME) continue;
          delete models[key];
          removedModels.push(key);
        }
        const services = config.get<ServicesSection>(SERVICES_CONFIG_SECTION);
        const nextServices = services === undefined ? undefined : { ...services };
        const removedServices: string[] = [];
        if (nextServices !== undefined) {
          for (const key of ['moonshot_search', 'moonshot_fetch'] as const) {
            if (nextServices[key] === undefined) continue;
            delete nextServices[key];
            removedServices.push(key);
          }
        }
        const defaultModel = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
        const defaultModelCleared = defaultModel !== undefined && removedModels.includes(defaultModel);
        if (!removedProvider && removedModels.length === 0 && !defaultModelCleared && removedServices.length === 0) {
          return;
        }
        if (removedProvider) {
          await config.replace({ [PROVIDERS_CONFIG_SECTION]: providers }, 'user');
        }
        if (removedModels.length > 0) {
          await config.replace({ [MODELS_CONFIG_SECTION]: models }, 'user');
        }
        if (removedServices.length > 0) {
          await config.replace({ [SERVICES_CONFIG_SECTION]: nextServices }, 'user');
        }
        if (defaultModelCleared) {
          await config.replace(
            { [DEFAULT_MODEL_CONFIG_SECTION]: undefined, [THINKING_CONFIG_SECTION]: undefined },
            'user',
          );
        }
      };
      const runtimeAuthFor = (provider: string): ManagedKimiRuntimeAuth => {
        const info = catalog.providerInfo(provider);
        return resolveKimiCodeRuntimeAuth({
          configuredBaseUrl: info?.baseUrl,
          configuredOAuthRef: info?.oauth,
        });
      };
      const managedLoggedIn = async (): Promise<boolean> => {
        try {
          const auth = runtimeAuthFor(KIMI_CODE_PROVIDER_NAME);
          const manager = tokens.manager({
            storage: 'file',
            key: auth.oauthRef.key,
            oauthHost: auth.oauthRef.oauthHost,
          });
          if (manager === undefined) return false;
          return (await manager.getCachedAccessToken()) !== undefined;
        } catch {
          return false;
        }
      };
      const facade: OAuthTokens = {
        resolve: (ref) => tokens.resolve(ref),
        refresh: () => {
          for (const providerId of catalog.providers()) {
            if (catalog.providerInfo(providerId)?.modelSource !== 'oauth-catalog') continue;
            if (catalog.isLive(providerId)) catalog.refresh(providerId);
          }
        },
        loginStart: async (input) => {
          const provider = input?.provider ?? KIMI_CODE_PROVIDER_NAME;
          const auth = resolveLoginAuth(provider, input?.region);
          abortExisting(provider);
          const state: LoginFlowState = {
            flowId: `oauth_${crypto.randomUUID()}`,
            provider,
            controller: new AbortController(),
            oauthRef: auth.oauthRef,
            loginBaseUrl: auth.baseUrl,
            startedAt: Date.now(),
            device: undefined,
            status: 'pending',
            tokenGranted: false,
            expiresAt: Date.now() + LOGIN_DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
            gcTimer: undefined,
            errorMessage: undefined,
            resolvedAt: undefined,
          };
          flows.set(provider, state);
          const manager = loginManager(auth);
          if (manager === undefined) {
            flows.delete(provider);
            throw new Error(`OAuth login is not available for provider "${provider}".`);
          }
          let resolveDevice!: (device: DeviceAuthorization) => void;
          let rejectDevice!: (error: unknown) => void;
          const deviceReady = new Promise<DeviceAuthorization>((resolve, reject) => {
            resolveDevice = resolve;
            rejectDevice = reject;
          });
          const loginPromise = (async (): Promise<void> => {
            if (await manager.hasToken()) {
              try {
                await manager.ensureFresh();
                return;
              } catch (error) {
                if (!(error instanceof OAuthUnauthorizedError)) throw error;
              }
            }
            await manager.login({
              signal: state.controller.signal,
              onDeviceCode: (device) => {
                state.device = device;
                if (device.expiresIn !== null) {
                  state.expiresAt = Date.now() + device.expiresIn * 1000;
                }
                resolveDevice(device);
              },
            });
          })();
          const fastPath: Promise<OAuthFlowStart | undefined> = loginPromise.then(async () => {
            if (state.device !== undefined) return undefined;
            await completeAlreadyAuthenticated(state);
            return {
              flow_id: state.flowId,
              provider: state.provider,
              status: 'authenticated' as const,
            };
          });
          loginPromise.then(
            () => {
              if (state.device !== undefined) {
                handleSuccess(state);
              }
            },
            (error) => {
              handleFailure(state, error);
              rejectDevice(error);
            },
          );
          const winner = await Promise.race([
            deviceReady.then((device) => ({ kind: 'device' as const, device })),
            fastPath.then((result) => ({ kind: 'fast' as const, result })),
          ]);
          if (winner.kind === 'fast' && winner.result !== undefined) {
            return winner.result;
          }
          const device = winner.kind === 'device' ? winner.device : await deviceReady;
          return toFlowStart(state, device);
        },
        loginStatus: (provider = KIMI_CODE_PROVIDER_NAME) => {
          const state = flows.get(provider);
          if (state === undefined || state.device === undefined) return undefined;
          return toFlowSnapshot(state, state.device);
        },
        loginCancel: (provider = KIMI_CODE_PROVIDER_NAME) => {
          const state = flows.get(provider);
          if (state === undefined || state.status !== 'pending') {
            return { cancelled: false, status: state?.status ?? 'cancelled' };
          }
          state.controller.abort();
          setTerminal(state, 'cancelled');
          return { cancelled: true, status: 'cancelled' };
        },
        logout: async (provider = KIMI_CODE_PROVIDER_NAME) => {
          const ref =
            provider === KIMI_CODE_PROVIDER_NAME
              ? runtimeAuthFor(provider).oauthRef
              : catalog.providerInfo(provider)?.oauth;
          const oauthHost = ref?.oauthHost ?? KIMI_CODE_FLOW_CONFIG.oauthHost;
          const key = ref?.key ?? resolveKimiCodeOAuthKey({ oauthHost, baseUrl: undefined });
          const manager = tokens.manager({ storage: 'file', key, oauthHost });
          if (manager !== undefined) {
            await manager.logout();
          }
          abortExisting(provider);
          await deprovisionAfterLogout(provider);
          return { logged_out: true, provider };
        },
        usage: async (provider = KIMI_CODE_PROVIDER_NAME): Promise<ManagedUsageResult> => {
          try {
            const auth = runtimeAuthFor(provider);
            const token = tokens.resolve(auth.oauthRef);
            if (token === undefined) {
              return {
                kind: 'error',
                message: `OAuth token provider is not configured for "${provider}".`,
              };
            }
            const accessToken = await token.getAccessToken();
            const url =
              auth.baseUrl === undefined
                ? kimiCodeUsageUrl()
                : `${auth.baseUrl.replace(/\/+$/, '')}/usages`;
            return await fetchManagedUsage(url, accessToken);
          } catch (error) {
            return {
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
        userinfo: async (provider = KIMI_CODE_PROVIDER_NAME): Promise<ManagedUserInfoResult> => {
          try {
            const auth = runtimeAuthFor(provider);
            const token = tokens.resolve(auth.oauthRef);
            if (token === undefined) {
              return {
                kind: 'error',
                message: `OAuth token provider is not configured for "${provider}".`,
              };
            }
            const accessToken = await token.getAccessToken();
            const url =
              auth.baseUrl === undefined
                ? kimiCodeUserInfoUrl()
                : `${auth.baseUrl.replace(/\/+$/, '')}/me`;
            return await fetchManagedUserInfo(url, accessToken);
          } catch (error) {
            return {
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
        region: (): KimiRegion => {
          const oauth = catalog.providerInfo(KIMI_CODE_PROVIDER_NAME)?.oauth;
          return resolveKimiRegion({
            configuredOAuthHost: oauth?.oauthHost,
            configuredOAuthKey: oauth?.key,
            readMarker: process.env['KIMI_CODE_REGION_MARKER'] !== 'off',
            homeDir: home,
          });
        },
        summary: async (): Promise<AuthSummary> => {
          const config = configEntries.value.at(-1)?.value;
          const providers: ProvidersSection =
            config !== undefined
              ? (config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {})
              : Object.fromEntries(
                  catalog.providers().map((providerId) => [
                    providerId,
                    catalog.providerInfo(providerId) ?? {},
                  ]),
                );
          const defaultModel = config?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
          const modelsReady =
            defaultModel !== undefined && defaultModel.length > 0
              ? matchCatalogBinding(defaultModel, bindings.value, (providerId) =>
                  catalog.providerInfo(providerId),
                ) !== undefined
              : false;
          let managedProvider: ManagedProviderSummary | null = null;
          if (providers[KIMI_CODE_PROVIDER_NAME] !== undefined) {
            managedProvider = {
              name: KIMI_CODE_PROVIDER_NAME,
              status: (await managedLoggedIn()) ? 'authenticated' : 'unauthenticated',
            };
          }
          return {
            models_ready: modelsReady,
            providers_count: Object.keys(providers).length,
            managed_provider: managedProvider,
          };
        },
      };
      const runStartRefresh = (): void => {
        if (!refreshOnStartPending || materializing.size > 0) return;
        refreshOnStartPending = false;
        facade.refresh();
      };
      useExpose(OAuthTokensRef, facade);
      useCredentialResolver({
        resolve: (info) => {
          const ref = info.oauth;
          if (ref === undefined) return undefined;
          return createOAuthCredentialProvider(async (options) => {
            const token = tokens.resolve(ref);
            if (token === undefined) return undefined;
            try {
              return await token.getAccessToken({ force: options?.force });
            } catch {
              return undefined;
            }
          });
        },
      });
      watch(
        () =>
          configEntries.value.at(-1)?.value.section<ProvidersSection>(PROVIDERS_CONFIG_SECTION)
            .value,
        (providers) => {
          const config = configEntries.value.at(-1)?.value;
          const entry = providers?.[KIMI_CODE_PROVIDER_NAME];
          if (config === undefined || entry === undefined || entry.aliasScope !== undefined) return;
          const write = config
            .set(
              PROVIDERS_CONFIG_SECTION,
              { [KIMI_CODE_PROVIDER_NAME]: { aliasScope: KIMI_CODE_PLATFORM_ID } },
              'user',
            )
            .catch(() => {})
            .finally(() => {
              aliasScopeWrites.delete(KIMI_CODE_PROVIDER_NAME);
            });
          aliasScopeWrites.set(KIMI_CODE_PROVIDER_NAME, write);
        },
        { immediate: true },
      );
      watch(
        () => [catalog.snapshot.value, protocolFactories.value],
        () => {
          for (const [providerId, entry] of Object.entries(catalog.snapshot.value.providers)) {
            const info = entry.info;
            if (info?.modelSource !== 'oauth-catalog' || info.type === undefined) continue;
            if (catalog.isLive(providerId) || materializing.has(providerId)) continue;
            const factory = protocolFactories.value.findLast(
              (contribution) => contribution.type === info.type,
            );
            if (factory === undefined) continue;
            const protocols: Record<string, ProtocolBinding | undefined> = factory.protocols(info);
            if (Object.values(protocols).every((binding) => binding === undefined)) continue;
            materializing.add(providerId);
            void (async () => {
              try {
                await aliasScopeWrites.get(providerId);
                if (catalog.isLive(providerId)) return;
                catalog.refresh(
                  createProvider({
                    id: providerId,
                    protocols,
                    models: () => fetchCatalog(info),
                  }),
                );
              } finally {
                materializing.delete(providerId);
                runStartRefresh();
              }
            })();
          }
        },
        { immediate: true },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const root = [...lineage(node)].at(-1) as UnitNode;
      watch(
        () =>
          configEntries.value.at(-1)?.value.section<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION)
            .value,
        (section) => {
          clearTimer();
          const config = configEntries.value.at(-1)?.value;
          if (config === undefined) return;
          if (!started) {
            started = true;
            void root.ready().then(
              () => {
                const loaded = config.get<ModelCatalogConfig>(MODEL_CATALOG_CONFIG_SECTION);
                if (loaded?.refreshOnStart ?? true) {
                  refreshOnStartPending = true;
                  runStartRefresh();
                }
              },
              () => {},
            );
          }
          const interval = section?.refreshIntervalMs ?? DEFAULT_OAUTH_REFRESH_INTERVAL_MS;
          if (interval <= 0) return;
          const scheduleNext = (): void => {
            timer = setTimeout(() => {
              facade.refresh();
              scheduleNext();
            }, interval);
            timer.unref?.();
          };
          scheduleNext();
        },
        { immediate: true },
      );
      pushCleanup(node, clearTimer);
      pushCleanup(node, () => {
        for (const state of flows.values()) {
          if (state.gcTimer !== undefined) clearTimeout(state.gcTimer);
          if (state.status === 'pending') state.controller.abort();
        }
        flows.clear();
      });
    },
  };
}

export function createOauth(props: CreateOauthProps = {}): FeatureSpec {
  return createFeature('oauth', createOauthSlots(props));
}
