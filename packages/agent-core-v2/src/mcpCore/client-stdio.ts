/**
 * `mcpCore` domain — stdio transport MCP client.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCodes, Error2 } from '#/errors';
import type { IHostProcess } from '#/os/interface/hostProcess';
import type { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { proxyEnvForChild, reconcileChildNoProxy } from '#/_base/utils/proxy';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { McpServerStdioConfig } from './config-schema';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
  readonly runtimeResolver: IRuntimeResolver;
  readonly workspaceId: string;
  readonly runtimeId: string;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: RuntimeStdioTransport;
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

  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    this.transport = new RuntimeStdioTransport(config, options, this.stderrBuffer);
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error2(ErrorCodes.MCP_STARTUP_FAILED, 'MCP stdio client is closed');
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
      throw new Error2(ErrorCodes.MCP_STARTUP_FAILED, 'MCP stdio client was closed during startup');
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

class RuntimeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private process: IHostProcess | undefined;
  private lease: ReturnType<IRuntimeResolver['acquire']> | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly config: McpServerStdioConfig,
    private readonly options: StdioMcpClientOptions,
    private readonly stderr: BoundedTail,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('Runtime stdio transport is already started');
    if (this.closed) throw new Error('Runtime stdio transport is closed');
    this.started = true;
    const lease = this.options.runtimeResolver.acquire(
      { workspaceId: this.options.workspaceId, runtimeId: this.options.runtimeId },
      ['process'],
    );
    this.lease = lease;
    try {
      const base = lease.runtime.path.resolve(this.options.defaultCwd ?? lease.runtime.environment.homeDir);
      const cwd = this.config.cwd === undefined ? base : lease.runtime.path.resolve(base, this.config.cwd);
      const process = lease.track(await lease.runtime.process!.spawn(
        this.config.command,
        this.config.args,
        { cwd, env: mergeStdioEnv(this.config.env) },
      ));
      this.process = process;
      lease.track(this);
      process.stdin.on('error', (error: Error) => this.onerror?.(error));
      process.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
      process.stdout.on('end', () => this.finish());
      process.stdout.on('error', (error: Error) => this.onerror?.(error));
      process.stderr.on('data', (chunk: Buffer | string) => {
        this.stderr.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
      process.stderr.on('error', (error: Error) => this.onerror?.(error));
      void process.wait().then(
        () => this.finish(),
        (error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          this.finish();
        },
      );
    } catch (error) {
      this.lease = undefined;
      lease.dispose();
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process;
    if (process === undefined || this.closed) throw new Error('Runtime stdio transport is not running');
    const data = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      process.stdin.write(data, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  dispose(): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const process = this.process;
    this.process = undefined;
    if (process !== undefined) {
      try {
        await process.kill();
      } catch {}
      void process.dispose();
    }
    this.readBuffer.clear();
    const lease = this.lease;
    this.lease = undefined;
    lease?.dispose();
    this.onclose?.();
  }

  private onData(chunk: Buffer | string): void {
    this.readBuffer.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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
    const lease = this.lease;
    this.lease = undefined;
    lease?.dispose();
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
