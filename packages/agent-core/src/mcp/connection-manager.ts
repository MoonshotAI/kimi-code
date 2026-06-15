import { ErrorCodes, KimiError } from '#/errors';
import type { McpServerConfig } from '#/config/schema';
import { log as defaultLog } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { Tool } from '@moonshot-ai/kosong';

import { abortable } from '../utils/abort';
import { HttpMcpClient } from './client-http';
import { isRemoteMcpConfig } from './client-remote';
import { SseMcpClient } from './client-sse';
import type { UnexpectedCloseReason } from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpOAuthService } from './oauth';
import { assertMcpInputSchema, type MCPClient } from './types';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

export interface McpServerEntry {
  readonly name: string;
  readonly transport: McpServerConfig['transport'];
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  attemptId: number;
  status: McpServerStatus;
  tools?: readonly Tool[];
  enabledNames?: ReadonlySet<string>;
  error?: string;
  client?: RuntimeMcpClient;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * Optional OAuth orchestrator. When provided, remote servers without a
   * static bearer token participate in the OAuth-via-synthetic-tool flow:
   *  - If `oauthService.hasTokens(name, url)` is true, the provider is
   *    attached to the transport so the SDK can refresh tokens on 401.
   *  - Connection failures that look like 401 / `UnauthorizedError` flip
   *    the entry into `needs-auth` instead of `failed`; `/mcp-config`
   *    drives the browser flow through the synthetic auth tool.
   */
  readonly oauthService?: McpOAuthService;
  /**
   * Parent logger. Defaults to the global `log`; Session passes its own
   * `session.log` so MCP events land in the session log too.
   */
  readonly log?: Logger;
}

