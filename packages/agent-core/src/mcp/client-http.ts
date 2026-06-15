import type { McpServerHttpConfig } from '#/config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import { buildMcpRemoteHeaders } from './client-remote';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface HttpMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
  /**
   * Reads `process.env[name]` by default. Tests can inject a deterministic
   * lookup function so they do not have to mutate global env.
   */
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * Lets tests inject a fake `fetch` for the underlying transport.
   */
  readonly fetch?: typeof fetch;
  /**
   * OAuth client provider attached to the transport. Set only when the server
   * has no static token configuration; the SDK uses this to handle 401s with
   * RFC 9728 / RFC 8414 / DCR discovery and PKCE. The connection manager wires
   * this in and surfaces `UnauthorizedError` as a `needs-auth` status.
   */
  readonly oauthProvider?: OAuthClientProvider;
}

/**
 * Wraps the SDK streamable-HTTP transport as a kosong {@link MCPClient}.
 * Static bearer tokens are looked up from `process.env[bearerTokenEnvVar]`.
 * OAuth providers are attached separately by the connection manager.
 */
export class HttpMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private started = false;
  private closed = false;
  // See StdioMcpClient.ready — distinguishes handshake-phase failures (caller
  // sees them via `connect()` throwing, no unexpectedClose) from post-ready
  // disconnects (the case `onUnexpectedClose` is designed to surface).
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // See StdioMcpClient — buffered when the listener has not been installed
  // yet so an early close is replayed instead of dropped.
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  // Latch so `onerror` and a (theoretical) `onclose` for the same transport
  // failure do not double-fire. Once we have decided the connection is dead,
  // additional SDK notifications are noise.
  private unexpectedCloseFired = false;

  constructor(config: McpServerHttpConfig, options: HttpMcpClientOptions = {}) {
    const envLookup = options.envLookup ?? ((name) => process.env[name]);
    const headers = buildMcpHttpHeaders(config, envLookup);

    this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers !== undefined ? { headers } : undefined,
      fetch: options.fetch,
      authProvider: options.oauthProvider,
    });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP HTTP client is closed');
    }
    if (this.started) return;
    this.started = true;
    // Install hooks BEFORE the SDK handshake; see StdioMcpClient.connect.
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP HTTP client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * Register a listener for unsolicited transport drops. See
   * `StdioMcpClient.onUnexpectedClose` for semantics. If the transport
   * already signalled a terminal failure, the buffered reason is replayed
   * synchronously.
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
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
    // Idempotent — see StdioMcpClient.installTransportHooks.
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      // Handshake-phase close surfaces via `client.connect()` throwing.
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    // streamable-http's transport only calls `onclose` on its own `close()`
    // path, so 99% of remote disconnects (SSE flap → reconnect exhaustion,
    // POST send failure on a dead session) arrive as `onerror` instead. Mirror
    // the way the SDK exposes a "the transport is gone" signal there by
    // mapping the known-terminal error messages back to an unexpected close;
    // everything else is treated as transient and only cached for diagnostics.
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
      // During the handshake, terminal errors (Unauthorized, reconnect
      // exhaustion) propagate through `client.connect()` and the manager's
      // `shouldMarkNeedsAuth` / `formatStartupError`. Firing here would
      // double-report.
      if (!this.ready) return;
      if (isTerminalTransportError(error)) {
        this.fireUnexpectedClose({ error });
      }
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

/**
 * Returns true when an error reported via `Client.onerror` indicates the
 * underlying HTTP transport is dead. The streamable-http SDK does not call
 * `onclose` for remote disconnects; instead it surfaces them through
 * `onerror`, but only a few specific messages mean "give up" rather than
 * "we will retry":
 *
 * - `UnauthorizedError` — RFC 9728/8414 auth flow gave up; the SDK won't
 *   retry without a fresh provider call.
 * - "Maximum reconnection attempts ... exceeded." — emitted from
 *   `_scheduleReconnection` after the SSE reconnect budget is gone
 *   (`streamableHttp.js`, `_scheduleReconnection`).
 *
 * Transient signals (per-request fetch failures, single SSE flaps that the
 * SDK is about to reconnect from) MUST NOT match; otherwise a brief network
 * blip would tear down every HTTP MCP entry.
 */
export function isTerminalTransportError(error: Error): boolean {
  if (error.name === 'UnauthorizedError') return true;
  if (/Maximum reconnection attempts/i.test(error.message)) return true;
  return false;
}

export function buildMcpHttpHeaders(
  config: McpServerHttpConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  return buildMcpRemoteHeaders(config, envLookup);
}
