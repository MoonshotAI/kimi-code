/**
 * `mcp` domain (L5) — `McpConnectionManager`, the per-session MCP server
 * connection orchestrator.
 *
 * Owns the configured MCP servers and their runtime clients: connects
 * (stdio / SSE / HTTP), discovers and registers tools, attaches the OAuth
 * provider through `mcp/oauth` when tokens are present, flips failing
 * servers into `needs-auth` on 401, and reconnects after authentication.
 * Emits server status changes to subscribers. Constructed by `AgentMcpService`.
 */

import { ErrorCodes, Error2 } from '#/errors';
import type { McpServerConfig } from './config-schema';
import type { ILogger as Logger } from '#/_base/log/log';
import type { Tool } from '#/app/llmProtocol/tool';

import { abortable } from '#/_base/utils/abort';
import { HttpMcpClient } from './client-http';
import { isRemoteMcpConfig } from './client-remote';
import { SseMcpClient } from './client-sse';
import type { UnexpectedCloseReason } from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpOAuthService } from '#/agent/mcp/oauth/service';
import { assertMcpInputSchema, type MCPClient, type MCPToolDefinition } from './types';

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
  rawTools?: readonly MCPToolDefinition[];
  enabledNames?: ReadonlySet<string>;
  error?: string;
  client?: RuntimeMcpClient;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;
const defaultLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => defaultLog,
};

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  readonly stdioCwd?: string;
  readonly oauthService?: McpOAuthService;
  readonly log?: Logger;
}

export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
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

  resolved(
    name: string,
  ):
    | {
        client: MCPClient;
        tools: readonly Tool[];
        rawTools: readonly MCPToolDefinition[];
        enabledNames: ReadonlySet<string>;
      }
    | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
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
    entry.rawTools = undefined;
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
      throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new Error2(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.rawTools = undefined;
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
      const startupClient = await this.createClient(entry.config, entry.name);
      client = startupClient;
      entry.client = startupClient;
      const discovered = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = discovered.tools;
      entry.rawTools = discovered.rawTools;
      entry.enabledNames = computeEnabledNames(entry.config, discovered.tools);
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
      entry.rawTools = undefined;
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
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.rawTools = undefined;
      entry.client = undefined;
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private async createClient(config: McpServerConfig, name: string): Promise<RuntimeMcpClient> {
    const toolCallTimeoutMs = config.toolTimeoutMs;
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, { toolCallTimeoutMs, defaultCwd: this.options.stdioCwd });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: await this.resolveOAuthProvider(config, name),
      });
    }
    return new HttpMcpClient(config, {
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: await this.resolveOAuthProvider(config, name),
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
    if (entry.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private async connectAndDiscoverTools(
    client: RuntimeMcpClient,
  ): Promise<{ tools: Tool[]; rawTools: MCPToolDefinition[] }> {
    await client.connect();
    const mcpTools = await client.listTools();
    return {
      rawTools: mcpTools,
      tools: mcpTools.map((mcpTool) => ({
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
      })),
    };
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
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
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
