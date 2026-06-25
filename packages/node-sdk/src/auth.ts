import {
  loadRuntimeConfigSafe,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
  type KimiConfig,
  type OAuthRef,
} from '@moonshot-ai/agent-core';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeRuntimeAuth,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type FetchCompleteFeedbackUploadResult,
  type FetchCreateFeedbackUploadUrlResult,
  type FetchSubmitFeedbackResult,
  type KimiHostIdentity,
  type KimiOAuthLoginOptions,
  type ManagedKimiConfigShape,
  type OAuthRefreshOutcome,
} from '@moonshot-ai/kimi-code-oauth';

import { mapOAuthTokenError } from '#/oauth-error';

export interface KimiAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export interface KimiAuthCreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface KimiAuthCompleteFeedbackUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface KimiAuthCompleteFeedbackUploadInput {
  readonly uploadId: number;
  readonly parts: readonly KimiAuthCompleteFeedbackUploadPart[];
}

export type KimiAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'>;

export interface KimiAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface KimiAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface KimiAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: KimiConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = KimiConfig & ManagedKimiConfigShape;

export class KimiAuthFacade {
  private readonly toolkit: KimiOAuthToolkit<SDKManagedConfig>;

  constructor(private readonly options: KimiAuthFacadeOptions) {
    this.toolkit = new KimiOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        // Write-path base read: strict (a salvaged base would drop the user's
        // broken-but-fixable sections on rewrite) with an actionable message.
        read: () => readConfigFileForUpdate(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    return this.toolkit.status(providerName, this.resolveRuntimeManagedAuth(providerName).oauthRef);
  }

  async login(
    providerName: string | undefined = KIMI_CODE_PROVIDER_NAME,
    options: KimiAuthLoginOptions = {},
  ): Promise<KimiAuthLoginResult> {
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
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(providerName?: string | undefined): Promise<KimiAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.getManagedUsage(providerName, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  async submitFeedback(
    input: KimiAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.submitFeedback(
      {
        session_id: input.sessionId,
        content: input.content,
        version: input.version,
        os: input.os,
        model: input.model,
        contact: input.contact,
        info: input.info,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async createFeedbackUploadUrl(
    input: KimiAuthCreateFeedbackUploadUrlInput,
    providerName?: string | undefined,
  ): Promise<FetchCreateFeedbackUploadUrlResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.createFeedbackUploadUrl(
      {
        file_hash: input.sha256,
        file_name: input.filename,
        file_size: input.size,
        feedback_id: input.feedbackId,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async completeFeedbackUpload(
    input: KimiAuthCompleteFeedbackUploadInput,
    providerName?: string | undefined,
  ): Promise<FetchCompleteFeedbackUploadResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.completeFeedbackUpload(
      {
        upload_id: input.uploadId,
        parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const provider = this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
    return {
      getAccessToken: async (options) => {
        try {
          return await provider.getAccessToken(options);
        } catch (error) {
          // Classify OAuth token failures into the public KimiError protocol;
          // unrecognized errors are rethrown raw (see mapOAuthTokenError).
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
    // Read path: token/status resolution must work off a degraded config
    // instead of failing the session when an unrelated section is broken.
    // Write paths (the toolkit's configAdapter.read) stay strict.
    const config = loadRuntimeConfigSafe(this.options.configPath).config;
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
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
}
