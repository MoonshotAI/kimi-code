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

import { BugIndicatingError } from '#/errors';

import { KIMI_MCP_CLIENT_NAME } from '../client-shared';
import { canonicalMcpOAuthResource, mcpOAuthStoreKey, type McpOAuthStore } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
/** Sidecar `<key>-meta.json` suffix; the service scans these on startup. */
export const META_SUFFIX = '-meta.json';
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

export interface StoredMcpOAuthTokens extends OAuthTokens {
  readonly obtained_at?: number;
}

/** Sidecar `<key>-meta.json` record mapping a store key back to its server. */
export interface McpOAuthStoreMeta {
  readonly serverName: string;
  readonly serverUrl: string;
}

export interface McpOAuthProviderOptions {
  readonly serverName: string;
  readonly serverUrl: string | URL;
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly clientName?: string;
  readonly now?: () => number;
  /** Called after tokens are persisted (login, exchange, or refresh). */
  readonly onTokensSaved?: (tokens: StoredMcpOAuthTokens) => void;
  /** Called after any credential invalidation, including SDK-driven ones. */
  readonly onCredentialsInvalidated?: (
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) => void;
  /** Receives every in-flight token-grant promise so shutdown can drain it. */
  readonly track?: (operation: Promise<unknown>) => void;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  readonly ready: Promise<void>;
  private readonly serverName: string;
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string;
  private readonly onTokensSaved: McpOAuthProviderOptions['onTokensSaved'];
  private readonly onCredentialsInvalidated: McpOAuthProviderOptions['onCredentialsInvalidated'];
  private readonly now: () => number;
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;
  private readonly tokenTransaction: OAuthTokenTransaction<OAuthTokens>;

  private clientCache: OAuthClientInformationMixed | undefined;
  private discoveryCache: OAuthDiscoveryState | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.serverName = options.serverName;
    this.store = options.store;
    this.clientLabel =
      options.clientLabel ??
      `${options.clientName ?? KIMI_MCP_CLIENT_NAME} (${options.serverName})`;
    this.onTokensSaved = options.onTokensSaved;
    this.onCredentialsInvalidated = options.onCredentialsInvalidated;
    this.now = options.now ?? Date.now;
    const tokensFile = `${this.storeKey}${TOKENS_SUFFIX}`;
    const metaFile = `${this.storeKey}${META_SUFFIX}`;
    this.tokenTransaction = new OAuthTokenTransaction({
      key: this.storeKey,
      read: async () => this.store.read<OAuthTokens>(tokensFile),
      write: async (tokens) => {
        const incoming = tokens as StoredMcpOAuthTokens;
        await this.store.write(tokensFile, {
          ...incoming,
          obtained_at: incoming.obtained_at ?? this.now(),
        });
      },
      remove: async () => {
        await this.store.remove(tokensFile);
      },
      parse: (value) => OAuthTokensSchema.safeParse(value).data,
      normalize: (tokens) => OAuthTokensSchema.safeParse(tokens).data ?? tokens,
      track: options.track,
      afterCommit: async (tokens) => {
        if (tokens === undefined) {
          await this.store.remove(metaFile);
          return;
        }
        const meta: McpOAuthStoreMeta = { serverName: this.serverName, serverUrl: this.serverUrl };
        await this.store.write(metaFile, meta);
        const stamped: StoredMcpOAuthTokens = {
          ...tokens,
          obtained_at: (tokens as StoredMcpOAuthTokens).obtained_at ?? this.now(),
        };
        this.onTokensSaved?.(stamped);
      },
    });
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [client, discovery] = await Promise.all([
      this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`),
      this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`),
    ]);
    this.clientCache = client;
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
    await this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
    this.clientCache = info;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.tokenTransaction.save(tokens);
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
    await this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
    this.discoveryCache = state;
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
    }
    if (scope === 'client' || scope === 'all') {
      await this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
      this.clientCache = undefined;
    }
    if (scope === 'discovery' || scope === 'all') {
      await this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
      this.discoveryCache = undefined;
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
    const registered = registeredRedirectUri(this.clientCache);
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}

/**
 * Route a transport's fetch through the provider's token transaction when one
 * is attached, so refresh grants racing on the same credential serialize.
 */
export function createMcpOAuthFetch(
  provider: OAuthClientProvider | undefined,
  fetchFn: typeof fetch | undefined,
): typeof fetch | undefined {
  return provider instanceof McpOAuthClientProvider ? provider.createOAuthFetch(fetchFn) : fetchFn;
}
