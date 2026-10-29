import { ErrorCodes, Error2 } from '#/errors';
import type { McpServerConfig } from './config-schema';
import type { ILogger as Logger } from '#/_base/log/log';
import type { ToolDescription as Tool } from '#human/llm/message';
import { HostProcessError, HostProcessErrorCode } from '#/os/interface/hostProcess';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { abortable } from '#/_base/utils/abort';
import { HttpMcpClient } from './client-http';
import { classifyRemoteDiscoveryError, isRemoteMcpConfig } from './client-remote';
import { SseMcpClient } from './client-sse';
import {
  classifyMcpDiscoveryError,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  McpClassifiedStartupError,
  probeMcpLiveness,
  type McpFailureKind,
  type SessionEvidence,
  type UnexpectedCloseReason,
} from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { assertMcpInputSchema, type MCPClient, type MCPToolDefinition } from './types';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';

export interface McpServerEntry {
  readonly name: string;
  readonly transport: McpServerConfig['transport'];
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
  readonly nextRetryAt?: number;
}

type InternalState =
  | 'connecting'
  | 'connected'
  | 'probing'
  | 'retryWaiting'
  | 'failed'
  | 'needsAuth'
  | 'disabled'
  | 'removed';

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  state: InternalState;
  attemptId: number;
  attemptPromise?: Promise<void>;
  attemptClient?: RuntimeMcpClient;
  deferred: boolean;
  failureStreak: number;
  nextRetryAt?: number;
  error?: string;
  client?: RuntimeMcpClient;
  tools?: readonly Tool[];
  rawTools?: readonly MCPToolDefinition[];
  enabledNames?: ReadonlySet<string>;
  connectedAt?: number;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

export interface McpConnectionView {
  readonly oauthService: McpOAuthService | undefined;
  list(): readonly McpServerEntry[];
  get(name: string): McpServerEntry | undefined;
  deferredOf(name: string): boolean;
  resolved(
    name: string,
  ):
    | {
        client: MCPClient;
        tools: readonly Tool[];
        rawTools: readonly MCPToolDefinition[];
        enabledNames: ReadonlySet<string>;
        deferred: boolean;
      }
    | undefined;
  getRemoteServerUrl(name: string): string | undefined;
  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean>;
  reconnect(name: string): Promise<void>;
  reconnectAndJoin(name: string): Promise<void>;
  waitForInitialLoad(signal?: AbortSignal): Promise<void>;
  initialLoadDurationMs(): number;
  onStatusChange(listener: McpStatusListener): () => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 300_000;
const MAX_FAILURE_STREAK = 31;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;
const defaultLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => defaultLog,
};

export interface McpDefaults {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly defaultDeferred?: boolean;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  readonly stdioCwd?: string;
  readonly runtimeResolver?: import('#/workspace/workspaceInstance/workspaceInstanceManager').IRuntimeResolver;
  readonly workspaceId?: string;
  readonly runtimeId?: string;
  readonly requireStdioRuntimeId?: boolean;
  readonly reconnectRetryEnabled?: boolean;
  readonly oauthService?: McpOAuthService;
  readonly log?: Logger;
  readonly resolveDefaults?: () => McpDefaults;
  readonly resolveClientName?: () => string | undefined;
}

type McpEntryEvent =
  | { readonly type: 'start' }
  | { readonly type: 'kick' }
  | { readonly type: 'retryDue' }
  | { readonly type: 'retryPolicyChanged' }
  | {
      readonly type: 'handshakeSucceeded';
      readonly attemptId: number;
      readonly client: RuntimeMcpClient;
      readonly tools: readonly Tool[];
      readonly rawTools: readonly MCPToolDefinition[];
      readonly enabledNames: ReadonlySet<string>;
    }
  | {
      readonly type: 'handshakeFailed';
      readonly attemptId: number;
      readonly error: unknown;
      readonly client?: RuntimeMcpClient;
    }
  | { readonly type: 'probeSucceeded'; readonly attemptId: number; readonly client: RuntimeMcpClient }
  | {
      readonly type: 'probeFailed';
      readonly attemptId: number;
      readonly client: RuntimeMcpClient;
      readonly reason: UnexpectedCloseReason;
    }
  | { readonly type: 'sessionEvidence'; readonly evidence: SessionEvidence }
  | { readonly type: 'needsAuth' }
  | { readonly type: 'disable' }
  | { readonly type: 'remove' };

