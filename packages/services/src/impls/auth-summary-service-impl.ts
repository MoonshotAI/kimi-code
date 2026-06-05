/**
 * `AuthSummaryServiceImpl` — P2.1 D2 readiness probe + write-side gate.
 *
 * Reads the live config via `IHarnessBridge.rpc.getKimiConfig({})` and the
 * managed-OAuth credential state via `KimiAuthFacade.status(...)`. Both are
 * cheap (in-process RPC + a token-file existence probe), so we run them on
 * every call instead of caching — keeps the staleness window at zero.
 *
 * **Why import KimiAuthFacade here**: services package already depends on
 * `@moonshot-ai/kimi-code-sdk` (the workspace alias for `node-sdk`), which
 * re-exports the facade. Daemon's anti-corruption invariant ("daemon source
 * has zero direct SDK imports") still holds — the daemon resolves
 * `IAuthSummaryService` from the DI accessor.
 *
 * **Status mapping** (P2.1 minimum viable):
 *   - managed provider configured + cached token        → 'authenticated'
 *   - managed provider configured + no cached token     → 'unauthenticated'
 *   - managed provider not in config                    → managed_provider = null
 *
 * `'expired' / 'revoked'` are intentionally NOT distinguished here — they
 * require runtime introspection that lands with the reactive-refresh path in
 * P2.7+P2.9. Until then, "no cached token" subsumes both states.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { KimiConfig } from '@moonshot-ai/agent-core';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
import type { AuthSummary } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  IAuthSummaryService,
} from '../interfaces/auth-summary-service';

/** Wire name of the OAuth-managed provider (`@moonshot-ai/kimi-code-oauth`'s `KIMI_CODE_PROVIDER_NAME`). */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';

export interface AuthSummaryServiceOptions {
  /** `~/.kimi-code` (or test tmpdir) — the credential file root for KimiAuthFacade. */
  readonly homeDir: string;
  /** Full path to `config.toml`. Must match what HarnessBridge / KimiCore see. */
  readonly configPath: string;
}

export class AuthSummaryServiceImpl
  extends Disposable
  implements IAuthSummaryService
{
  private readonly _authFacade: KimiAuthFacade;

  constructor(
    // VSCode-style: static options prefix, @-injected services after.
    options: AuthSummaryServiceOptions,
    @IHarnessBridge private readonly bridge: IHarnessBridge,
  ) {
    super();
    this._authFacade = new KimiAuthFacade({
      homeDir: options.homeDir,
      configPath: options.configPath,
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
    // reactive (P2.9). Static gate only.
    const hasInlineKey = nonEmpty(providerConfig.apiKey) !== null;
    if (hasInlineKey) return;

    if (providerConfig.oauth !== undefined) {
      const hasToken = await this._hasCachedToken(providerName);
      if (hasToken) return;
      throw new AuthTokenMissingError(providerName);
    }

    // No inline key, no oauth ref. Could still be an env-supplied key — for
    // P2.1 minimum viable we conservatively gate; env-key callers can set
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
    // `OAuthServiceImpl` (toolkit's provisioning) and `IProviderService`
    // future RW endpoints land on disk via `writeConfigFile`, but
    // KimiCore's `this.config` only refreshes when something explicitly
    // asks for `reload`. Without this flag, `GET /v1/auth` would stay
    // `ready:false` for the entire daemon lifetime after first login.
    return this.bridge.rpc.getKimiConfig({ reload: true });
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