/**
 * Owns the lifecycle of every configured MCP server for a Session.
 *
 * Servers are connected in parallel; per-server failures are isolated so a
 * crashed or misconfigured entry never blocks Session startup. State
 * transitions are surfaced through {@link onStatusChange} so callers (the
 * Session) can react — registering tools onto the main agent, emitting
 * wire events, or updating the TUI.
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private initialLoad: Promise<void> = Promise.resolve();
  private initialLoadAttemptId = 0;
  private initialLoadStartedAt: number | undefined;
  private initialLoadFinishedAt: number | undefined;

  /**
   * OAuth orchestrator injected at construction time. Consumed by the
   * {@link ToolManager} `needs-auth` branch to build the synthetic
   * `authenticate` tool.
   */
  readonly oauthService: McpOAuthService | undefined;
  private readonly log: Logger;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
    this.log = options.log ?? defaultLog;
  }

  /**
   * Returns the URL of a remote MCP server by name, or `undefined` for
   * unknown / non-remote / disabled entries. Used by the synthetic auth tool
   * to drive OAuth discovery against the right base URL.
   */
  getRemoteServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (!isRemoteMcpConfig(entry.config)) return undefined;
    return entry.config.url;
  }

  /**
   * @deprecated Use {@link getRemoteServerUrl}. Kept for in-repo callers that
   * were written before legacy SSE support shared the same OAuth path.
   */
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

  /**
   * Returns the MCP client, the discovered tools, and the allow-list of tool
   * names for a given connected server, or `undefined` if the server is not
   * currently connected. The allow-list combines the server's `enabledTools`
   * and `disabledTools` filters; callers should only register names in the
   * set.
   */
  resolved(
    name: string,
  ):
    | { client: MCPClient; tools: readonly Tool[]; enabledNames: ReadonlySet<string> }
    | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
      entry.tools === undefined ||
      entry.client === undefined
    ) {
      return undefined;
    }
    return {
      client: entry.client,
      tools: entry.tools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.name)),
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
    const previous = this.entries.get(name);
    if (previous !== undefined) {
      await this.closeClient(previous);
    }
    const disabled = config.enabled === false;
    const entry: InternalEntry = {
      name,
      config,
      attemptId: 0,
      status: disabled ? 'disabled' : 'pending',
    };
    this.entries.set(name, entry);
    this.emit(entry);
    if (!disabled) {
      await this.connectOne(entry, this.beginConnectAttempt(entry));
    }
  }

  async remove(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    await this.closeClient(entry);
    entry.status = 'disabled';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.error = undefined;
    this.emit(entry);
    this.entries.delete(name);
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
      const disabled = config.enabled === false;
      const entry: InternalEntry = {
        name,
        config,
        attemptId: 0,
        status: disabled ? 'disabled' : 'pending',
      };
      this.entries.set(name, entry);
      this.emit(entry);
      if (!disabled) {
        tasks.push(this.connectOne(entry, this.beginConnectAttempt(entry)));
      }
    }
    await Promise.allSettled(tasks);
  }

  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new KimiError(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.error = undefined;
    this.emit(entry);
    await this.connectOne(entry, attemptId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = this.createClient(entry.config, entry.name);
      client = startupClient;
      entry.client = startupClient;
      const tools = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          // Best-effort cleanup if the startup promise is still racing.
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = tools;
      entry.enabledNames = computeEnabledNames(entry.config, tools);
      entry.status = 'connected';
      this.watchForUnexpectedClose(entry, startupClient, attemptId);
    } catch (error) {
      if (!this.isCurrent(entry, attemptId)) {
        if (client !== undefined) {
          await this.closeRuntimeClient(client);
        }
        return;
      }
      if (this.shouldMarkNeedsAuth(entry, error)) {
        entry.status = 'needs-auth';
        entry.error = `${entry.name} requires OAuth — run /mcp-config login ${entry.name}`;
      } else {
        entry.status = 'failed';
        entry.error = formatStartupError(error, client);
      }
      entry.tools = undefined;
      entry.enabledNames = undefined;
      // Drop the client reference so a later reconnect builds a fresh one.
      await this.closeClient(entry);
    }
    if (!this.isCurrent(entry, attemptId)) return;
    this.emit(entry);
  }

  private watchForUnexpectedClose(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onUnexpectedClose((reason) => {
      // The client may have outlived its entry (shutdown / reconnect already
      // moved on). Drop the event if so — the new attempt owns the state.
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.client = undefined;
      // Best-effort close; the transport is already gone, but this lets the
      // SDK release timers and pending request handlers.
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private createClient(config: McpServerConfig, name: string): RuntimeMcpClient {
    const toolCallTimeoutMs = config.toolTimeoutMs;
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, { toolCallTimeoutMs });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: this.resolveOAuthProvider(config, name),
      });
    }
    return new HttpMcpClient(config, {
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: this.resolveOAuthProvider(config, name),
    });
  }

  private resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): ReturnType<McpOAuthService['getProvider']> | undefined {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (!isRemoteMcpConfig(config)) return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    // Only attach the provider once tokens have been minted; before that,
    // the transport should propagate a clean 401 so we can flip the entry
    // into `needs-auth` rather than getting tangled in the SDK's auth()
    // flow (which would try DCR before we have an active redirect URL).
    if (!oauthService.hasTokens(name, config.url)) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (!isRemoteMcpConfig(entry.config)) return false;
    if (entry.config.bearerTokenEnvVar !== undefined) return false;
    // If the user pinned a static `headers` block, treat 401s as a bad header
    // rather than hijacking them into the OAuth flow — the real error is more
    // actionable than "run /mcp-config login" for a server that doesn't speak
    // OAuth.
    if (entry.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private async connectAndDiscoverTools(client: RuntimeMcpClient): Promise<Tool[]> {
    await client.connect();
    const mcpTools = await client.listTools();
    return mcpTools.map((mcpTool) => ({
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
    }));
  }

  private async closeClient(entry: InternalEntry): Promise<void> {
    if (entry.client === undefined) return;
    const client = entry.client;
    entry.client = undefined;
    await this.closeRuntimeClient(client);
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // Suppress close errors — the server is going away regardless and we
      // don't want them masking the original startup failure.
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
        // Listener faults must not break the connection manager.
      }
    }
  }
}

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount:
      entry.status === 'connected' && entry.enabledNames !== undefined
        ? entry.enabledNames.size
        : 0,
    error: entry.error,
  };
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

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  // SDK transport errors typically expose the HTTP status as `.code`.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  // Fall back to a message sniff so server-specific error shapes still flip
  // us into needs-auth instead of failed.
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const base = error instanceof Error ? error.message : String(error);
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
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