interface TransitionPlan {
  readonly target: InternalState;
  readonly resetStreak?: boolean;
  readonly rescheduleRetry?: boolean;
  readonly forceEmit?: boolean;
  readonly client?: RuntimeMcpClient;
  readonly tools?: readonly Tool[];
  readonly rawTools?: readonly MCPToolDefinition[];
  readonly enabledNames?: ReadonlySet<string>;
  readonly error?: string;
  readonly weakReason?: UnexpectedCloseReason;
}

interface NeedsAuthTransition {
  attemptId: number;
  promise?: Promise<boolean>;
}

export class McpConnectionManager implements McpConnectionView {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly needsAuthTransitions = new Map<InternalEntry, NeedsAuthTransition>();
  private readonly pendingNeedsAuthTransitions = new Set<Promise<boolean>>();
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimerAt: number | undefined;
  private initialLoad: Promise<void> = Promise.resolve();
  private initialLoadAttemptId = 0;
  private initialLoadStartedAt: number | undefined;
  private initialLoadFinishedAt: number | undefined;

  readonly oauthService: McpOAuthService | undefined;
  private readonly log: Logger;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
    this.log = options.log ?? defaultLog;
  }

  getRemoteServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (!isRemoteMcpConfig(entry.config)) return undefined;
    return entry.config.url;
  }

  getHttpServerUrl(name: string): string | undefined {
    return this.getRemoteServerUrl(name);
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly McpServerEntry[] {
    return Array.from(this.entries.values(), toPublicEntry);
  }

  get(name: string): McpServerEntry | undefined {
    const entry = this.entries.get(name);
    return entry !== undefined ? toPublicEntry(entry) : undefined;
  }

  deferredOf(name: string): boolean {
    return this.entries.get(name)?.deferred ?? false;
  }

  private resolveDeferred(config: McpServerConfig): boolean {
    return config.deferred ?? this.options.resolveDefaults?.().defaultDeferred ?? false;
  }

  resolved(
    name: string,
  ):
    | {
        client: MCPClient;
        tools: readonly Tool[];
        rawTools: readonly MCPToolDefinition[];
        enabledNames: ReadonlySet<string>;
        deferred: boolean;
      }
    | undefined {
    const entry = this.entries.get(name);
    const usable = entry?.state === 'connected' || entry?.state === 'probing';
    if (
      !usable ||
      entry.tools === undefined ||
      entry.rawTools === undefined ||
      entry.client === undefined
    ) {
      return undefined;
    }
    return {
      client: entry.client,
      tools: entry.tools,
      rawTools: entry.rawTools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.name)),
      deferred: entry.deferred,
    };
  }

  connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const attemptId = ++this.initialLoadAttemptId;
    this.initialLoadStartedAt = Date.now();
    this.initialLoadFinishedAt = undefined;
    const initialLoad = this.connectAllNow(configs).finally(() => {
      if (this.initialLoadAttemptId === attemptId) {
        this.initialLoadFinishedAt = Date.now();
      }
    });
    this.initialLoad = initialLoad;
    return initialLoad;
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    const entry = this.upsert(name, config);
    await (entry.attemptPromise ?? this.operationTails.get(name));
  }

  async remove(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    this.transition(entry, { type: 'disable' });
    const closing = this.operationTails.get(name);
    this.entries.delete(name);
    await closing;
    return true;
  }

  async markRemoved(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    this.transition(entry, { type: 'remove' });
    await this.operationTails.get(name);
    return true;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (signal === undefined) return this.initialLoad;
    return abortable(this.initialLoad, signal);
  }

  initialLoadDurationMs(): number {
    if (this.initialLoadStartedAt === undefined) return 0;
    const endedAt = this.initialLoadFinishedAt ?? Date.now();
    return Math.max(0, endedAt - this.initialLoadStartedAt);
  }

  private async connectAllNow(configs: Record<string, McpServerConfig>): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, config] of Object.entries(configs)) {
      const entry = this.upsert(name, config);
      const operation = entry.attemptPromise ?? this.operationTails.get(name);
      if (operation !== undefined) tasks.push(operation);
    }
    await Promise.allSettled(tasks);
  }

  private upsert(name: string, config: McpServerConfig): InternalEntry {
    const previous = this.entries.get(name);
    if (previous !== undefined) {
      if (isLiveState(previous.state) && mcpServerConfigsEqual(previous.config, config)) {
        return previous;
      }
      this.retireEntry(previous);
    }
    const disabled = config.enabled === false;
    const entry: InternalEntry = {
      name,
      config,
      state: disabled ? 'disabled' : 'connecting',
      attemptId: 0,
      deferred: this.resolveDeferred(config),
      failureStreak: 0,
    };
    this.entries.set(name, entry);
    this.emit(entry);
    if (entry.state === 'connecting') {
      this.transition(entry, { type: 'start' });
    }
    return entry;
  }

  private retireEntry(entry: InternalEntry): void {
    const client = entry.client;
    entry.client = undefined;
    if (client !== undefined) this.closeForLifecycle(entry, client);
    const attemptClient = entry.attemptClient;
    entry.attemptClient = undefined;
    if (attemptClient !== undefined) this.closeForLifecycle(entry, attemptClient);
  }

  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined || entry.state === 'removed') {
      throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new Error2(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    if (entry.state !== 'connecting' || entry.attemptPromise === undefined) {
      this.transition(entry, { type: 'kick' });
    }
    await entry.attemptPromise;
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.reconnect(name);
  }

  async reconnectAfterCurrent(name: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const operation = this.operationTails.get(name);
    const entry = this.entries.get(name);
    const transition = entry === undefined ? undefined : this.needsAuthTransitions.get(entry);
    const authenticating =
      entry !== undefined && transition?.attemptId === entry.attemptId
        ? transition.promise
        : undefined;
    const attempt = entry?.attemptPromise;
    if (operation !== undefined) pending.push(operation);
    if (authenticating !== undefined) pending.push(authenticating);
    if (attempt !== undefined) pending.push(attempt);
    await Promise.allSettled(pending);
    await this.reconnectAndJoin(name);
  }

  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return Promise.resolve(false);
    if (entry.state !== 'connected' && entry.state !== 'probing' && entry.state !== 'needsAuth') {
      return Promise.resolve(false);
    }
    if (!this.shouldMarkNeedsAuth(entry, error)) return Promise.resolve(false);
    const existing = this.needsAuthTransitions.get(entry);
    const redrive = existing !== undefined && existing.attemptId !== entry.attemptId;
    if (existing !== undefined && !redrive) return existing.promise!;
    if (entry.state === 'needsAuth' && !redrive) return Promise.resolve(true);
    if (entry.state !== 'needsAuth' && client !== undefined && entry.client !== client) {
      return Promise.resolve(false);
    }
    const transition: NeedsAuthTransition = { attemptId: entry.attemptId };
    const work = this.performMarkNeedsAuth(name, error, client, redrive, transition).finally(() => {
      if (this.needsAuthTransitions.get(entry) === transition) {
        this.needsAuthTransitions.delete(entry);
      }
      this.pendingNeedsAuthTransitions.delete(work);
    });
    transition.promise = work;
    this.pendingNeedsAuthTransitions.add(work);
    this.needsAuthTransitions.set(entry, transition);
    return work;
  }

  private async performMarkNeedsAuth(
    name: string,
    error: unknown,
    client: MCPClient | undefined,
    redrive: boolean,
    transition: NeedsAuthTransition,
  ): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    if (entry.state !== 'connected' && entry.state !== 'probing' && entry.state !== 'needsAuth') {
      return false;
    }
    if (!this.shouldMarkNeedsAuth(entry, error)) return false;
    if (entry.state === 'needsAuth' && !redrive) return true;
    if (entry.state !== 'needsAuth' && client !== undefined && entry.client !== client) return false;
    const guard = entry.attemptId;
    const oauthService = this.oauthService;
    const rejectedGrant =
      oauthService !== undefined && isRemoteMcpConfig(entry.config)
        ? await oauthService.peekRejectedGrant(name, entry.config.url, entry.connectedAt)
        : undefined;
    if (!this.isCurrent(entry, guard)) return false;
    if (rejectedGrant?.concurrent === true) return false;
    this.transition(entry, { type: 'needsAuth' });
    const current = this.entries.get(name);
    if (current !== entry || current.state !== 'needsAuth') return false;
    const authGuard = entry.attemptId;
    transition.attemptId = authGuard;
    await this.operationTails.get(name);
    if (!this.isCurrent(entry, authGuard)) return false;
    if (rejectedGrant !== undefined && oauthService !== undefined && isRemoteMcpConfig(entry.config)) {
      try {
        await oauthService.invalidateTokensIfCurrent(name, entry.config.url, rejectedGrant.tokens);
      } catch (invalidateError) {
        this.log.warn('mcp oauth token invalidation failed', {
          server: name,
          reason:
            invalidateError instanceof Error ? invalidateError.message : String(invalidateError),
        });
      }
    }
    return this.isCurrent(entry, authGuard);
  }

  async shutdown(): Promise<void> {
    this.stopReconcile();
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    for (const entry of entries) {
      const client = entry.client;
      entry.client = undefined;
      if (client !== undefined) this.closeForLifecycle(entry, client);
      const attemptClient = entry.attemptClient;
      entry.attemptClient = undefined;
      if (attemptClient !== undefined) this.closeForLifecycle(entry, attemptClient);
    }
    await Promise.allSettled([
      ...this.operationTails.values(),
      ...this.pendingNeedsAuthTransitions,
    ]);
  }

  rescheduleRetries(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === 'retryWaiting') this.transition(entry, { type: 'retryPolicyChanged' });
    }
  }

  private transition(entry: InternalEntry, event: McpEntryEvent): void {
    const plan = this.planTransition(entry, event);
    if (plan === undefined) return;
    const automaticRetry = entry.state === 'connecting' && entry.failureStreak > 0;
    const before = toPublicEntry(entry);
    const fromFamily = entry.state === 'connected' || entry.state === 'probing';
    const toFamily = plan.target === 'connected' || plan.target === 'probing';
    if (!(fromFamily && toFamily)) entry.attemptId += 1;
    if (fromFamily && !toFamily) {
      const client = entry.client;
      entry.client = undefined;
      if (client !== undefined) this.closeForLifecycle(entry, client);
    }
    const attemptClient = entry.attemptClient;
    entry.attemptClient = undefined;
    if (plan.target === 'connected') {
      if (plan.client !== undefined) entry.client = plan.client;
      if (attemptClient !== undefined && attemptClient !== plan.client) {
        this.closeForLifecycle(entry, attemptClient);
      }
    } else if (attemptClient !== undefined) {
      this.closeForLifecycle(entry, attemptClient);
    }
    if (!toFamily) {
      entry.tools = undefined;
      entry.rawTools = undefined;
      entry.enabledNames = undefined;
      entry.connectedAt = undefined;
    }
    entry.error = undefined;
    entry.nextRetryAt = undefined;
    if (plan.target !== 'connecting') entry.attemptPromise = undefined;
    entry.state = plan.target;
    switch (plan.target) {
      case 'connecting': {
        if (plan.resetStreak === true) entry.failureStreak = 0;
        entry.deferred = this.resolveDeferred(entry.config);
        const attemptId = entry.attemptId;
        entry.attemptPromise = this.enqueueOperation(entry.name, () =>
          this.runConnectAttempt(entry, attemptId),
        );
        break;
      }
      case 'connected': {
        if (plan.client !== undefined) {
          entry.tools = plan.tools;
          entry.rawTools = plan.rawTools;
          entry.enabledNames = plan.enabledNames;
          entry.connectedAt = this.oauthService?.now() ?? Date.now();
          entry.failureStreak = 0;
          this.attachSessionEvidence(entry, plan.client, entry.attemptId);
        }
        break;
      }
      case 'probing': {
        const client = entry.client;
        if (client !== undefined) {
          const attemptId = entry.attemptId;
          const reason = plan.weakReason ?? {};
          void this.enqueueOperation(entry.name, () => this.runProbe(entry, client, attemptId, reason));
        }
        break;
      }
      case 'retryWaiting': {
        entry.error = plan.error;
        const streak = plan.rescheduleRetry === true
          ? Math.max(0, entry.failureStreak - 1)
          : entry.failureStreak;
        const delayMs = this.nextRetryDelayMs(streak);
        if (plan.rescheduleRetry !== true) {
          entry.failureStreak = Math.min(entry.failureStreak + 1, MAX_FAILURE_STREAK);
        }
        entry.nextRetryAt = Date.now() + delayMs;
        this.log.info('mcp server reconnect scheduled', {
          server: entry.name,
          delayMs,
          attempt: entry.failureStreak,
        });
        break;
      }
      case 'failed':
      case 'needsAuth': {
        entry.error = plan.error;
        break;
      }
      case 'disabled':
      case 'removed':
        break;
    }
    const after = toPublicEntry(entry);
    const suppressRetryStatus = event.type === 'retryDue' || (automaticRetry && plan.target === 'retryWaiting');
    if (!suppressRetryStatus && (plan.forceEmit === true || !publicEntriesEqual(before, after))) {
      this.emit(entry);
    }
    this.scheduleReconcile();
  }

  private planTransition(entry: InternalEntry, event: McpEntryEvent): TransitionPlan | undefined {
    const from = entry.state;
    switch (event.type) {
      case 'start':
        return from === 'connecting' ? { target: 'connecting', resetStreak: true } : undefined;
      case 'kick':
        if (from === 'disabled' || from === 'removed') return undefined;
        return { target: 'connecting', resetStreak: true };
      case 'retryDue':
        return from === 'retryWaiting' ? { target: 'connecting' } : undefined;
      case 'retryPolicyChanged':
        return from === 'retryWaiting'
          ? { target: 'retryWaiting', error: entry.error, rescheduleRetry: true }
          : undefined;
      case 'handshakeSucceeded': {
        if (from !== 'connecting' || !this.isCurrent(entry, event.attemptId)) {
          this.closeForLifecycle(entry, event.client);
          return undefined;
        }
        return {
          target: 'connected',
          client: event.client,
          tools: event.tools,
          rawTools: event.rawTools,
          enabledNames: event.enabledNames,
        };
      }
      case 'handshakeFailed': {
        if (from !== 'connecting' || !this.isCurrent(entry, event.attemptId)) {
          if (event.client !== undefined) this.closeForLifecycle(entry, event.client);
          return undefined;
        }
        const target = this.failureTarget(classifyStartupFailure(event.error));
        if (target === 'needsAuth') return { target, error: needsAuthHint(entry.name) };
        return { target, error: formatStartupError(event.error, event.client) };
      }
      case 'probeSucceeded':
        if (from !== 'probing') return undefined;
        if (!this.isCurrent(entry, event.attemptId)) return undefined;
        if (entry.client !== event.client) return undefined;
        return { target: 'connected' };
      case 'probeFailed': {
        if (from !== 'probing') return undefined;
        if (!this.isCurrent(entry, event.attemptId)) return undefined;
        if (entry.client !== event.client) return undefined;
        return {
          target: this.retryOrFailed(),
          error: formatUnexpectedCloseError(entry.name, event.reason),
        };
      }
      case 'sessionEvidence': {
        if (from !== 'connected' && from !== 'probing') return undefined;
        if (event.evidence.kind === 'weak') {
          return from === 'connected'
            ? { target: 'probing', weakReason: event.evidence.reason }
            : undefined;
        }
        return {
          target: this.retryOrFailed(),
          error: formatUnexpectedCloseError(entry.name, event.evidence.reason),
        };
      }
      case 'needsAuth':
        if (from !== 'connected' && from !== 'probing') return undefined;
        return { target: 'needsAuth', error: needsAuthHint(entry.name) };
      case 'disable':
        return { target: 'disabled', forceEmit: true };
      case 'remove':
        return { target: 'removed' };
    }
  }

  private failureTarget(kind: McpFailureKind): 'failed' | 'needsAuth' | 'retryWaiting' {
    if (kind === 'config' || kind === 'protocol' || kind === 'auth-static') return 'failed';
    if (kind === 'auth-oauth' && this.oauthService !== undefined) return 'needsAuth';
    return this.retryOrFailed();
  }

  private retryOrFailed(): 'retryWaiting' | 'failed' {
    return this.options.reconnectRetryEnabled === true ? 'retryWaiting' : 'failed';
  }

  private nextRetryDelayMs(streak: number): number {
    const defaults = this.options.resolveDefaults?.();
    const initialDelayMs = defaults?.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    const maxDelayMs = defaults?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    return Math.min(initialDelayMs * 2 ** streak, maxDelayMs) * (0.5 + Math.random() * 0.5);
  }

  private enqueueOperation(name: string, work: () => Promise<void>): Promise<void> {
    const previous = this.operationTails.get(name) ?? Promise.resolve();
    const operation = previous.then(work);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(name, tail);
    void tail.then(() => {
      if (this.operationTails.get(name) === tail) this.operationTails.delete(name);
    });
    return operation;
  }

  private closeForLifecycle(entry: InternalEntry, client: RuntimeMcpClient): void {
    const closing = this.closeRuntimeClient(client);
    void this.enqueueOperation(entry.name, () => closing);
  }

  private async runConnectAttempt(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs =
      entry.config.startupTimeoutMs ??
      this.options.resolveDefaults?.().startupTimeoutMs ??
      DEFAULT_STARTUP_TIMEOUT_MS;
    let client: RuntimeMcpClient | undefined;
    try {
      if (!this.isCurrent(entry, attemptId)) return;
      const startupClient = await this.createClient(entry.config, entry.name, timeoutMs);
      client = startupClient;
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.attemptClient = startupClient;
      const discovered = await withTimeout(
        this.connectAndDiscoverTools(startupClient, entry.config),
        timeoutMs,
        () => {
          if (entry.attemptClient === startupClient) entry.attemptClient = undefined;
          this.closeForLifecycle(entry, startupClient);
        },
      );
      this.transition(entry, {
        type: 'handshakeSucceeded',
        attemptId,
        client: startupClient,
        tools: discovered.tools,
        rawTools: discovered.rawTools,
        enabledNames: computeEnabledNames(entry.config, discovered.tools),
      });
    } catch (error) {
      this.transition(entry, { type: 'handshakeFailed', attemptId, error, client });
    }
  }

  private attachSessionEvidence(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onSessionEvidence((evidence) => {
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      this.transition(entry, { type: 'sessionEvidence', evidence });
    });
  }

  private async runProbe(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
    reason: UnexpectedCloseReason,
  ): Promise<void> {
    try {
      const alive = await probeMcpLiveness(client, AbortSignal.timeout(MCP_LIVENESS_PROBE_TIMEOUT_MS));
      if (alive) {
        this.transition(entry, { type: 'probeSucceeded', attemptId, client });
      } else {
        this.transition(entry, { type: 'probeFailed', attemptId, client, reason });
      }
    } catch {
      this.transition(entry, { type: 'probeFailed', attemptId, client, reason });
    }
  }

  private scheduleReconcile(): void {
    let nearest: number | undefined;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'retryWaiting' || entry.nextRetryAt === undefined) continue;
      if (nearest === undefined || entry.nextRetryAt < nearest) nearest = entry.nextRetryAt;
    }
    if (nearest === undefined) {
      this.stopReconcile();
      return;
    }
    if (this.reconcileTimerAt !== undefined && this.reconcileTimerAt <= nearest) return;
    this.stopReconcile();
    this.reconcileTimerAt = nearest;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      this.reconcileTimerAt = undefined;
      const now = Date.now();
      for (const entry of this.entries.values()) {
        if (entry.state === 'retryWaiting' && entry.nextRetryAt !== undefined && entry.nextRetryAt <= now) {
          this.transition(entry, { type: 'retryDue' });
        }
      }
      this.scheduleReconcile();
    }, Math.max(0, nearest - Date.now()));
    this.reconcileTimer.unref?.();
  }

  private stopReconcile(): void {
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.reconcileTimerAt = undefined;
  }

  private async createClient(
    config: McpServerConfig,
    name: string,
    startupTimeoutMs: number,
  ): Promise<RuntimeMcpClient> {
    const toolCallTimeoutMs =
      config.toolTimeoutMs ?? this.options.resolveDefaults?.().toolTimeoutMs;
    const clientName = this.options.resolveClientName?.();
    if (config.transport === 'stdio') {
      const runtimeResolver = this.options.runtimeResolver;
      const workspaceId = this.options.workspaceId;
      const runtimeId = config.runtime_id ?? this.options.runtimeId;
      if (runtimeResolver === undefined || workspaceId === undefined || runtimeId === undefined || (this.options.requireStdioRuntimeId === true && config.runtime_id === undefined)) {
        throw new McpClassifiedStartupError(
          'config',
          'MCP stdio requires runtime_id and runtime binding',
        );
      }
      return new StdioMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        defaultCwd: this.options.stdioCwd,
        clientName,
        runtimeResolver,
        workspaceId,
        runtimeId,
      });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: await this.resolveOAuthProvider(config, name),
        clientName,
      });
    }
    return new HttpMcpClient(config, {
      startupTimeoutMs,
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: await this.resolveOAuthProvider(config, name),
      clientName,
    });
  }

  private async resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): Promise<ReturnType<McpOAuthService['getProvider']> | undefined> {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (!isRemoteMcpConfig(config)) return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    if (!(await oauthService.hasTokens(name, config.url))) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (!isRemoteMcpConfig(entry.config)) return false;
    if (entry.config.bearerTokenEnvVar !== undefined) return false;
    if (entry.config.headers !== undefined && entry.config.auth !== 'oauth') return false;
    return isUnauthorizedLikeError(error);
  }

  private async connectAndDiscoverTools(
    client: RuntimeMcpClient,
    config: McpServerConfig,
  ): Promise<{ tools: Tool[]; rawTools: MCPToolDefinition[] }> {
    await client.connect();
    let mcpTools: MCPToolDefinition[];
    try {
      mcpTools = await client.listTools();
    } catch (error) {
      throw isRemoteMcpConfig(config)
        ? classifyRemoteDiscoveryError(config, error)
        : classifyMcpDiscoveryError(error);
    }
    try {
      return {
        rawTools: mcpTools,
        tools: mcpTools.map((mcpTool) => ({
          name: mcpTool.name,
          description: mcpTool.description,
          parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
        })),
      };
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.MCP_STARTUP_FAILED) {
        throw new McpClassifiedStartupError('protocol', error.message, { cause: error });
      }
      throw error;
    }
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
    }
  }

  private isCurrent(entry: InternalEntry, attemptId: number): boolean {
    return this.entries.get(entry.name) === entry && entry.attemptId === attemptId;
  }

  private emit(entry: InternalEntry): void {
    const view = toPublicEntry(entry);
    if (view.status === 'failed' || view.status === 'needs-auth') {
      this.log.error('mcp server unavailable', {
        server: view.name,
        transport: view.transport,
        status: view.status,
        reason: view.error,
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
      }
    }
  }
}

