import { homedir } from 'node:os';
import { join } from 'node:path';

import { isBusinessMembershipRevokedCode } from './business-membership';
import { KIMI_CODE_FLOW_CONFIG } from './constants';
import { OAuthUnauthorizedError, OAuthWorkspaceSwitchError } from './errors';
import {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from './identity';
import {
  KIMI_CODE_OAUTH_KEY,
  KIMI_CODE_PROVIDER_NAME,
  ManagedKimiCodeModelsAuthError,
  provisionManagedKimiCodeConfig,
  resolveKimiCodeOAuthKey,
  type ManagedKimiCodeProvisionResult,
  type ManagedKimiConfigAdapter,
} from './managed-kimi-code';
import {
  fetchManagedUserInfo,
  kimiCodeUserInfoUrl,
  type ManagedUserInfoResult,
} from './managed-userinfo';
import {
  fetchManagedUsage,
  kimiCodeUsageUrl,
  type FetchManagedUsageError,
  type ManagedQuota,
} from './managed-usage';
import {
  fetchManagedAccountProfile,
  fetchManagedWorkspaces,
  kimiCodeWorkspacesUrl,
  type ManagedAccountProfile,
  type ManagedAccountProfileResult,
  type ManagedWorkspacesResult,
  type WorkspaceTarget,
} from './managed-workspaces';
import { OAuthManager, type LoginOptions, type OAuthManagerOptions } from './oauth-manager';
import { FileTokenStorage, type TokenStorage } from './storage';
import type { OAuthFlowConfig } from './types';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
  readonly isNonRecoverableErrorCode?: (code: string) => boolean;
}

export interface AuthProviderStatus {
  readonly providerName: string;
  readonly hasToken: boolean;
}

export interface AuthStatus {
  readonly providers: readonly AuthProviderStatus[];
}

export interface KimiOAuthToolkitOptions<TConfig = unknown> {
  readonly identity?: KimiHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly credentialsDir?: string | undefined;
  readonly storage?: TokenStorage | undefined;
  readonly flowConfig?: OAuthFlowConfig | undefined;
  readonly configAdapter?: ManagedKimiConfigAdapter<TConfig> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: OAuthManagerOptions['now'];
  readonly sleep?: OAuthManagerOptions['sleep'];
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly refreshThreshold?: OAuthManagerOptions['refreshThreshold'];
  readonly onRefresh?: OAuthManagerOptions['onRefresh'];
}

export interface KimiOAuthLoginOptions extends LoginOptions {
  readonly provisionConfig?: boolean | undefined;
  readonly baseUrl?: string | undefined;
  readonly oauthRef?: KimiOAuthTokenRef | undefined;
  readonly oauthHost?: string | undefined;
}

export interface KimiOAuthTokenRef {
  readonly key?: string | undefined;
  readonly oauthHost?: string | undefined;
}

export interface KimiOAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly provision?: ManagedKimiCodeProvisionResult | undefined;
}

export interface KimiOAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export type AuthManagedUsageResult =
  | {
      readonly kind: 'ok';
      readonly quota: ManagedQuota;
    }
  | FetchManagedUsageError;

export type AuthManagedUserInfoResult = ManagedUserInfoResult;

export interface KimiOAuthWorkspaceOptions {
  readonly oauthRef?: KimiOAuthTokenRef;
  readonly baseUrl?: string;
  readonly oauthHost?: string;
  readonly provisionConfig?: boolean;
}

export interface KimiOAuthWorkspaceSwitchResult {
  readonly providerName: string;
  readonly ok: true;
  readonly target: WorkspaceTarget;
  readonly provision?: ManagedKimiCodeProvisionResult;
  readonly profile?: ManagedAccountProfile;
  readonly warning?: string;
}

export class KimiOAuthToolkit<TConfig = unknown> {
  private readonly homeDir: string;
  private readonly identity: KimiHostIdentity | undefined;
  private readonly storage: TokenStorage;
  private readonly flowConfig: OAuthFlowConfig;
  private readonly configAdapter: ManagedKimiConfigAdapter<TConfig> | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly managerOptions: Pick<
    OAuthManagerOptions,
    'now' | 'sleep' | 'deviceCodeTimeoutMs' | 'refreshThreshold' | 'onRefresh'
  >;
  private readonly managers = new Map<string, OAuthManager>();
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  private _identityHeaders: Record<string, string> | undefined;

