/**
 * `mcp` domain (L5) — `McpOAuthService`, the per-process OAuth orchestrator
 * for MCP HTTP servers.
 *
 * Owns one {@link McpOAuthClientProvider} per server/resource and mediates the
 * synthetic `mcp__<server>__authenticate` tool flow:
 *
 *  1. `getProvider(serverName, serverUrl)` returns the cached provider.
 *     `HttpMcpClient` hands this to `StreamableHTTPClientTransport.authProvider`
 *     only when the server has no static bearer token configured **and** the
 *     provider has stored tokens for that same server URL — first-time
 *     connections that lack tokens skip the provider entirely so a 401 surfaces
 *     as `UnauthorizedError` from the transport instead of being swallowed by an
 *     in-flight `auth()` attempt.
 *  2. `beginAuthorization(serverName, serverUrl)` spins up a one-shot
 *     localhost callback listener, sets the redirect URL on the provider,
 *     and drives the SDK `auth()` orchestrator forward until it surfaces an
 *     authorization URL. It returns that URL plus a `complete()` callback
 *     that finishes the code exchange once the user finishes the browser
 *     flow.
 *  3. After `complete()` resolves successfully the provider has tokens on
 *     disk; the caller (the synthetic tool) drives a manager-level
 *     `reconnect` to swap the synthetic tool out for the real MCP tools.
 */

import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { startCallbackServer, type CallbackServer } from './callback-server';
import { McpOAuthClientProvider } from './provider';
import { mcpOAuthStoreKey, type McpOAuthStore } from './store';

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  cancel(): Promise<void>;
}

export class McpOAuthService {
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();

  constructor(options: McpOAuthServiceOptions) {
    this.store = options.store;
    this.clientLabel = options.clientLabel;
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = new McpOAuthClientProvider({
        serverName,
        serverUrl,
        store: this.store,
        clientLabel: this.clientLabel,
      });
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  async hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return (await this.getProvider(serverName, serverUrl).tokens()) !== undefined;
  }

  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider = options.clientLabel === undefined
      ? this.getProvider(serverName, serverUrl)
      : new McpOAuthClientProvider({
          serverName,
          serverUrl,
          store: this.store,
          clientLabel: options.clientLabel,
        });
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError('failed to start OAuth callback listener', error);
    }

    provider.setRedirectUrl(new URL(callbackServer.redirectUri));
    await provider.ready;

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== 'REDIRECT') {
        await callbackServer.close();
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error('OAuth provider did not capture an authorization URL');
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult['complete'] = async (opts = {}) => {
      if (settled) {
        throw new Error('OAuth flow already completed or cancelled');
      }
      try {
        const { code, state } = await callbackServer.waitForCode({
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error('OAuth state mismatch — possible CSRF; refusing token exchange');
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
        });
        if (finalResult !== 'AUTHORIZED') {
          throw new Error(`OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`);
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).invalidateCredentials(scope);
  }
}

export class AlreadyAuthorizedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" is already authorized; no browser flow needed`);
    this.name = 'AlreadyAuthorizedError';
  }
}

function wrapAuthError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${prefix}: ${error.message}`);
    wrapped.cause = error;
    return wrapped;
  }
  return new Error(`${prefix}: ${String(error)}`);
}
