import type { ToolDescription as Tool } from '@moonshot-ai/agent-core/llm/message';

import { OsProcessError, type OsHost } from '#/features/os/host/index';

import type { McpOAuthService } from '../oauth/service';

import { HttpMcpClient } from './client-http';
import { SseMcpClient } from './client-sse';
import {
  abortable,
  assertMcpInputSchema,
  isRemoteMcpConfig,
  type MCPClient,
  type MCPToolDefinition,
  type UnexpectedCloseReason,
} from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpServerConfig } from './config-schema';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';

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

export interface ResolvedMcpServer {
  readonly client: MCPClient;
  readonly tools: readonly Tool[];
  readonly rawTools: readonly MCPToolDefinition[];
  readonly enabledNames: ReadonlySet<string>;
  readonly deferred: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;

export interface McpDefaultTimeouts {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface McpConnectionManagerOptions {
  readonly host?: OsHost;
  readonly envLookup?: (name: string) => string | undefined;
  readonly stdioCwd?: string;
  readonly oauthService?: McpOAuthService;
  readonly resolveDefaultTimeouts?: () => McpDefaultTimeouts;
}

export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private readonly inFlightReconnects = new Map<string, Promise<void>>();
  private initialLoad: Promise<void> = Promise.resolve();

  readonly oauthService: McpOAuthService | undefined;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
  }

  getRemoteServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (!isRemoteMcpConfig(entry.config)) return undefined;
    return entry.config.url;
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

  configOf(name: string): McpServerConfig | undefined {
    return this.entries.get(name)?.config;
  }

  resolved(name: string): ResolvedMcpServer | undefined {
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
      deferred: entry.config.deferred === true,
    };
  }

  connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const initialLoad = this.connectAllNow(configs);
    this.initialLoad = initialLoad;
    return initialLoad;
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    const previous = this.entries.get(name);
    if (previous !== undefined) {
      if (
        (previous.status === 'pending' || previous.status === 'connected') &&
        mcpServerConfigsEqual(previous.config, config)
      ) {
        return;
      }
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

  async markRemoved(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    await this.closeClient(entry);
    entry.status = 'removed';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.rawTools = undefined;
    entry.error = undefined;
    this.emit(entry);
    return true;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (signal === undefined) return this.initialLoad;
    return abortable(this.initialLoad, signal);
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
    if (entry === undefined || entry.status === 'removed') {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new Error(`MCP server is disabled: ${name}`);
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

  reconnectAndJoin(name: string): Promise<void> {
    const existing = this.inFlightReconnects.get(name);
    if (existing !== undefined) return existing;
    const work = this.reconnect(name).finally(() => {
      if (this.inFlightReconnects.get(name) === work) {
        this.inFlightReconnects.delete(name);
      }
    });
    this.inFlightReconnects.set(name, work);
    return work;
  }

  async reconnectAfterCurrent(name: string): Promise<void> {
    const existing = this.inFlightReconnects.get(name);
    if (existing !== undefined) await existing.catch(() => undefined);
    await this.reconnectAndJoin(name);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs =
      entry.config.startupTimeoutMs ??
      this.options.resolveDefaultTimeouts?.().startupTimeoutMs ??
      DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = await this.createClient(entry.config, entry.name, timeoutMs);
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
        entry.error = `${entry.name} requires OAuth — call the server's authenticate tool to sign in`;
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

  private async createClient(
    config: McpServerConfig,
    name: string,
    startupTimeoutMs: number,
  ): Promise<RuntimeMcpClient> {
    const toolCallTimeoutMs =
      config.toolTimeoutMs ?? this.options.resolveDefaultTimeouts?.().toolTimeoutMs;
    if (config.transport === 'stdio') {
      const host = this.options.host;
      if (host === undefined) {
        throw new Error(
          `MCP stdio server "${name}" cannot start: createMcp was mounted without an OS host; pass host to createMcp to enable stdio servers`,
        );
      }
      if (config.runtime_id !== undefined && config.runtime_id !== 'local') {
        throw new Error(`MCP stdio server "${name}" sets runtime_id, which this harness does not support (local stdio only)`);
      }
      return new StdioMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        defaultCwd: this.options.stdioCwd,
        host,
      });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: await this.resolveOAuthProvider(config, name),
      });
    }
    return new HttpMcpClient(config, {
      startupTimeoutMs,
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
    if (entry.config.headers !== undefined && entry.config.auth !== 'oauth') return false;
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
  const source =
    error instanceof OsProcessError && error.code === 'os.process.spawn_failed' && error.cause instanceof Error
      ? error.cause
      : error;
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
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
