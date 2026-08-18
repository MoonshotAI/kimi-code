/**
 * `OAuthClientProvider` implementation backed by per-MCP-server JSON files.
 *
 * One provider instance per server/resource identity. The provider:
 *  - Persists OAuth tokens, the registered DCR client info, and discovery
 *    state under `<KIMI_CODE_HOME>/credentials/mcp/<key>-*.json`
 *    (mode 0600; default home is `~/.kimi-code`).
 *  - Captures the authorization URL when the SDK calls
 *    `redirectToAuthorization` — the {@link McpOAuthService} reads that field
 *    after the first `auth()` call returns `'REDIRECT'`.
 *  - Keeps the PKCE verifier and OAuth `state` in-memory (one flow per
 *    provider at a time; callers serialize via the service).
 *
 * The provider does **not** open browsers or run servers. The service is the
 * orchestrator; the provider is the persistence + flow-state shim.
 */

import { randomBytes } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthTokensSchema,
  type OAuthClientInformationFull,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthTokenTransaction } from '@moonshot-ai/kimi-code-oauth';

import { JsonFileStore, canonicalMcpOAuthResource, mcpOAuthStoreKey } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
/** Sidecar `<key>-meta.json` suffix; the service scans these on startup. */
export const META_SUFFIX = '-meta.json';
// Used only when the SDK probes auth during normal transport startup and no
// callback listener is active. Interactive login overrides it with a real URL.
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

/**
 * The tokens file gains an `obtained_at` epoch-ms stamp on every write so the
 * OAuth service can compute the absolute expiry (`expires_in` alone is
 * relative) for proactive refresh and accurate auth-state classification.
 * The SDK only reads the standard fields; the extra key is inert.
 */
export interface StoredMcpOAuthTokens extends OAuthTokens {
  readonly obtained_at?: number;
}

/** Sidecar `<key>-meta.json` record mapping a store key back to its server. */
export interface McpOAuthStoreMeta {
  readonly serverName: string;
  readonly serverUrl: string;
}

