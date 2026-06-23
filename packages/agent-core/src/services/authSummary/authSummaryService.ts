/**
 * `AuthSummaryService` — implementation of `IAuthSummaryService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../_base/di';
import type { KimiConfig } from '../../config';
import type { CoreRPC } from '../../rpc';
import type { AuthSummary } from '@moonshot-ai/protocol';
import { createManagedAuthFacade, type ServicesAuthFacade } from '../auth/managedAuth';
import { IEnvironmentService } from '../environment/environment';
import { ICoreRuntime } from '#/coreProcess';
import {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthModelNotResolvedError,
} from './authSummary';

/** Wire name of the OAuth-managed provider (`@moonshot-ai/kimi-code-oauth`'s `KIMI_CODE_PROVIDER_NAME`). */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

export class AuthSummaryService
  extends Disposable
  implements IAuthSummaryService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: ServicesAuthFacade;

  constructor(
    @IEnvironmentService private readonly env: IEnvironmentService,
    @ICoreRuntime private readonly core: ICoreRuntime,
  ) {
    super();
    this._authFacade = createManagedAuthFacade(env);
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
    if (this._store.isDisposed) return;
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
    return this.coreApi().getKimiConfig({ reload: true });
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site above reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
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
// `@I…`-injected (@IEnvironmentService / @ICoreRuntime);
// `staticArguments = []`. `supportsDelayedInstantiation = false` preserves
// current reverse-dispose semantics.
registerSingleton(IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed);
