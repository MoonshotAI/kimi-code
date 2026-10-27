import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { proxyEnvForChild, reconcileChildNoProxy } from '#/_base/utils/proxy';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { ErrorCodes, Error2 } from '#/errors';
import { HostProcessError, HostProcessErrorCode, type IHostProcess } from '#/os/interface/hostProcess';
import type { EnvironmentResolver } from '#/app/environment/environment';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  McpClassifiedStartupError,
  toMcpToolDefinition,
  toMcpToolResult,
  type SessionEvidence,
  type SessionEvidenceListener,
} from './client-shared';
import type { McpServerStdioConfig } from './config-schema';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
  readonly environmentResolver: EnvironmentResolver;
  readonly environmentId: string;
  readonly sessionId?: string;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;
const STDIO_TERMINATION_GRACE_MS = 5_000;

export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: EnvironmentStdioTransport;
  private readonly startupTimeoutMs?: number;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  private ready = false;
  private hooksInstalled = false;
  private sessionEvidenceListener: SessionEvidenceListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingSessionEvidence: SessionEvidence | undefined;

  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions) {
    this.transport = new EnvironmentStdioTransport(config, options, this.stderrBuffer);
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
      throw classifyStdioStartupError(error);
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

  onSessionEvidence(listener: SessionEvidenceListener): void {
    this.sessionEvidenceListener = listener;
    const pending = this.pendingSessionEvidence;
    if (pending !== undefined) {
      this.pendingSessionEvidence = undefined;
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
      const evidence: SessionEvidence = {
        kind: 'hard',
        reason: {
          error: this.lastTransportError,
          stderr: stderr.length > 0 ? stderr : undefined,
        },
      };
      const listener = this.sessionEvidenceListener;
      if (listener !== undefined) {
        listener(evidence);
      } else {
        this.pendingSessionEvidence = evidence;
      }
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
    };
  }
}

class EnvironmentStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private process: IHostProcess | undefined;
  private lease: ReturnType<EnvironmentResolver['acquire']> | undefined;
  private tracked: { dispose(): void | Promise<void> } | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly config: McpServerStdioConfig,
    private readonly options: StdioMcpClientOptions,
    private readonly stderr: BoundedTail,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('Environment stdio transport is already started');
    if (this.closed) throw new Error('Environment stdio transport is closed');
    if (this.config.executor !== undefined && this.config.executor !== 'local') {
      throw new Error2(
        ErrorCodes.NOT_IMPLEMENTED,
        `MCP stdio executor '${this.config.executor}' is not supported; use environment_id to select the execution environment`,
      );
    }
    this.started = true;
    const binding = {
      environmentId: this.options.environmentId,
    };
    const required = ['process'] as const;
    const lease = await this.options.environmentResolver.acquireWhenReady(binding, required);
    this.lease = lease;
    try {
      const host = lease.environment.host;
      const path = lease.environment.path;
      if (host === undefined || path === undefined) {
        throw new EnvironmentError('environment.unavailable', `environment ${this.options.environmentId} is not ready`);
      }
      const base = path.resolve(
        this.options.environmentId === LOCAL_ENVIRONMENT_ID
          ? this.options.defaultCwd ?? host.homeDir
          : host.cwd ?? host.homeDir,
      );
      const cwd =
        this.config.cwd === undefined
          ? base
          : path.resolve(base, this.config.cwd);
      const env =
        this.options.environmentId === LOCAL_ENVIRONMENT_ID
          ? mergeStdioEnv(this.config.env)
          : (this.config.env ?? {});
      const process = lease.track(
        await lease.environment.process!.spawn(this.config.command, this.config.args, { cwd, env }),
        this.options.sessionId,
      );
      this.process = process;
      this.tracked = lease.track(this, this.options.sessionId);
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
    if (process === undefined || this.closed)
      throw new Error('Environment stdio transport is not running');
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
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          process.wait().then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            graceTimer = setTimeout(() => {
              resolve(false);
            }, STDIO_TERMINATION_GRACE_MS);
            graceTimer.unref?.();
          }),
        ]);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (!exited && process.exitCode === null) {
          await process.kill('SIGKILL');
          await process.wait();
        }
      } catch {}
      void process.dispose();
    }
    this.readBuffer.clear();
    const tracked = this.tracked;
    this.tracked = undefined;
    void tracked?.dispose();
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
    const process = this.process;
    this.process = undefined;
    void process?.dispose();
    this.readBuffer.clear();
    const tracked = this.tracked;
    this.tracked = undefined;
    void tracked?.dispose();
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

const permanentSpawnErrnos = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR', 'EISDIR']);

function classifyStdioStartupError(error: unknown): unknown {
  if (!(error instanceof HostProcessError) || error.code !== HostProcessErrorCode.SpawnFailed) {
    return error;
  }
  const cause = error.cause as { readonly code?: unknown } | undefined;
  const errno = error.details?.['errno'] ?? cause?.code;
  if (typeof errno === 'string' && permanentSpawnErrnos.has(errno)) {
    return new McpClassifiedStartupError('config', error.message, { cause: error });
  }
  return error;
}