export interface McpOAuthProviderOptions {
  /** Friendly name of the MCP server; used in DCR `client_name`. */
  readonly serverName: string;
  /** Canonical resource identity used to isolate credentials for this server entry. */
  readonly serverUrl: string | URL;
  /** JSON store used for persistence. Tests inject an in-memory dir. */
  readonly store: JsonFileStore;
  /** Identifier embedded in DCR `client_name` ("kimi-code (server)"). */
  readonly clientLabel?: string;
  /** Called after tokens are persisted (login, exchange, or refresh). */
  readonly onTokensSaved?: (tokens: StoredMcpOAuthTokens) => void;
  /** Called after any credential invalidation, including SDK-driven ones. */
  readonly onCredentialsInvalidated?: (
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) => void;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  private readonly serverName: string;
  private readonly store: JsonFileStore;
  private readonly clientLabel: string;
  private readonly onTokensSaved: McpOAuthProviderOptions['onTokensSaved'];
  private readonly onCredentialsInvalidated: McpOAuthProviderOptions['onCredentialsInvalidated'];
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;
  private readonly tokenTransaction: OAuthTokenTransaction<OAuthTokens>;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.serverName = options.serverName;
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `kimi-code (${options.serverName})`;
    const tokensFile = `${this.storeKey}${TOKENS_SUFFIX}`;
    this.tokenTransaction = new OAuthTokenTransaction({
      key: this.storeKey,
      read: async () => this.store.read<OAuthTokens>(tokensFile),
      write: async (tokens) => {
        // Single choke point for every durable token write (explicit saves and
        // refresh grants committed by the fetch interceptor alike): keep the
        // incoming stamp when present, stamp otherwise.
        const incoming = tokens as StoredMcpOAuthTokens;
        this.store.write(tokensFile, { ...incoming, obtained_at: incoming.obtained_at ?? Date.now() });
      },
      remove: async () => {
        this.store.remove(tokensFile);
      },
      parse: (value) => OAuthTokensSchema.safeParse(value).data,
    });
    this.onTokensSaved = options.onTokensSaved;
    this.onCredentialsInvalidated = options.onCredentialsInvalidated;
  }

  // ── flow-scoped state, set by McpOAuthService before invoking auth() ────

  setRedirectUrl(url: URL): void {
    this._redirectUrl = url;
  }

  /** URL captured from the most recent `redirectToAuthorization` call. */
  takeAuthorizationUrl(): URL | undefined {
    const url = this._lastAuthorizationUrl;
    this._lastAuthorizationUrl = undefined;
    return url;
  }

  /** OAuth `state` value generated for the most recent flow, for callback verification. */
  expectedState(): string | undefined {
    return this._state;
  }

  resetFlow(): void {
    this._redirectUrl = undefined;
    this._codeVerifier = undefined;
    this._state = undefined;
    this._lastAuthorizationUrl = undefined;
  }

  // ── OAuthClientProvider ─────────────────────────────────────────────────

  get redirectUrl(): string | URL {
    return this.effectiveRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.effectiveRedirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.clientLabel,
    };
  }

  state(): string {
    this._state ??= randomBytes(16).toString('hex');
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Hand the SDK's token object to the transaction untouched: when the
    // grant rode createOAuthFetch, the transaction already persisted and
    // recorded exactly this payload, so a matching save consumes the
    // recorded effect instead of writing again — re-writing here could
    // resurrect credentials cleared between the fetch and this callback.
    // The durable `obtained_at` stamp is applied by the write callback.
    await this.tokenTransaction.save(tokens);
    const meta: McpOAuthStoreMeta = { serverName: this.serverName, serverUrl: this.serverUrl };
    this.store.write(`${this.storeKey}${META_SUFFIX}`, meta);
    const stamped: StoredMcpOAuthTokens = {
      ...tokens,
      obtained_at: (tokens as StoredMcpOAuthTokens).obtained_at ?? Date.now(),
    };
    this.onTokensSaved?.(stamped);
  }

  /**
   * Wrap the fetch used by the SDK's OAuth flow. Refresh-token grants for the
   * same MCP identity are serialized, re-read from durable storage inside the
   * lock, and committed before the lock is released.
   */
  createOAuthFetch(fetchFn: typeof fetch = globalThis.fetch): typeof fetch {
    return this.tokenTransaction.createFetch(fetchFn);
  }

  redirectToAuthorization(url: URL): void {
    // Capture the URL for the orchestrator instead of actually opening a
    // browser. The synthetic authenticate tool surfaces it to the model so
    // the user can complete the flow on their own schedule.
    this._lastAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error('McpOAuthClientProvider: PKCE code verifier not initialized');
    }
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`);
  }

  /**
   * Drop the persisted DCR client registration when its `redirect_uris` no
   * longer cover `redirectUri`. Returns true when a stale registration was
   * dropped.
   *
   * The callback listener binds a random port per flow, while a DCR
   * registration pins the redirect URIs of the flow that created it. Reusing
   * a registration whose URIs no longer match guarantees an
   * "invalid redirect URI" rejection at the authorization endpoint — rendered
   * only in the user's browser, while this client waits for a callback that
   * never comes. Dropping the registration lets the next `auth()` call
   * re-register with the current callback URI.
   */
  async invalidateStaleRegistration(redirectUri: string): Promise<boolean> {
    const info = this.clientInformation();
    if (info === undefined || !('redirect_uris' in info)) return false;
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    if (uris.includes(redirectUri)) return false;
    await this.clearCredentials('client');
    return true;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope !== 'tokens' && scope !== 'all') {
      await this.clearCredentials(scope);
      return;
    }
    const tokensInvalidated = await this.tokenTransaction.invalidateFromSdk(scope);
    if (!tokensInvalidated) return;
    if (scope === 'all') {
      await this.clearCredentials('client');
      await this.clearCredentials('discovery');
      this._codeVerifier = undefined;
    }
    // The SDK-driven invalidation actually dropped the durable grant, so
    // broadcast it like a user-driven reset: sessions sharing this credential
    // flip to needs-auth now instead of keeping doomed connections until
    // they each hit their own 401.
    this.onCredentialsInvalidated?.(scope);
  }

  /** Explicit user-driven reset; unlike the SDK invalidation hook, never preserves tokens. */
  async clearCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      this.onCredentialsInvalidated?.(scope);
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.tokenTransaction.clear();
      this.store.remove(`${this.storeKey}${META_SUFFIX}`);
    }
    if (scope === 'client' || scope === 'all') {
      this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
    }
    if (scope === 'discovery' || scope === 'all') {
      this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
    }
    if (scope === 'all') {
      this._codeVerifier = undefined;
    }
    this.onCredentialsInvalidated?.(scope);
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    const registered = registeredRedirectUri(this.clientInformation());
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

export function createMcpOAuthFetch(
  provider: OAuthClientProvider | undefined,
  fetchFn: typeof fetch | undefined,
): typeof fetch | undefined {
  return provider instanceof McpOAuthClientProvider ? provider.createOAuthFetch(fetchFn) : fetchFn;
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}
