import { ErrorCodes, KimiError } from '#/errors';
import type { McpServerStdioConfig } from '#/config/schema';
import { proxyEnvForChild, reconcileChildNoProxy } from '#/utils/proxy';
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

/**
 * Wraps the `@modelcontextprotocol/sdk` stdio client and exposes the small
 * surface required by kosong's {@link MCPClient}. Lifecycle is explicit:
 * the caller must `connect()` before use and `close()` to terminate the
 * child process.
 */
export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  // Flips to true only after `client.connect()` resolves AND the caller has
  // not torn things down mid-startup. The `onclose` hook uses this to
  // distinguish "transport died after the handshake" (→ unexpected close)
  // from "transport died during the handshake" (→ `connect()` throws; the
  // manager surfaces the failure via `formatStartupError`).
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // Buffered when the transport closes before a listener is installed (e.g.
  // a server that exits seconds after answering `tools/list`). Replayed when
  // `onUnexpectedClose` registers so the close is never silently dropped.
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  /** Capacity (in characters) of the stderr tail captured for diagnostics. */
  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions = {}) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergeStdioEnv(config.env),
      cwd: resolveStdioCwd(config.cwd, options.defaultCwd),
      stderr: 'pipe',
    });
    // `stderr: 'pipe'` means we MUST drain the stream — otherwise the child
    // can block on a full pipe. We also keep the last few KB around so the
    // connection manager can attach it to user-facing failure messages
    // (`Timed out after 30000ms` on its own tells the user nothing).
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    // Install transport hooks BEFORE the SDK handshake so we never lose an
    // onclose that fires between handshake completion and our wiring. The
    // hooks themselves gate on `this.ready`, so a close that happens DURING
    // the handshake still flows through `client.connect()` rejecting.
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
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

  /**
   * Register a listener that fires when the underlying transport closes on
   * its own — i.e. the caller has not yet invoked {@link close}. At most one
   * listener can be installed; later registrations replace earlier ones.
   * Intentional closes never invoke the listener.
   *
   * If the transport already closed before this method was called, the
   * buffered reason is replayed synchronously so the close is never dropped.
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  /**
   * Returns the tail of bytes captured from the child's stderr since spawn.
   * Bounded by {@link StdioMcpClient.stderrBufferCapacity} so a noisy server
   * cannot exhaust memory.
   */
  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools();
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
    await this.client.close();
  }

  private installTransportHooks(): void {
    // Idempotent: `connect()` is the only caller and is itself guarded by
    // `started`, but defending here lets future refactors call this freely.
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    // `Client.onclose` fires for THREE situations:
    //   1. The intentional `close()` path → gated by `this.closed`.
    //   2. Transport dying during the SDK handshake → gated by `!this.ready`;
    //      the failure already surfaces via `client.connect()` rejecting, and
    //      `formatStartupError` attaches stderr at the manager layer.
    //   3. Transport dying after the handshake succeeded → the case we care
    //      about: fire or buffer for the manager's watch listener.
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        // Buffer so a listener registered moments later still sees the close.
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      // Errors are informational on their own — `_onclose` is what tells us
      // the transport is gone — so just remember the latest one and let the
      // close handler decide whether to surface it. During startup the thrown
      // error from `client.connect()` already carries the message, so this
      // capture is only load-bearing post-`ready`.
      this.lastTransportError = error;
    };
  }
}

/**
 * A bounded "tail" buffer: appends characters and drops the oldest when the
 * total exceeds `capacity`. Used to keep the last few KB of child-process
 * stderr around without unbounded growth.
 */
class BoundedTail {
  private buffer = '';
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  snapshot(): string {
    return this.buffer;
  }
}

function resolveStdioCwd(configCwd: string | undefined, defaultCwd: string | undefined): string | undefined {
  if (configCwd === undefined) return defaultCwd;
  if (defaultCwd !== undefined && !isAbsolute(configCwd)) return resolve(defaultCwd, configCwd);
  return configCwd;
}

// Inherit the parent's env so PATH/HOME/etc. survive — otherwise `npx`/`uvx`
// style stdio servers fail to launch even with a valid config. `config.env`
// overrides on conflict. A node child does not inherit our in-process undici
// dispatcher, so `proxyEnvForChild` adds `NODE_USE_ENV_PROXY` (and a
// loopback-protected `NO_PROXY`) to make it honor the proxy natively (on a Node
// version that supports the flag — ≥22.21 or ≥24.5). It is computed from the
// MERGED env so a proxy declared only in `config.env` is honored too.
// `reconcileChildNoProxy` then mirrors a single-casing `NO_PROXY` override onto
// both casings so it isn't shadowed by the injected value.
export function mergeStdioEnv(
  configEnv?: Record<string, string>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  Object.assign(merged, proxyEnvForChild(merged));
  reconcileChildNoProxy(merged, configEnv);
  return merged;
}
