import { ErrorCodes, Error2 } from '#/errors';
import type { McpServerStdioConfig } from './config-schema';
import { proxyEnvForChild, reconcileChildNoProxy } from '#/_base/utils/proxy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute, resolve } from 'pathe';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  private unexpectedCloseFired = false;

  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions = {}) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergeStdioEnv(config.env),
      cwd: resolveStdioCwd(config.cwd, options.defaultCwd),
      stderr: 'pipe',
    });
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport, signal ? { signal } : undefined);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP stdio client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools(undefined, signal ? { signal } : undefined);
    return result.tools.map(toMcpToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = buildRequestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    return toMcpToolResult(result);
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.client.onclose = undefined;
    this.client.onerror = undefined;
    await this.client.close();
  }

  private installTransportHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      this.fireUnexpectedClose({
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      });
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
    };
  }

  private fireUnexpectedClose(reason: UnexpectedCloseReason): void {
    if (this.unexpectedCloseFired) return;
    this.unexpectedCloseFired = true;
    const listener = this.unexpectedCloseListener;
    if (listener !== undefined) {
      listener(reason);
    } else {
      this.pendingUnexpectedClose = reason;
    }
  }
}

class BoundedTail {
  private chunks: string[] = [];
  private total = 0;
  private cached: string | undefined;
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.length;
    }
    if (this.total > this.capacity) {
      const overflow = this.total - this.capacity;
      this.chunks[0] = this.chunks[0]!.slice(overflow);
      this.total = this.capacity;
    }
    this.cached = undefined;
  }

  snapshot(): string {
    if (this.cached === undefined) this.cached = this.chunks.join('');
    return this.cached;
  }
}

function resolveStdioCwd(configCwd: string | undefined, defaultCwd: string | undefined): string | undefined {
  if (configCwd === undefined) return defaultCwd;
  if (defaultCwd !== undefined && !isAbsolute(configCwd)) return resolve(defaultCwd, configCwd);
  return configCwd;
}

/**
 * Allowlist of parent-process environment variables that are propagated
 * to spawned MCP stdio servers. Everything else is dropped unless the
 * server config explicitly declares it via ``env`` — this prevents
 * leaking cloud credentials, database URLs, signing keys, and other
 * secrets from the user's shell into untrusted MCP servers installed
 * via ``.mcp.json``.
 *
 * The list intentionally mirrors what a generic child process needs to
 * run: shell/PATH lookup, locale, terminal, and OS identity. Anything
 * service-specific (AWS_*, GITHUB_*, DATABASE_URL, …) must be declared
 * explicitly in the server config.
 */
const ALLOWED_PARENT_ENV_KEYS = new Set<string>([
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

function isAllowedParentEnvKey(key: string): boolean {
  return ALLOWED_PARENT_ENV_KEYS.has(key.toUpperCase());
}

export function mergeStdioEnv(
  configEnv?: Record<string, string>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && isAllowedParentEnvKey(key)) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  Object.assign(merged, proxyEnvForChild(merged));
  reconcileChildNoProxy(merged, configEnv);
  return merged;
}
