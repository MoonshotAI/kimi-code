/**
 * `mcp` domain (L5) — `McpOAuthClientProvider`, the `OAuthClientProvider`
 * backed by the MCP OAuth credential store (`McpOAuthStore` over
 * `IAtomicDocumentStore`).
 *
 * One provider instance per server/resource identity. It persists OAuth
 * tokens, the registered DCR client info, and discovery state under
 * `<homeDir>/credentials/mcp/<key>-*.json` via the store; captures the
 * authorization URL when the SDK calls `redirectToAuthorization` (the
 * orchestrator reads it after `auth()` returns `'REDIRECT'`); and keeps the
 * PKCE verifier and OAuth `state` in-memory. Persisted values are mirrored
 * into in-memory caches loaded eagerly on construction (`ready`) so the
 * SDK's synchronous `redirectUrl` / `clientMetadata` getters read without
 * blocking, while the data methods `await ready` before reading or writing.
 * The provider does not open browsers or run servers — the service
 * orchestrates, the provider is the persistence + flow-state shim.
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

import { canonicalMcpOAuthResource, mcpOAuthStoreKey, type McpOAuthStore } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

export interface McpOAuthProviderOptions {
  readonly serverName: string;
  readonly serverUrl: string | URL;
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  readonly ready: Promise<void>;
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string;
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;

  private clientCache: OAuthClientInformationMixed | undefined;
  private tokensCache: OAuthTokens | undefined;
  private discoveryCache: OAuthDiscoveryState | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `kimi-code (${options.serverName})`;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [client, tokens, discovery] = await Promise.all([
      this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`),
      this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`),
      this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`),
    ]);
    this.clientCache = client;
    this.tokensCache = tokens;
    this.discoveryCache = discovery;
  }

  setRedirectUrl(url: URL): void {
    this._redirectUrl = url;
  }

  takeAuthorizationUrl(): URL | undefined {
    const url = this._lastAuthorizationUrl;
    this._lastAuthorizationUrl = undefined;
    return url;
  }

  expectedState(): string | undefined {
    return this._state;
  }

  resetFlow(): void {
    this._redirectUrl = undefined;
    this._codeVerifier = undefined;
    this._state = undefined;
    this._lastAuthorizationUrl = undefined;
  }

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

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.ready;
    return this.clientCache;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.clientCache = info;
    await this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.ready;
    return this.tokensCache;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokensCache = tokens;
    await this.store.write(`${this.storeKey}${TOKENS_SUFFIX}`, tokens);
  }

  redirectToAuthorization(url: URL): void {
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

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discoveryCache = state;
    await this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.ready;
    return this.discoveryCache;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      this.tokensCache = undefined;
      await this.store.remove(`${this.storeKey}${TOKENS_SUFFIX}`);
    }
    if (scope === 'client' || scope === 'all') {
      this.clientCache = undefined;
      await this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
    }
    if (scope === 'discovery' || scope === 'all') {
      this.discoveryCache = undefined;
      await this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
    }
    if (scope === 'all') {
      this._codeVerifier = undefined;
    }
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    const registered = registeredRedirectUri(this.clientCache);
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}
