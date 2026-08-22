import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { ILogger as Logger } from '#/_base/log/log';
import { ErrorCodes, Error2, isError2 } from '#/errors';

import { startCallbackServer, type CallbackServer } from './callback-server';
import {
  META_SUFFIX,
  McpOAuthClientProvider,
  type McpOAuthStoreMeta,
  type StoredMcpOAuthTokens,
} from './provider';
import { canonicalMcpOAuthResource, mcpOAuthStoreKey, type McpOAuthStore } from './store';

const defaultLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => defaultLog,
};

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly resolveClientName?: () => string | undefined;
  readonly log?: Logger;
  readonly scheduler?: McpOAuthScheduler;
  /** Per-request bound for OAuth-flow HTTP (discovery, registration, grants). */
  readonly authRequestTimeoutMs?: number;
  /** Upper bound for awaiting in-flight flows and refreshes during shutdown. */
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
  /**
   * Awaits the OAuth callback, validates `state`, exchanges the code for
   * tokens, and persists them via the provider. Resolves on success;
   * rejects on abort, timeout, or auth-server error.
   *
   * Handles sharing one underlying flow (concurrent `beginAuthorization`
   * calls for the same credential) run the wait and the exchange exactly
   * once: the first `complete()` call's `signal`/`timeoutMs` apply and the
   * rest await the same outcome.
   */
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /**
   * Detaches this caller without finishing the flow. The callback listener
   * stays active while another handle is attached and closes when the final
   * handle detaches. Safe to call repeatedly; called automatically by
   * `complete()`.
   */
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

