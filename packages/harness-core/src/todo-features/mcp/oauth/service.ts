import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { startCallbackServer, type CallbackServer } from './callback-server';
import {
  META_SUFFIX,
  McpOAuthClientProvider,
  type McpOAuthStoreMeta,
  type StoredMcpOAuthTokens,
} from './provider';
import { canonicalMcpOAuthResource, mcpOAuthStoreKey, type McpOAuthStore } from './store';

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly scheduler?: McpOAuthScheduler;
  readonly authRequestTimeoutMs?: number;
  readonly shutdownDrainTimeoutMs?: number;
}

export interface McpOAuthScheduledTask {
  cancel(): void;
}

export interface McpOAuthScheduler {
  now(): number;
  schedule(delayMs: number, task: () => void | Promise<void>): McpOAuthScheduledTask;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  cancel(): Promise<void>;
}

interface SharedAuthorizationFlow {
  readonly attach: () => BeginAuthorizationResult;
  readonly cancelUnderlying: () => Promise<void>;
}

interface ActiveAuthorization {
  readonly started: Promise<SharedAuthorizationFlow>;
  readonly controller: AbortController;
  readonly serverRef: { current: CallbackServer | undefined };
}

export type McpOAuthEvent =
  | {
      readonly type: 'tokens-saved';
      readonly serverName: string;
      readonly serverUrl: string;
    }
  | {
      readonly type: 'tokens-invalidated';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
    }
  | {
      readonly type: 'refresh-failed';
      readonly serverName: string;
      readonly serverUrl: string;
      readonly error: string;
    };

export type McpOAuthEventListener = (event: McpOAuthEvent) => void;

export interface McpOAuthTokenState {
  readonly hasTokens: boolean;
  readonly hasRefreshToken: boolean;
  readonly expiresAt?: number;
  readonly expired: boolean;
}

const REFRESH_AHEAD_MS = 120_000;
const MAX_TIMER_DELAY_MS = 0x7fffffff;
const DEFAULT_AUTH_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

