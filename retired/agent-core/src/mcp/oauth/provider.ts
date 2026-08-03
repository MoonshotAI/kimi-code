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
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { JsonFileStore, canonicalMcpOAuthResource, mcpOAuthStoreKey } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
// Used only when the SDK probes auth during normal transport startup and no
// callback listener is active. Interactive login overrides it with a real URL.
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

export interface McpOAuthProviderOptions {
  /** Friendly name of the MCP server; used in DCR `client_name`. */
  readonly serverName: string;
  /** Canonical resource identity used to isolate credentials for this server entry. */
  readonly serverUrl: string | URL;
  /** JSON store used for persistence. Tests inject an in-memory dir. */
  readonly store: JsonFileStore;
  /** Identifier embedded in DCR `client_name` ("kimi-code (server)"). */
  readonly clientLabel?: string;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  private readonly store: JsonFileStore;
  private readonly clientLabel: string;
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `kimi-code (${options.serverName})`;
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

  saveTokens(tokens: OAuthTokens): void {
    this.store.write(`${this.storeKey}${TOKENS_SUFFIX}`, tokens);
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

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      this.store.remove(`${this.storeKey}${TOKENS_SUFFIX}`);
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
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    const registered = registeredRedirectUri(this.clientInformation());
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}