/** Offline credential snapshot for one server/resource identity. */
export interface McpOAuthTokenState {
  readonly hasTokens: boolean;
  readonly hasRefreshToken: boolean;
  /** Absolute expiry in epoch ms, when the stored grant carries enough data. */
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
  private readonly resolveClientName: (() => string | undefined) | undefined;
  private readonly log: Logger;
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
    this.resolveClientName = options.resolveClientName;
    this.log = options.log ?? defaultLog;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.authRequestTimeoutMs = options.authRequestTimeoutMs ?? DEFAULT_AUTH_REQUEST_TIMEOUT_MS;
    this.shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  /** Returns the cached provider for `serverName` + `serverUrl`, constructing it on first use. */
  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = this.createProvider(serverName, serverUrl);
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  /** True once the provider has persisted tokens for this server/resource identity. */
  async hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return (await this.getProvider(serverName, serverUrl).tokens()) !== undefined;
  }

  /**
   * Offline view of the stored grant. `expired` is only computable when the
   * tokens were written with an `obtained_at` stamp and carry `expires_in`;
   * older or foreign writes without both are treated as non-expiring.
   */
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

  /**
   * Single-flight token refresh per credential: concurrent callers share one
   * in-flight SDK `auth()` run, so two sessions expiring together cannot race
   * a rotating refresh token. Resolves when the grant is usable again;
   * rejects when the refresh token was rejected (or never existed) and an
   * interactive login is required.
   */
  async refresh(serverName: string, serverUrl: string | URL): Promise<void> {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    const existing = this.refreshes.get(storeKey);
    if (existing !== undefined) return existing;
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'MCP OAuth service is shutting down');
    }
    const task = this.refreshNow(serverName, serverUrl).finally(() => {
      this.refreshes.delete(storeKey);
    });
    this.refreshes.set(storeKey, task);
    return task;
  }

  /**
   * Arm the proactive refresh timer for every stored credential that carries
   * enough data to expire. Called once at engine start; subsequent token
   * writes re-arm through the provider save hook. A malformed meta sidecar
   * (or any per-credential failure) is skipped with a warning rather than
   * aborting the whole sweep.
   */
  async sweepProactiveRefresh(): Promise<void> {
    if (this.shuttingDown) return;
    const keys = await this.store.list();
    for (const key of keys) {
      if (this.shuttingDown) return;
      if (!key.endsWith(META_SUFFIX)) continue;
      const meta = await readStoreMeta(this.store, key, this.log);
      if (meta === undefined) continue;
      try {
        const state = await this.tokenState(meta.serverName, meta.serverUrl);
        if (!state.hasTokens || !state.hasRefreshToken || state.expiresAt === undefined) continue;
        this.scheduleRefresh(meta.serverName, meta.serverUrl, state.expiresAt);
      } catch (error) {
        this.log.warn('skipping MCP OAuth credential during proactive-refresh sweep', {
          file: key,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
  }

  /** Clear every pending proactive-refresh timer (engine shutdown, tests). */
  stopProactiveRefresh(): void {
    for (const timer of this.refreshTimers.values()) timer.cancel();
    this.refreshTimers.clear();
  }

  /**
   * Release everything the service owns: pending proactive-refresh timers,
   * in-flight refreshes and interactive flows (closing their callback
   * listeners), event listeners, and cached providers. Idempotent.
   */
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
        this.log.warn('mcp oauth shutdown drain timed out; continuing teardown');
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

  /**
   * Drive the SDK `auth()` orchestrator far enough to surface an
   * authorization URL. The caller is responsible for displaying the URL
   * (typically via the synthetic authenticate tool) and then awaiting
   * `complete()` to finish the code exchange.
   *
   * Interactive flows are serialized per credential: while one flow for a
   * store key is in flight, further calls join it — same URL, shared
   * `complete()`, and a `cancel()` that only detaches the caller — instead
   * of resetting the shared provider's PKCE/state mid-flow.
   */
  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'MCP OAuth service is shutting down');
    }
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    await this.refreshes.get(storeKey)?.catch(() => undefined);
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'MCP OAuth service is shutting down');
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
          throw new Error2(
            ErrorCodes.MCP_OAUTH_FAILED,
            'OAuth provider did not capture an authorization URL',
          );
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
          new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'OAuth flow already completed or cancelled'),
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
            throw new Error2(
              ErrorCodes.MCP_OAUTH_FAILED,
              'OAuth state mismatch — possible CSRF; refusing token exchange',
            );
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
            throw new Error2(
              ErrorCodes.MCP_OAUTH_FAILED,
              `OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`,
              { details: { result: finalResult } },
            );
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
            throw new Error2(
              ErrorCodes.MCP_OAUTH_FAILED,
              'OAuth flow already completed or cancelled',
            );
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

  /**
   * Clear stored credentials for a server. Use `'all'` after the user
   * explicitly signs out; use `'tokens'` to force a re-auth while keeping
   * the registered DCR client.
   */
  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).clearCredentials(scope);
  }

  /**
   * Drop the cached provider for a credential. After an invalidation this
   * guarantees the next `beginAuthorization` starts from a clean in-memory
   * flow state (files are always re-read, so this is defensive).
   */
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
      clientName: this.resolveClientName?.(),
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
      throw new Error2(
        ErrorCodes.MCP_OAUTH_FAILED,
        `MCP server "${serverName}" has no refreshable OAuth grant`,
      );
    }
    const provider = this.getProvider(serverName, serverUrl);
    provider.resetFlow();
    try {
      const result = await auth(provider as OAuthClientProvider, {
        serverUrl,
        fetchFn: this.authFetch(provider),
      });
      if (result !== 'AUTHORIZED') {
        throw new Error2(
          ErrorCodes.MCP_OAUTH_FAILED,
          'the stored OAuth grant requires an interactive login',
        );
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

/** Thrown by `beginAuthorization` when stored tokens already satisfy the server. */
export class AlreadyAuthorizedError extends Error2 {
  constructor(serverName: string) {
    super(
      ErrorCodes.MCP_OAUTH_FAILED,
      `"${serverName}" is already authorized; no browser flow needed`,
    );
    this.name = 'AlreadyAuthorizedError';
  }
}

async function readStoreMeta(
  store: McpOAuthStore,
  key: string,
  log: Logger,
): Promise<McpOAuthStoreMeta | undefined> {
  const raw: unknown = await store.read(key);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    log.warn('ignoring malformed MCP OAuth meta file', { file: key });
    return undefined;
  }
  const { serverName, serverUrl } = raw as Record<string, unknown>;
  if (typeof serverName !== 'string' || serverName.length === 0 || typeof serverUrl !== 'string') {
    log.warn('ignoring malformed MCP OAuth meta file', { file: key });
    return undefined;
  }
  if (URL.parse(serverUrl) === null) {
    log.warn('ignoring MCP OAuth meta file with unparseable serverUrl', { file: key, serverUrl });
    return undefined;
  }
  return { serverName, serverUrl };
}

function wrapAuthError(prefix: string, error: unknown): Error2 {
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${error.message}`, {
      cause: error,
    });
  }
  return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${String(error)}`, { cause: error });
}