const defaultScheduler: McpOAuthScheduler = {
  now: () => Date.now(),
  schedule: (delayMs, task) => {
    const timer = setTimeout(() => void task(), delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export class McpOAuthService {
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string | undefined;
  private readonly scheduler: McpOAuthScheduler;
  private readonly authRequestTimeoutMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly providers = new Map<string, McpOAuthClientProvider>();
  private readonly listeners = new Set<McpOAuthEventListener>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly refreshTimers = new Map<string, McpOAuthScheduledTask>();
  private readonly activeAuthorizations = new Map<string, ActiveAuthorization>();
  private readonly backgroundTasks = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: McpOAuthServiceOptions) {
    this.store = options.store;
    this.clientLabel = options.clientLabel;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.authRequestTimeoutMs = options.authRequestTimeoutMs ?? DEFAULT_AUTH_REQUEST_TIMEOUT_MS;
    this.shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = this.createProvider(serverName, serverUrl);
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  async hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return (await this.getProvider(serverName, serverUrl).tokens()) !== undefined;
  }

  async tokenState(serverName: string, serverUrl: string | URL): Promise<McpOAuthTokenState> {
    const tokens = (await this.getProvider(serverName, serverUrl).tokens()) as
      | StoredMcpOAuthTokens
      | undefined;
    if (tokens === undefined) {
      return { hasTokens: false, hasRefreshToken: false, expired: false };
    }
    const expiresAt =
      typeof tokens.obtained_at === 'number' && typeof tokens.expires_in === 'number'
        ? tokens.obtained_at + tokens.expires_in * 1000
        : undefined;
    return {
      hasTokens: true,
      hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
      expiresAt,
      expired: expiresAt !== undefined && this.scheduler.now() >= expiresAt,
    };
  }

  onEvent(listener: McpOAuthEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected trackBackgroundTask(task: Promise<unknown>): void {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
  }

  async refresh(serverName: string, serverUrl: string | URL): Promise<void> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const existing = this.refreshes.get(storeKey);
    if (existing !== undefined) return existing;
    if (this.shuttingDown) {
      throw new Error('MCP OAuth service is shutting down');
    }
    const task = this.refreshNow(serverName, serverUrl).finally(() => {
      this.refreshes.delete(storeKey);
    });
    this.refreshes.set(storeKey, task);
    return task;
  }

  async sweepProactiveRefresh(): Promise<void> {
    if (this.shuttingDown) return;
    const keys = await this.store.list();
    for (const key of keys) {
      if (this.shuttingDown) return;
      if (!key.endsWith(META_SUFFIX)) continue;
      const meta = await readStoreMeta(this.store, key);
      if (meta === undefined) continue;
      try {
        const state = await this.tokenState(meta.serverName, meta.serverUrl);
        if (!state.hasTokens || !state.hasRefreshToken || state.expiresAt === undefined) continue;
        this.scheduleRefresh(meta.serverName, meta.serverUrl, state.expiresAt);
      } catch {
      }
    }
  }

  stopProactiveRefresh(): void {
    for (const timer of this.refreshTimers.values()) timer.cancel();
    this.refreshTimers.clear();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    this.stopProactiveRefresh();
    const authorizations = [...this.activeAuthorizations.values()];
    const refreshes = [...this.refreshes.values()];
    this.activeAuthorizations.clear();
    const deadline = this.drainDeadline();
    this.shutdownPromise = (async () => {
      try {
        await Promise.race([
          Promise.all([
            Promise.all(
              authorizations.map(async (active) => {
                active.controller.abort();
                await active.serverRef.current?.close().catch(() => undefined);
                const flow = await active.started.catch(() => undefined);
                await flow?.cancelUnderlying();
              }),
            ),
            Promise.allSettled(refreshes),
            this.drainBackgroundTasks(),
          ]),
          deadline.promise,
        ]);
      } finally {
        deadline.cancel();
        this.listeners.clear();
        this.providers.clear();
      }
    })();
    return this.shutdownPromise;
  }

  private async drainBackgroundTasks(): Promise<void> {
    for (;;) {
      await Promise.allSettled(this.backgroundTasks);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (this.backgroundTasks.size === 0) return;
    }
  }

  private drainDeadline(): { readonly promise: Promise<void>; readonly cancel: () => void } {
    let task: McpOAuthScheduledTask | undefined;
    const promise = new Promise<void>((resolve) => {
      task = this.scheduler.schedule(this.shutdownDrainTimeoutMs, () => {
        resolve();
      });
    });
    return { promise, cancel: () => task?.cancel() };
  }

  private authFetch(
    provider: McpOAuthClientProvider,
    signals: readonly AbortSignal[] = [],
  ): typeof fetch {
    const fetchFn = provider.createOAuthFetch();
    const timeoutMs = this.authRequestTimeoutMs;
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const combined: AbortSignal[] = [AbortSignal.timeout(timeoutMs), ...signals];
      if (init?.signal !== undefined && init.signal !== null) combined.push(init.signal);
      return fetchFn(input, { ...init, signal: AbortSignal.any(combined) });
    }) as typeof fetch;
  }

  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    if (this.shuttingDown) {
      throw new Error('MCP OAuth service is shutting down');
    }
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    await this.refreshes.get(storeKey)?.catch(() => undefined);
    if (this.shuttingDown) {
      throw new Error('MCP OAuth service is shutting down');
    }
    const inFlight = this.activeAuthorizations.get(storeKey);
    if (inFlight !== undefined) {
      const flow = await inFlight.started;
      return flow.attach();
    }

    const controller = new AbortController();
    const serverRef: { current: CallbackServer | undefined } = { current: undefined };
    const started = this.startAuthorizationFlow(
      serverName,
      serverUrl,
      options,
      controller.signal,
      serverRef,
    );
    this.activeAuthorizations.set(storeKey, { started, controller, serverRef });
    let flow: SharedAuthorizationFlow;
    try {
      flow = await started;
    } catch (error) {
      this.activeAuthorizations.delete(storeKey);
      throw error;
    }
    return flow.attach();
  }

  private async startAuthorizationFlow(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions,
    signal: AbortSignal,
    serverRef: { current: CallbackServer | undefined },
  ): Promise<SharedAuthorizationFlow> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const provider =
      options.clientLabel === undefined
        ? this.getProvider(serverName, serverUrl)
        : this.createProvider(serverName, serverUrl, options.clientLabel);
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
    serverRef.current = callbackServer;

    let authorizationUrl: URL | undefined;
    try {
      provider.setRedirectUrl(new URL(callbackServer.redirectUri));
      await provider.ready;
      await provider.invalidateStaleRegistration(callbackServer.redirectUri);
      let tokensSaved = false;
      const unsubscribeTokensSaved = this.onEvent((event) => {
        if (
          event.type === 'tokens-saved' &&
          event.serverName === serverName &&
          event.serverUrl === canonicalMcpOAuthResource(serverUrl)
        ) {
          tokensSaved = true;
        }
      });
      try {
        const result = await auth(provider as OAuthClientProvider, {
          serverUrl,
          fetchFn: this.authFetch(provider, [signal]),
        });
        if (result !== 'REDIRECT') {
          await callbackServer.close();
          if (!tokensSaved) {
            this.emit({
              type: 'tokens-saved',
              serverName,
              serverUrl: canonicalMcpOAuthResource(serverUrl),
            });
          }
          throw new AlreadyAuthorizedError(serverName);
        }
        authorizationUrl = provider.takeAuthorizationUrl();
        if (authorizationUrl === undefined) {
          throw new Error('OAuth provider did not capture an authorization URL');
        }
      } finally {
        unsubscribeTokensSaved();
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    let completion: Promise<void> | undefined;
    let attachedHandles = 0;
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      this.activeAuthorizations.delete(storeKey);
      provider.resetFlow();
      await callbackServer.close().catch(() => undefined);
    };

    const startCompletion: BeginAuthorizationResult['complete'] = (opts = {}) => {
      if (completion !== undefined) return completion;
      if (settled) {
        return Promise.reject(
          new Error('OAuth flow already completed or cancelled'),
        );
      }
      completion = (async () => {
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
            fetchFn: this.authFetch(
              provider,
              opts.signal === undefined ? [signal] : [signal, opts.signal],
            ),
          });
          if (finalResult !== 'AUTHORIZED') {
            throw new Error(`OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`);
          }
        } catch (error) {
          await settle();
          throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
        }
        await settle();
      })();
      this.trackBackgroundTask(completion);
      return completion;
    };

    const attach = (): BeginAuthorizationResult => {
      attachedHandles += 1;
      let detached = false;
      const detach = async (): Promise<void> => {
        if (detached) return;
        detached = true;
        attachedHandles -= 1;
        if (attachedHandles === 0) await settle();
      };
      return {
        authorizationUrl,
        complete: async (opts = {}) => {
          if (detached) {
            throw new Error('OAuth flow already completed or cancelled');
          }
          try {
            await startCompletion(opts);
          } finally {
            await detach();
          }
        },
        cancel: detach,
      };
    };

    return {
      attach,
      cancelUnderlying: settle,
    };
  }

  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).clearCredentials(scope);
  }

  forgetProvider(serverName: string, serverUrl: string | URL): void {
    this.providers.delete(mcpOAuthStoreKey(serverName, serverUrl));
  }

  private createProvider(
    serverName: string,
    serverUrl: string | URL,
    clientLabel?: string,
  ): McpOAuthClientProvider {
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    return new McpOAuthClientProvider({
      serverName,
      serverUrl,
      store: this.store,
      clientLabel: clientLabel ?? this.clientLabel,
      now: () => this.scheduler.now(),
      track: (task) => {
        this.trackBackgroundTask(task);
      },
      onTokensSaved: (tokens) => {
        this.emit({ type: 'tokens-saved', serverName, serverUrl: canonicalUrl });
        if (
          typeof tokens.obtained_at === 'number' &&
          typeof tokens.expires_in === 'number' &&
          typeof tokens.refresh_token === 'string' &&
          tokens.refresh_token.length > 0
        ) {
          this.scheduleRefresh(
            serverName,
            canonicalUrl,
            tokens.obtained_at + tokens.expires_in * 1000,
          );
        }
      },
      onCredentialsInvalidated: (scope) => {
        if (scope === 'tokens' || scope === 'all') {
          this.cancelScheduledRefresh(serverName, canonicalUrl);
        }
        this.emit({ type: 'tokens-invalidated', serverName, serverUrl: canonicalUrl, scope });
      },
    });
  }

  private async refreshNow(serverName: string, serverUrl: string | URL): Promise<void> {
    if (this.activeAuthorizations.has(mcpOAuthStoreKey(serverName, serverUrl))) return;
    const state = await this.tokenState(serverName, serverUrl);
    if (this.activeAuthorizations.has(mcpOAuthStoreKey(serverName, serverUrl))) return;
    if (!state.hasTokens || !state.hasRefreshToken) {
      throw new Error(`MCP server "${serverName}" has no refreshable OAuth grant`);
    }
    const provider = this.getProvider(serverName, serverUrl);
    provider.resetFlow();
    try {
      const result = await auth(provider as OAuthClientProvider, {
        serverUrl,
        fetchFn: this.authFetch(provider),
      });
      if (result !== 'AUTHORIZED') {
        throw new Error('the stored OAuth grant requires an interactive login');
      }
    } finally {
      provider.resetFlow();
    }
  }

  private scheduleRefresh(serverName: string, serverUrl: string | URL, expiresAt: number): void {
    if (this.shuttingDown) return;
    const canonicalUrl = canonicalMcpOAuthResource(serverUrl);
    const storeKey = mcpOAuthStoreKey(serverName, canonicalUrl);
    this.cancelScheduledRefresh(serverName, canonicalUrl);
    const now = this.scheduler.now();
    if (expiresAt <= now) return;
    const lifetimeMs = expiresAt - now;
    const refreshAheadMs = Math.min(REFRESH_AHEAD_MS, lifetimeMs / 2);
    const delay = lifetimeMs - refreshAheadMs;
    let timer: McpOAuthScheduledTask;
    if (delay > MAX_TIMER_DELAY_MS) {
      timer = this.scheduler.schedule(MAX_TIMER_DELAY_MS, () => {
        this.refreshTimers.delete(storeKey);
        this.scheduleRefresh(serverName, canonicalUrl, expiresAt);
      });
    } else {
      timer = this.scheduler.schedule(delay, async () => {
        this.refreshTimers.delete(storeKey);
        await this.refresh(serverName, canonicalUrl).catch((error: unknown) => {
          this.emit({
            type: 'refresh-failed',
            serverName,
            serverUrl: canonicalUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
    this.refreshTimers.set(storeKey, timer);
  }

  private cancelScheduledRefresh(serverName: string, serverUrl: string | URL): void {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const timer = this.refreshTimers.get(storeKey);
    timer?.cancel();
    this.refreshTimers.delete(storeKey);
  }

  private emit(event: McpOAuthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
}

export class AlreadyAuthorizedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" is already authorized; no browser flow needed`);
    this.name = 'AlreadyAuthorizedError';
  }
}

async function readStoreMeta(
  store: McpOAuthStore,
  key: string,
): Promise<McpOAuthStoreMeta | undefined> {
  const raw: unknown = await store.read(key);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { serverName, serverUrl } = raw as Record<string, unknown>;
  if (typeof serverName !== 'string' || serverName.length === 0 || typeof serverUrl !== 'string') {
    return undefined;
  }
  if (URL.parse(serverUrl) === null) {
    return undefined;
  }
  return { serverName, serverUrl };
}

function wrapAuthError(prefix: string, error: unknown): Error {
  if (error instanceof AlreadyAuthorizedError) {
    return error;
  }
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error });
  }
  return new Error(`${prefix}: ${String(error)}`, { cause: error });
}
