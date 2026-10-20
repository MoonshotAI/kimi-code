import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isAbsolute, resolve } from 'pathe';

import type { OsHost, OsProcess } from '#/features/os/host/index';

import {
  buildRequestOptions,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  toMcpToolDefinition,
  toMcpToolResult,
  type MCPClient,
  type MCPToolDefinition,
  type MCPToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { McpServerStdioConfig } from './config-schema';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
  readonly host: OsHost;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: HostStdioTransport;
  private readonly startupTimeoutMs?: number;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new Error(`MCP stdio executor '${config.executor}' is not supported`);
    }
    this.transport = new HostStdioTransport(config, options, this.stderrBuffer);
    this.client = new Client({
      name: options.clientName ?? MCP_CLIENT_NAME,
      version: options.clientVersion ?? MCP_CLIENT_VERSION,
    });
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(
        this.transport,
        buildRequestOptions(this.startupTimeoutMs, undefined),
      );
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

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools(
      undefined,
      buildRequestOptions(this.startupTimeoutMs, undefined),
    );
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

  async ping(signal?: AbortSignal): Promise<void> {
    await this.client.ping(buildRequestOptions(MCP_LIVENESS_PROBE_TIMEOUT_MS, signal));
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
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
    };
  }
}

class HostStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private process: OsProcess | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly config: McpServerStdioConfig,
    private readonly options: StdioMcpClientOptions,
    private readonly stderr: BoundedTail,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('Host stdio transport is already started');
    if (this.closed) throw new Error('Host stdio transport is closed');
    this.started = true;
    const host = this.options.host;
    const base = this.options.defaultCwd ?? host.environment.homeDir;
    const cwd =
      this.config.cwd === undefined || isAbsolute(this.config.cwd)
        ? (this.config.cwd ?? base)
        : resolve(base, this.config.cwd);
    let process: OsProcess;
    try {
      process = await host.process.spawn(this.config.command, this.config.args, {
        cwd,
        env: mergeStdioEnv(this.config.env),
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
    this.process = process;
    void (async () => {
      try {
        for await (const chunk of process.stdout) {
          this.onData(chunk);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
      this.finish();
    })();
    void (async () => {
      try {
        for await (const chunk of process.stderr) {
          this.stderr.push(new TextDecoder().decode(chunk));
        }
      } catch {
      }
    })();
    void process.wait().then(
      () => this.finish(),
      (error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.finish();
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process;
    if (process === undefined || this.closed) throw new Error('Host stdio transport is not running');
    process.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const process = this.process;
    this.process = undefined;
    if (process !== undefined) {
      try {
        await process.kill();
      } catch {
      }
      process.dispose();
    }
    this.readBuffer.clear();
    this.onclose?.();
  }

  private onData(chunk: Uint8Array): void {
    this.readBuffer.append(Buffer.from(chunk));
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.process = undefined;
    this.readBuffer.clear();
    this.onclose?.();
  }
}

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

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

function hasHttpProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
  ].some((value) => httpSchemeValue(value) !== undefined);
}

function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  return {
    httpProxy: httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy,
    httpsProxy: httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy,
  };
}

function resolveNoProxy(env: Env): string {
  const raw = [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.includes('*')) return '*';
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!hosts.includes(loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

function proxyEnvForChild(env: Env): Record<string, string> {
  if (!hasHttpProxy(env)) return {};
  const noProxy = resolveNoProxy(env);
  const result: Record<string, string> = {
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
  if (httpProxy !== undefined) {
    result['HTTP_PROXY'] = httpProxy;
    result['http_proxy'] = httpProxy;
  }
  if (httpsProxy !== undefined) {
    result['HTTPS_PROXY'] = httpsProxy;
    result['https_proxy'] = httpsProxy;
  }
  return result;
}

function reconcileChildNoProxy(
  childEnv: Record<string, string>,
  configEnv?: Record<string, string>,
): void {
  const override = [configEnv?.['no_proxy'], configEnv?.['NO_PROXY']].find(
    (value) => (value?.trim() ?? '').length > 0,
  );
  if (override === undefined) return;
  const noProxy = resolveNoProxy({ no_proxy: override, NO_PROXY: override });
  childEnv['NO_PROXY'] = noProxy;
  childEnv['no_proxy'] = noProxy;
}