function isLiveState(state: InternalState): boolean {
  return state === 'connecting' || state === 'connected' || state === 'probing';
}

const publicStatusByState: Record<InternalState, McpServerStatus> = {
  connecting: 'pending',
  connected: 'connected',
  probing: 'connected',
  retryWaiting: 'failed',
  failed: 'failed',
  needsAuth: 'needs-auth',
  disabled: 'disabled',
  removed: 'removed',
};

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: publicStatusByState[entry.state],
    toolCount: entry.enabledNames?.size ?? 0,
    error: entry.error,
    nextRetryAt: entry.state === 'retryWaiting' ? entry.nextRetryAt : undefined,
  };
}

function publicEntriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  return (
    a.status === b.status &&
    a.toolCount === b.toolCount &&
    a.error === b.error &&
    a.nextRetryAt === b.nextRetryAt
  );
}

function computeEnabledNames(config: McpServerConfig, tools: readonly Tool[]): Set<string> {
  const all = tools.map((t) => t.name);
  const enabledFilter =
    config.enabledTools !== undefined ? new Set(config.enabledTools) : undefined;
  const disabledFilter =
    config.disabledTools !== undefined ? new Set(config.disabledTools) : undefined;
  const allowed = new Set<string>();
  for (const name of all) {
    if (enabledFilter !== undefined && !enabledFilter.has(name)) continue;
    if (disabledFilter !== undefined && disabledFilter.has(name)) continue;
    allowed.add(name);
  }
  return allowed;
}

