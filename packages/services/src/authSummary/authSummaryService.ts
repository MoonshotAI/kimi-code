/**
 * `AuthSummaryService` — implementation of `IAuthSummaryService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';
import type { KimiConfig } from '@moonshot-ai/agent-core';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
import type { AuthSummary } from '@moonshot-ai/protocol';
import { IEnvironmentService } from '../environment/environment';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthModelNotResolvedError,
} from './authSummary';

/** Wire name of the OAuth-managed provider (`@moonshot-ai/kimi-code-oauth`'s `KIMI_CODE_PROVIDER_NAME`). */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';

export class AuthSummaryService
  extends Disposable
  implements IAuthSummaryService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: KimiAuthFacade;

  constructor(
    @IEnvironmentService private readonly env: IEnvironmentService,
    @ICoreProcessService private readonly core: ICoreProcessService,
  ) {
    super();
    this._authFacade = new KimiAuthFacade({
      homeDir: env.homeDir,
      configPath: env.configPath,
    });
  }

  async get(): Promise<AuthSummary> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    const providers_count = Object.keys(providers).length;
    const default_model = nonEmpty(config.defaultModel);

    let managed_provider: AuthSummary['managed_provider'] = null;
    if (providers[MANAGED_PROVIDER_NAME] !== undefined) {
      const hasToken = await this._hasCachedToken(MANAGED_PROVIDER_NAME);
      managed_provider = {
        name: MANAGED_PROVIDER_NAME,
        status: hasToken ? 'authenticated' : 'unauthenticated',
      };
    }

    const ready =
      providers_count >= 1 &&
      default_model !== null &&
      (managed_provider === null || managed_provider.status !== 'revoked');

    return { ready, providers_count, default_model, managed_provider };
  }

  async ensureReady(modelOverride?: string): Promise<void> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    if (Object.keys(providers).length === 0) {
      throw new AuthProvisioningRequiredError();
    }

    const modelId = modelOverride ?? config.defaultModel;
    if (modelId === undefined || modelId === '') {
      throw new AuthModelNotResolvedError(undefined);
    }

    const alias = config.models?.[modelId];
    if (alias === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerName = alias.provider ?? config.defaultProvider;
    if (providerName === undefined || providerName === '') {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerConfig = providers[providerName];
    if (providerConfig === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerName);
    }

    // Credential presence: api_key (config or env), OR a cached OAuth token.
    // We deliberately don't probe live OAuth refresh here — that path is
    // reactive. Static gate only.
    const hasInlineKey = nonEmpty(providerConfig.apiKey) !== null;
    if (hasInlineKey) return;

    if (providerConfig.oauth !== undefined) {
      const hasToken = await this._hasCachedToken(providerName);
      if (hasToken) return;
      throw new AuthTokenMissingError(providerName);
    }

    // No inline key, no oauth ref. Could still be an env-supplied key — for
    // minimum viable we conservatively gate; env-key callers can set
    // apiKey="${VAR}" in config to bypass. The acceptance test fixture for
    // 40111 uses "manual provider with no api_key" which lands here.
    throw new AuthTokenMissingError(providerName);
  }

  override dispose(): void {
    if (this._isDisposed) return;
    super.dispose();
  }

  /* ----------------------------- internals ---------------------------- */

  private async _readConfig(): Promise<KimiConfig> {
    // `reload: true` forces KimiCore to re-read `config.toml` from disk
    // before returning. Critical for the auth probe path: writes from
    // `OAuthService` (toolkit's provisioning) and `IProviderService`
    // future RW endpoints land on disk via `writeConfigFile`, but
    // KimiCore's `this.config` only refreshes when something explicitly
    // asks for `reload`. Without this flag, `GET /v1/auth` would stay
    // `ready:false` for the entire daemon lifetime after first login.
    return this.core.rpc.getKimiConfig({ reload: true });
  }

  private async _hasCachedToken(providerName: string): Promise<boolean> {
    try {
      const token = await this._authFacade.getCachedAccessToken(providerName);
      return typeof token === 'string' && token.trim().length > 0;
    } catch {
      // FileTokenStorage throws if the credential dir or file is unreadable;
      // treat any failure as "no token" so callers don't block on transient
      // filesystem errors.
      return false;
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected (@IEnvironmentService / @ICoreProcessService);
// `staticArguments = []`. `supportsDelayedInstantiation = false` preserves
// current reverse-dispose semantics.
registerSingleton(IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed);
