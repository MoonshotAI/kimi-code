/**
 * `mcpCore` domain — `McpOAuthClientProvider`, the `OAuthClientProvider`
 * backed by the MCP OAuth credential store (`McpOAuthStore` over
 * `IAtomicDocumentStore`).
 *
 * One provider instance per server/resource identity. It persists OAuth
 * tokens, the registered DCR client info, and discovery state under
 * `<homeDir>/credentials/mcp/<key>-*.json` via the store; captures the
 * authorization URL when the SDK calls `redirectToAuthorization`; and keeps
 * the PKCE verifier and OAuth `state` in-memory. Client registration and
 * discovery state are cached after the eager `ready` load, while token reads
 * stay durable. Token refresh persistence and guarded invalidation are
 * serialized through the process-local transaction helper from `oauth`.
 * The provider does not open browsers or run servers — it is the persistence
 * + flow-state shim.
 *
 * `invalidateStaleRegistration` guards interactive flows: the callback
 * listener binds a random port per flow while a DCR registration pins the
 * redirect URIs of the flow that created it, so a reused registration whose
 * URIs no longer cover the current callback would be rejected at the
 * authorization endpoint ("invalid redirect URI", rendered only in the
 * user's browser). Dropping it lets `auth()` re-register.
 *
 * `clientName` is the product token for the default label
 * (`<clientName> (<serverName>)`), carrying the configured custom identity; it
 * is ignored when `clientLabel` states the whole label explicitly.
 */

import { randomBytes } from 'node:crypto';

import { BugIndicatingError } from '#/errors';

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
  private discoveryCache: OAuthDiscoveryState | undefined;
  private readonly tokenTransaction: OAuthTokenTransaction<OAuthTokens>;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel =
      options.clientLabel ??
      `${options.clientName ?? KIMI_MCP_CLIENT_NAME} (${options.serverName})`;
    const tokensFile = `${this.storeKey}${TOKENS_SUFFIX}`;
    this.tokenTransaction = new OAuthTokenTransaction({
      key: this.storeKey,
      read: () => this.store.read<OAuthTokens>(tokensFile),
      write: (tokens) => this.store.write(tokensFile, tokens),
      remove: () => this.store.remove(tokensFile),
      parse: (value) => OAuthTokensSchema.safeParse(value).data,
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
    this.clientCache = info;
    await this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.ready;
    return this.readStoredTokens();
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
    const shouldClearRelatedCredentials = await this.tokenTransaction.invalidateFromSdk(scope);
    if (!shouldClearRelatedCredentials) return;
    if (scope === 'all') {
      await this.clearCredentials('client');
      await this.clearCredentials('discovery');
      this._codeVerifier = undefined;
    }
  }

  /** Explicit user-driven reset; unlike the SDK invalidation hook, never preserves tokens. */
  async clearCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.tokenTransaction.clear();
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

  private readStoredTokens(): Promise<OAuthTokens | undefined> {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
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