function classifyStartupFailure(error: unknown): McpFailureKind {
  if (error instanceof McpClassifiedStartupError) return error.failureKind;
  if (error instanceof Error2 && error.code === ErrorCodes.CONFIG_INVALID) return 'config';
  return 'transport';
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof McpError) return false;
  if (error.name === 'UnauthorizedError') return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function needsAuthHint(name: string): string {
  return `${name} requires OAuth — run /mcp-config login ${name}`;
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const unwrapped =
    error instanceof McpClassifiedStartupError && error.cause !== undefined ? error.cause : error;
  const source =
    unwrapped instanceof HostProcessError &&
    unwrapped.code === HostProcessErrorCode.SpawnFailed &&
    unwrapped.cause instanceof Error
      ? unwrapped.cause
      : unwrapped;
  const base = source instanceof Error ? source.message : String(source);
  const tail = stderrTail(client);
  if (tail === undefined) return base;
  return `${base}\nstderr: ${tail}`;
}

function formatUnexpectedCloseError(name: string, reason: UnexpectedCloseReason): string {
  const parts = [`MCP server "${name}" closed unexpectedly`];
  if (reason.error !== undefined) {
    parts.push(reason.error.message);
  }
  if (reason.stderr !== undefined && reason.stderr.length > 0) {
    parts.push(`stderr: ${reason.stderr.trimEnd()}`);
  }
  return parts.join('\n');
}

function stderrTail(client: RuntimeMcpClient | undefined): string | undefined {
  if (client === undefined) return undefined;
  if (!(client instanceof StdioMcpClient)) return undefined;
  const snapshot = client.stderrSnapshot();
  if (snapshot.length === 0) return undefined;
  return snapshot.trimEnd();
}

export function mcpServerConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return stableConfigJson(a) === stableConfigJson(b);
}

function stableConfigJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableConfigJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableConfigJson(entryValue)}`)
      .toSorted();
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error2(ErrorCodes.MCP_STARTUP_FAILED, `Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
