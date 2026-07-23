import { join } from 'node:path';

import { readConfigFile, writeConfigFile } from '../../config';
import type { KimiConfig, OAuthRef } from '../../config';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  clearOpenAICodexConfig,
  createOpenAICodexTokenProvider,
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  OAuthConnectionError,
  OAuthUnauthorizedError,
  OPENAI_CODEX_OAUTH_KEY,
  OPENAI_CODEX_PROVIDER_NAME,
  RetryableRefreshError,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  resolveKimiTokenStorageName,
  type BearerTokenProvider,
  type KimiOAuthLoginOptions,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';

import { ErrorCodes, KimiError } from '../../errors';
import type { IEnvironmentService } from '../environment/environment';

type ServicesManagedConfig = KimiConfig & ManagedKimiConfigShape;

type ServicesAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'>;

interface ServicesAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

interface ServicesAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

function mapOAuthTokenError(error: unknown, providerName: string): KimiError | undefined {
  if (error instanceof OAuthUnauthorizedError) {
    return new KimiError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `OAuth provider "${providerName}" requires login before it can be used.`,
      { cause: error },
    );
  }
  if (error instanceof OAuthConnectionError || error instanceof RetryableRefreshError) {
    return new KimiError(
      ErrorCodes.PROVIDER_CONNECTION_ERROR,
      `OAuth provider "${providerName}" failed to fetch an access token: ${error.message}`,
      { cause: error },
    );
  }
  return undefined;
}

export interface ServicesAuthFacade {
  login(
    providerName?: string | undefined,
    options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult>;
  logout(providerName?: string | undefined): Promise<ServicesAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined>;
  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
}

class ServicesManagedAuthFacade implements ServicesAuthFacade {
  private readonly toolkit: KimiOAuthToolkit<ServicesManagedConfig>;

  constructor(
    private readonly options: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
  ) {
    this.toolkit = new KimiOAuthToolkit<ServicesManagedConfig>({
      homeDir: options.homeDir,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as ServicesManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  async login(
    providerName: string | undefined = KIMI_CODE_PROVIDER_NAME,
    options: ServicesAuthLoginOptions = {},
  ): Promise<ServicesAuthLoginResult> {
    const auth = this.resolveManagedAuth(providerName);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
      requestedBaseUrl: options.baseUrl,
      requestedOAuthHost: options.oauthHost,
    });
    const result = await this.toolkit.login(providerName, {
      ...options,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      oauthRef: options.oauthRef ?? loginAuth.oauthRef,
      provisionConfig: true,
    });
    if (result.provision === undefined) {
      throw new Error('Kimi auth login did not provision model config.');
    }
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(
    providerName?: string | undefined,
  ): Promise<ServicesAuthLogoutResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    const result = await this.toolkit.logout(
      providerName,
      auth.oauthRef,
    );
    if (this.isOpenAICodexAuth(result.providerName, auth.oauthRef)) {
      const config = readConfigFile(this.options.configPath) as ServicesManagedConfig;
      const cleanup = clearOpenAICodexConfig(config);
      if (
        cleanup.removedProvider ||
        cleanup.removedModels.length > 0 ||
        cleanup.defaultModelCleared
      ) {
        if (cleanup.defaultModelCleared) config.thinking = undefined;
        await writeConfigFile(this.options.configPath, config);
      }
    }
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    if (this.isOpenAICodexAuth(providerName, oauthRef)) {
      const storageName = resolveKimiTokenStorageName({
        providerName: providerName ?? OPENAI_CODEX_PROVIDER_NAME,
        oauthKey: oauthRef?.key ?? OPENAI_CODEX_OAUTH_KEY,
      });
      return new FileTokenStorage(join(this.options.homeDir, 'credentials'))
        .load(storageName)
        .then((token) => token?.accessToken);
    }
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const provider = this.isOpenAICodexAuth(providerName, oauthRef)
      ? createOpenAICodexTokenProvider({
          storage: new FileTokenStorage(join(this.options.homeDir, 'credentials')),
          providerName,
          oauthRef,
        })
      : this.toolkit.tokenProvider(
          providerName,
          this.runtimeOAuthRef(providerName, oauthRef),
        );
    return {
      getAccessToken: async (options) => {
        try {
          return await provider.getAccessToken(options);
        } catch (error) {
          throw mapOAuthTokenError(error, providerName) ?? error;
        }
      },
    };
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const config = readConfigFile(this.options.configPath);
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,
      baseUrl: provider?.baseUrl,
    };
  }

  private resolveRuntimeManagedAuth(providerName?: string | undefined): {
    readonly oauthRef: OAuthRef;
    readonly baseUrl?: string | undefined;
  } {
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
    });
  }

  private runtimeOAuthRef(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): OAuthRef | undefined {
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) {
      return oauthRef;
    }
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }

  private isOpenAICodexAuth(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): boolean {
    return (
      providerName === OPENAI_CODEX_PROVIDER_NAME ||
      oauthRef?.key === OPENAI_CODEX_OAUTH_KEY
    );
  }
}

export function createManagedAuthFacade(
  env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
): ServicesAuthFacade {
  return new ServicesManagedAuthFacade(env);
}
