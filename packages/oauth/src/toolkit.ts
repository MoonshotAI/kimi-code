import { homedir } from 'node:os';
import { join } from 'node:path';

import { KIMI_CODE_FLOW_CONFIG } from './constants';
import { OAuthUnauthorizedError } from './errors';
import { assertKimiHostIdentity, createKimiDeviceHeaders, type KimiHostIdentity } from './identity';
import {
  fetchSubmitFeedback,
  kimiCodeFeedbackUrl,
  type FetchSubmitFeedbackResult,
  type SubmitFeedbackBody,
} from './managed-feedback';
import {
  KIMI_CODE_OAUTH_KEY,
  KIMI_CODE_PROVIDER_NAME,
  provisionManagedKimiCodeConfig,
  resolveKimiCodeOAuthKey,
  type ManagedKimiCodeProvisionResult,
  type ManagedKimiConfigAdapter,
} from './managed-kimi-code';
import {
  fetchManagedUsage,
  kimiCodeUsageUrl,
  type FetchManagedUsageError,
  type ParsedManagedUsage,
} from './managed-usage';
import { OAuthManager, type LoginOptions, type OAuthManagerOptions } from './oauth-manager';
import { FileTokenStorage, type TokenStorage } from './storage';
import type { OAuthFlowConfig } from './types';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
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
      readonly summary: ParsedManagedUsage['summary'];
      readonly limits: ParsedManagedUsage['limits'];
    }
  | FetchManagedUsageError;

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
    providerName?: string | undefined,
    oauthRef?: KimiOAuthTokenRef | undefined,
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
    providerName?: string | undefined,
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
        });
      try {
        provision = await provisionWithToken(accessToken);
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError) || !hadToken || usedDeviceLogin) {
          throw error;
        }
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

    return { providerName: name, ok: true, provision };
  }

  async logout(
    providerName?: string | undefined,
    oauthRef?: KimiOAuthTokenRef | undefined,
  ): Promise<KimiOAuthLogoutResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    await this.managerFor(name, oauthKey, oauthHost).logout();
    if (this.configAdapter?.remove !== undefined && name === KIMI_CODE_PROVIDER_NAME) {
      const config = await this.configAdapter.read();
      this.configAdapter.remove(config);
      await this.configAdapter.write(config);
    }
    return { providerName: name, ok: true };
  }

  async ensureFresh(
    providerName?: string | undefined,
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
    providerName?: string | undefined,
    oauthRef?: KimiOAuthTokenRef | undefined,
  ): BearerTokenProvider {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return {
      getAccessToken: (options) => this.managerFor(name, oauthKey, oauthHost).ensureFresh(options),
    };
  }

  async getManagedUsage(
    providerName?: string | undefined,
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
      return {
        kind: 'ok',
        summary: result.parsed.summary,
        limits: result.parsed.limits,
      };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async submitFeedback(
    body: SubmitFeedbackBody,
    providerName?: string | undefined,
    options: {
      readonly oauthRef?: KimiOAuthTokenRef | undefined;
      readonly baseUrl?: string | undefined;
    } = {},
  ): Promise<FetchSubmitFeedbackResult> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    try {
      const accessToken = await this.ensureFresh(name, {
        oauthRef: options.oauthRef ?? this.defaultOAuthRef(options.baseUrl),
      });
      return await fetchSubmitFeedback(managedFeedbackUrl(options.baseUrl), accessToken, body);
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
    oauthHost?: string | undefined,
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
              createKimiDeviceHeaders({
                homeDir: this.homeDir,
                version: identity.version,
              }),
      ...this.managerOptions,
    });
    this.managers.set(managerKey, manager);
    return manager;
  }

  private defaultOAuthKey(
    baseUrl?: string | undefined,
    oauthHost?: string | undefined,
  ): string {
    return resolveKimiCodeOAuthKey({
      oauthHost: oauthHost ?? this.flowConfig.oauthHost,
      baseUrl,
    });
  }

  private defaultOAuthRef(baseUrl?: string | undefined): KimiOAuthTokenRef {
    return {
      key: this.defaultOAuthKey(baseUrl, this.flowConfig.oauthHost),
      oauthHost: this.flowConfig.oauthHost,
    };
  }

  private oauthHostFor(
    oauthRef?: KimiOAuthTokenRef | undefined,
    oauthHost?: string | undefined,
  ): string {
    return oauthRef?.oauthHost ?? oauthHost ?? this.flowConfig.oauthHost;
  }
}

export function resolveKimiTokenStorageName(input: {
  readonly providerName?: string | undefined;
  readonly oauthKey?: string | undefined;
}): string {
  const providerName = input.providerName ?? KIMI_CODE_PROVIDER_NAME;
  if (providerName !== KIMI_CODE_PROVIDER_NAME) {
    throw new Error(`No OAuth manager configured for provider "${providerName}".`);
  }

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

function managedFeedbackUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return kimiCodeFeedbackUrl();
  return `${baseUrl.replace(/\/+$/, '')}/feedback`;
}

function normalizeOAuthHost(oauthHost: string): string {
  return oauthHost.trim().replace(/\/+$/, '');
}