  constructor(options: KimiOAuthToolkitOptions<TConfig>) {
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = options.homeDir ?? defaultKimiHome();
    const credentialsDir = options.credentialsDir ?? join(this.homeDir, 'credentials');
    this.storage = options.storage ?? new FileTokenStorage(credentialsDir);
    this.flowConfig = options.flowConfig ?? KIMI_CODE_FLOW_CONFIG;
    this.configAdapter = options.configAdapter;
    this.fetchImpl = options.fetchImpl;
    this.managerOptions = {
      now: options.now,
      sleep: options.sleep,
      deviceCodeTimeoutMs: options.deviceCodeTimeoutMs,
      refreshThreshold: options.refreshThreshold,
      onRefresh: options.onRefresh,
    };
  }

  async status(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): Promise<AuthStatus> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return {
      providers: [
        {
          providerName: name,
          hasToken: await this.managerFor(name, oauthKey, oauthHost).hasToken(),
        },
      ],
    };
  }

  async login(
    providerName?: string,
    options: KimiOAuthLoginOptions = {},
  ): Promise<KimiOAuthLoginResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(options.oauthRef, options.oauthHost);
    const oauthKey = options.oauthRef?.key ?? this.defaultOAuthKey(options.baseUrl, oauthHost);
    const manager = this.managerFor(name, oauthKey, oauthHost);
    const hadToken = await manager.hasToken();
    let usedDeviceLogin = false;
    const loginWithDevice = async (): Promise<string> => {
      usedDeviceLogin = true;
      return (
        await manager.login({
          signal: options.signal,
          onDeviceCode: options.onDeviceCode,
        })
      ).accessToken;
    };
    let accessToken: string;
    if (hadToken) {
      try {
        accessToken = await manager.ensureFresh();
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError)) throw error;
        accessToken = await loginWithDevice();
      }
    } else {
      accessToken = await loginWithDevice();
    }

    const shouldProvision = options.provisionConfig ?? this.configAdapter !== undefined;
    const configAdapter = this.configAdapter;
    let provision: ManagedKimiCodeProvisionResult | undefined;
    if (shouldProvision && configAdapter !== undefined) {
      const provisionWithToken = (token: string): Promise<ManagedKimiCodeProvisionResult> =>
        provisionManagedKimiCodeConfig({
          accessToken: token,
          adapter: configAdapter,
          baseUrl: options.baseUrl,
          oauthKey,
          oauthHost,
          preserveDefaultModel: hadToken,
          fetchImpl: this.fetchImpl,
          headers: this.identityHeaders(),
        });
      try {
        provision = await provisionWithToken(accessToken);
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError) || !hadToken || usedDeviceLogin) {
          throw error;
        }
        if (
          error instanceof ManagedKimiCodeModelsAuthError &&
          isBusinessMembershipRevokedCode(error.errorCode)
        ) {
          provision = await provisionWithToken(await loginWithDevice());
        } else {
          let retryToken: string;
          try {
            retryToken = await manager.ensureFresh({ force: true });
          } catch (refreshError) {
            if (!(refreshError instanceof OAuthUnauthorizedError)) throw refreshError;
            retryToken = await loginWithDevice();
          }
          try {
            provision = await provisionWithToken(retryToken);
          } catch (retryError) {
            if (!(retryError instanceof OAuthUnauthorizedError) || usedDeviceLogin) {
              throw retryError;
            }
            provision = await provisionWithToken(await loginWithDevice());
          }
        }
      }
    }

    return { providerName: name, ok: true, provision };
  }

  async logout(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): Promise<KimiOAuthLogoutResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return this.enqueueMutation(this.mutationKeyFor(name, oauthKey, oauthHost), async () => {
      await this.managerFor(name, oauthKey, oauthHost).logout();
      if (this.configAdapter?.remove !== undefined && name === KIMI_CODE_PROVIDER_NAME) {
        const config = await this.configAdapter.read();
        this.configAdapter.remove(config);
        await this.configAdapter.write(config);
      }
      return { providerName: name, ok: true };
    });
  }

  async ensureFresh(
    providerName?: string,
    options: {
      readonly force?: boolean | undefined;
      readonly oauthRef?: KimiOAuthTokenRef | undefined;
    } = {},
  ): Promise<string> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(options.oauthRef);
    const oauthKey = options.oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return this.managerFor(name, oauthKey, oauthHost).ensureFresh(options);
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): Promise<string | undefined> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return this.managerFor(name, oauthKey, oauthHost).getCachedAccessToken();
  }

  tokenProvider(
    providerName?: string,
    oauthRef?: KimiOAuthTokenRef,
  ): BearerTokenProvider {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return {
      getAccessToken: (options) => this.managerFor(name, oauthKey, oauthHost).ensureFresh(options),
      isNonRecoverableErrorCode: isBusinessMembershipRevokedCode,
    };
  }

  async listWorkspaces(
    providerName?: string,
    options: KimiOAuthWorkspaceOptions = {},
  ): Promise<ManagedWorkspacesResult> {
    return this.withManagedAccessToken(providerName, options, (accessToken) =>
      fetchManagedWorkspaces(
        managedWorkspacesUrl(options.baseUrl),
        accessToken,
        this.managedRequestInit(),
      ),
    );
  }

  async getAccountProfile(
    providerName?: string,
    options: KimiOAuthWorkspaceOptions = {},
  ): Promise<ManagedAccountProfileResult> {
    return this.withManagedAccessToken(providerName, options, (accessToken) =>
      fetchManagedAccountProfile({
        userInfoUrl: managedUserInfoUrl(options.baseUrl),
        workspacesUrl: managedWorkspacesUrl(options.baseUrl),
        accessToken,
        ...this.managedRequestInit(),
      }),
    );
  }

  async switchWorkspace(
    target: WorkspaceTarget,
    providerName?: string,
    options: KimiOAuthWorkspaceOptions = {},
  ): Promise<KimiOAuthWorkspaceSwitchResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(options.oauthRef, options.oauthHost);
    const oauthKey = options.oauthRef?.key ?? this.defaultOAuthKey(options.baseUrl, oauthHost);
    return this.enqueueMutation(this.mutationKeyFor(name, oauthKey, oauthHost), async () => {
      const manager = this.managerFor(name, oauthKey, oauthHost);
      const warnings: string[] = [];
      let switchedAccessToken: string;
      try {
        const switched = await manager.switchWorkspace(target);
        switchedAccessToken = switched.accessToken;
      } catch (error) {
        if (
          error instanceof OAuthWorkspaceSwitchError &&
          error.committed &&
          error.token !== undefined
        ) {
          switchedAccessToken = error.token.accessToken;
          warnings.push(error.message);
        } else {
          throw error;
        }
      }

      if (!(await manager.hasToken())) {
        throw new OAuthUnauthorizedError(
          `No token for "${name}". Run /login to authenticate.`,
        );
      }

      const shouldProvision = options.provisionConfig ?? this.configAdapter !== undefined;
      const configAdapter = this.configAdapter;
      let provision: ManagedKimiCodeProvisionResult | undefined;
      if (shouldProvision && configAdapter !== undefined) {
        let loggedOutDuringProvision = false;
        const guardedAdapter: ManagedKimiConfigAdapter<TConfig> = {
          ...configAdapter,
          write: async (nextConfig) => {
            if (!(await manager.hasToken())) {
              loggedOutDuringProvision = true;
              return;
            }
            await configAdapter.write(nextConfig);
          },
        };
        try {
          provision = await provisionManagedKimiCodeConfig({
            accessToken: switchedAccessToken,
            adapter: guardedAdapter,
            baseUrl: options.baseUrl,
            oauthKey,
            oauthHost,
            preserveDefaultModel: true,
            fetchImpl: this.fetchImpl,
            headers: this.identityHeaders(),
          });
        } catch (error) {
          warnings.push(
            `Failed to refresh model config: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (loggedOutDuringProvision || !(await manager.hasToken())) {
          throw new OAuthUnauthorizedError(
            `No token for "${name}". Run /login to authenticate.`,
          );
        }
      }

      const profileRes = await fetchManagedAccountProfile({
        userInfoUrl: managedUserInfoUrl(options.baseUrl),
        workspacesUrl: managedWorkspacesUrl(options.baseUrl),
        accessToken: switchedAccessToken,
        ...this.managedRequestInit(),
      });
      if (!(await manager.hasToken())) {
        throw new OAuthUnauthorizedError(
          `No token for "${name}". Run /login to authenticate.`,
        );
      }
      const profile = profileRes.kind === 'ok' ? profileRes.profile : undefined;
      if (profileRes.kind === 'error') {
        warnings.push(profileRes.message);
      }

      const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
      return {
        providerName: name,
        ok: true,
        target,
        ...(provision !== undefined ? { provision } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(warning !== undefined ? { warning } : {}),
      };
    });
  }

  async getManagedUsage(
    providerName?: string,
    options: {
      readonly oauthRef?: KimiOAuthTokenRef | undefined;
      readonly baseUrl?: string | undefined;
    } = {},
  ): Promise<AuthManagedUsageResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name, {
        oauthRef: options.oauthRef ?? this.defaultOAuthRef(options.baseUrl),
      });
      const result = await fetchManagedUsage(managedUsageUrl(options.baseUrl), accessToken);
      if (result.kind === 'error') return result;
      return { kind: 'ok', quota: result.quota };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getManagedUserInfo(
    providerName?: string,
    options: {
      readonly oauthRef?: KimiOAuthTokenRef | undefined;
      readonly baseUrl?: string | undefined;
    } = {},
  ): Promise<AuthManagedUserInfoResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name, {
        oauthRef: options.oauthRef ?? this.defaultOAuthRef(options.baseUrl),
      });
      const result = await fetchManagedUserInfo(managedUserInfoUrl(options.baseUrl), accessToken);
      if (result.kind === 'error') return result;
      return { kind: 'ok', userInfo: result.userInfo };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  managerFor(
    providerName: string,
    oauthKey = KIMI_CODE_OAUTH_KEY,
    oauthHost?: string,
  ): OAuthManager {
    const storageName = resolveKimiTokenStorageName({ providerName, oauthKey });
    const effectiveOAuthHost = oauthHost ?? this.flowConfig.oauthHost;
    const managerKey = `${storageName}\0${normalizeOAuthHost(effectiveOAuthHost)}`;
    let manager = this.managers.get(managerKey);
    if (manager !== undefined) return manager;

    const identity = this.identity;
    manager = new OAuthManager({
      config: {
        ...this.flowConfig,
        oauthHost: effectiveOAuthHost,
        name: storageName,
      },
      storage: this.storage,
      configDir: this.homeDir,
      deviceHeaders:
        identity === undefined
          ? undefined
          : () =>
              createKimiDefaultHeaders({
                homeDir: this.homeDir,
                ...identity,
              }),
      ...this.managerOptions,
    });
    this.managers.set(managerKey, manager);
    return manager;
  }

  private mutationKeyFor(providerName: string, oauthKey: string, oauthHost: string): string {
    const storageName = resolveKimiTokenStorageName({ providerName, oauthKey });
    return `${storageName}\0${normalizeOAuthHost(oauthHost)}`;
  }

  private enqueueMutation<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.mutationQueues.get(key);
    const run = (prior === undefined ? fn() : prior.catch(() => undefined).then(fn)).finally(() => {
      if (this.mutationQueues.get(key) === run) {
        this.mutationQueues.delete(key);
      }
    });
    this.mutationQueues.set(key, run);
    return run;
  }

  private defaultOAuthKey(
    baseUrl?: string,
    oauthHost?: string,
  ): string {
    return resolveKimiCodeOAuthKey({
      oauthHost: oauthHost ?? this.flowConfig.oauthHost,
      baseUrl,
    });
  }

  private defaultOAuthRef(baseUrl?: string): KimiOAuthTokenRef {
    return {
      key: this.defaultOAuthKey(baseUrl, this.flowConfig.oauthHost),
      oauthHost: this.flowConfig.oauthHost,
    };
  }

  private oauthHostFor(
    oauthRef?: KimiOAuthTokenRef,
    oauthHost?: string,
  ): string {
    return oauthRef?.oauthHost ?? oauthHost ?? this.flowConfig.oauthHost;
  }

  private managedRequestInit(): {
    readonly fetchImpl?: typeof fetch;
    readonly headers?: Readonly<Record<string, string>>;
  } {
    const headers = this.identityHeaders();
    return {
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(headers !== undefined ? { headers } : {}),
    };
  }

  private async withManagedAccessToken<TResult>(
    providerName: string | undefined,
    options: KimiOAuthWorkspaceOptions,
    run: (accessToken: string) => Promise<TResult>,
  ): Promise<TResult | { readonly kind: 'error'; readonly message: string }> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name, {
        oauthRef: options.oauthRef ?? this.defaultOAuthRef(options.baseUrl),
      });
      return await run(accessToken);
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private identityHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    this._identityHeaders ??= createKimiDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
    return this._identityHeaders;
  }
}

export function resolveKimiTokenStorageName(input: {
  readonly providerName?: string | undefined;
  readonly oauthKey?: string | undefined;
}): string {
  const key = input.oauthKey ?? KIMI_CODE_OAUTH_KEY;
  if (key === 'kimi-code' || key === KIMI_CODE_OAUTH_KEY) return 'kimi-code';

  const prefix = 'oauth/';
  if (key.startsWith(prefix) && key.slice(prefix.length).length > 0) {
    return key.slice(prefix.length);
  }

  if (!key.includes('/') && !key.startsWith('.')) return key;
  throw new Error(`Invalid Kimi OAuth token key: "${key}".`);
}

function defaultKimiHome(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.kimi-code');
}

function managedUsageUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return kimiCodeUsageUrl();
  return `${baseUrl.replace(/\/+$/, '')}/usages`;
}

function managedUserInfoUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return kimiCodeUserInfoUrl();
  return `${baseUrl.replace(/\/+$/, '')}/me`;
}

function managedWorkspacesUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return kimiCodeWorkspacesUrl();
  return `${baseUrl.replace(/\/+$/, '')}/workspaces`;
}

function normalizeOAuthHost(oauthHost: string): string {
  return oauthHost.trim().replace(/\/+$/, '');
}
