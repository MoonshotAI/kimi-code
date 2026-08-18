import { randomBytes } from 'node:crypto';

import { BugIndicatingError } from '#/errors';

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

import { KIMI_MCP_CLIENT_NAME } from '../client-shared';
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
  readonly clientName?: string;
}

export interface StoredMcpOAuthTokens extends OAuthTokens {
  readonly obtained_at?: number;
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
    this.clientLabel =
      options.clientLabel ??
      `${options.clientName ?? KIMI_MCP_CLIENT_NAME} (${options.serverName})`;
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
    const stamped: StoredMcpOAuthTokens = { ...tokens, obtained_at: Date.now() };
    this.tokensCache = stamped;
    await this.store.write(`${this.storeKey}${TOKENS_SUFFIX}`, stamped);
  }

  redirectToAuthorization(url: URL): void {
    this._lastAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new BugIndicatingError('McpOAuthClientProvider: PKCE code verifier not initialized');
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

  async invalidateStaleRegistration(redirectUri: string): Promise<boolean> {
    await this.ready;
    const info = this.clientCache;
    if (info === undefined || !('redirect_uris' in info)) return false;
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    if (uris.includes(redirectUri)) return false;
    await this.invalidateCredentials('client');
    return true;
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
