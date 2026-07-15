import type { McpServerHttpConfig } from './config-schema';
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
  readonly envLookup?: (name: string) => string | undefined;
  readonly fetch?: typeof fetch;
  readonly oauthProvider?: OAuthClientProvider;
}

export class HttpMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private started = false;
  private closed = false;
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
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
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
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
