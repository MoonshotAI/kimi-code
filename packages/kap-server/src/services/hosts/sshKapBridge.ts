import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import type { HostEntry } from './hostsConfig';

export type HostStatus = 'pending' | 'connecting' | 'ready' | 'disconnected';

export type HostConnectFailure =
  | 'host_not_found'
  | 'connection_refused'
  | 'host_unreachable'
  | 'connect_timeout'
  | 'authentication_failed'
  | 'host_key_changed'
  | 'port_forwarding_denied'
  | 'executor_not_found'
  | 'executor_outdated'
  | 'remote_busy'
  | 'unknown';

export interface HostEndpoint {
  readonly origin: string;
  readonly port: number;
  readonly token: string;
  readonly version: string;
}

export interface BootstrapResult {
  readonly port: number;
  readonly token: string;
  readonly version: string;
  readonly agentSocket?: string;
}

export interface BridgeLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export class HostConnectError extends Error {
  constructor(
    readonly failure: HostConnectFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HostConnectError';
  }
}

const BOOTSTRAP_MARKER = '__KIMI_ENSURE_DAEMON__';
const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
const BARE_BIN = /^[A-Za-z0-9._+-]+$/;
const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=accept-new',
];
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 20_000;
const TUNNEL_READY_ATTEMPTS = 75;
const TUNNEL_POLL_MS = 200;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RETRYABLE: ReadonlySet<HostConnectFailure> = new Set([
  'connection_refused',
  'host_unreachable',
  'connect_timeout',
  'unknown',
]);

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function remoteBinCommand(remoteBin: string | undefined): string {
  const bin = remoteBin ?? DEFAULT_REMOTE_BIN;
  if (BARE_BIN.test(bin)) return bin;
  return bin.startsWith('~/') ? `"$HOME"/${shQuote(bin.slice(2))}` : shQuote(bin);
}

export function classifySshFailure(stderr: string, exitCode: number | null): HostConnectFailure {
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return 'host_not_found';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'host_key_changed';
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return 'authentication_failed';
  if (/forwarding failed|administratively prohibited/i.test(stderr)) return 'port_forwarding_denied';
  if (/Connection refused/i.test(stderr)) return 'connection_refused';
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'host_unreachable';
  if (/timed out/i.test(stderr)) return 'connect_timeout';
  if (exitCode === 126 || exitCode === 127) return 'executor_not_found';
  if (/unknown command|too many arguments|excess arguments/i.test(stderr)) return 'executor_outdated';
  return 'unknown';
}

export function parseBootstrapOutput(stdout: string): BootstrapResult | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(BOOTSTRAP_MARKER));
  if (line === undefined) return undefined;
  const parsed = JSON.parse(line.slice(BOOTSTRAP_MARKER.length)) as Partial<BootstrapResult> & {
    error?: string;
    message?: string;
  };
  if (parsed.error !== undefined) {
    throw new HostConnectError(
      parsed.error === 'version_mismatch_busy' ? 'remote_busy' : 'unknown',
      parsed.message ?? parsed.error,
    );
  }
  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined;
  return {
    port: parsed.port,
    token: parsed.token,
    version: parsed.version ?? 'unknown',
    agentSocket: parsed.agentSocket,
  };
}

interface SshResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function identityArgs(entry: HostEntry): string[] {
  return entry.identityFile === undefined
    ? []
    : ['-i', entry.identityFile, '-o', 'IdentitiesOnly=yes'];
}

export interface SshKapBridgeOptions {
  readonly sshProgram?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: BridgeLogger;
  readonly onChange?: () => void;
}

export class SshKapBridge {
  private statusValue: HostStatus = 'pending';
  private failureValue: HostConnectFailure | undefined;
  private errorValue: string | undefined;
  private endpointValue: HostEndpoint | undefined;
  private connecting: Promise<HostEndpoint> | undefined;
  private tunnel: ChildProcess | undefined;
  private disposed = false;
  private agentForwardBlocked = false;
  private readonly sshProgram: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly entry: HostEntry,
    private readonly options: SshKapBridgeOptions = {},
  ) {
    this.sshProgram = options.sshProgram ?? 'ssh';
    this.env = options.env ?? process.env;
  }

  get status(): HostStatus {
    return this.statusValue;
  }

  get failure(): HostConnectFailure | undefined {
    return this.failureValue;
  }

  get error(): string | undefined {
    return this.errorValue;
  }

  get endpoint(): HostEndpoint | undefined {
    return this.endpointValue;
  }

  connect(): Promise<HostEndpoint> {
    if (this.statusValue === 'ready' && this.endpointValue !== undefined) {
      return Promise.resolve(this.endpointValue);
    }
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  dispose(): void {
    this.disposed = true;
    this.endpointValue = undefined;
    this.tunnel?.kill();
    this.tunnel = undefined;
  }

  async checkRemoteVersion(): Promise<string> {
    const result = await this.runSsh(
      [`${remoteBinCommand(this.entry.remoteBin)} --version`],
      VERSION_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new HostConnectError(classifySshFailure(result.stderr, result.code), result.stderr.trim());
    }
    return result.stdout.trim().split('\n').pop() ?? '';
  }

  private update(status: HostStatus, failure?: HostConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    this.options.onChange?.();
  }

  private async establish(): Promise<HostEndpoint> {
    this.update('connecting');
    try {
      const bootstrap = await this.bootstrap();
      const endpoint = await this.openTunnel(bootstrap);
      this.endpointValue = endpoint;
      this.update('ready');
      return endpoint;
    } catch (error) {
      const failure = error instanceof HostConnectError ? error.failure : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this.endpointValue = undefined;
      this.update('disconnected', failure, message);
      throw error instanceof HostConnectError ? error : new HostConnectError(failure, message);
    }
  }

  private async bootstrap(): Promise<BootstrapResult> {
    const result = await this.runSsh(
      [`${remoteBinCommand(this.entry.remoteBin)} web ensure-daemon`],
      BOOTSTRAP_TIMEOUT_MS,
    );
    const parsed = parseBootstrapOutput(result.stdout);
    if (parsed !== undefined) return parsed;
    throw new HostConnectError(
      classifySshFailure(result.stderr, result.code),
      result.stderr.trim() || `ssh exited with code ${String(result.code)}`,
    );
  }

  private async allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  private async agentForwardArgs(bootstrap: BootstrapResult): Promise<string[]> {
    const localSocket = this.env['SSH_AUTH_SOCK'];
    if (this.agentForwardBlocked || bootstrap.agentSocket === undefined || !localSocket) return [];
    const resolved = await this.collect(['-G', ...identityArgs(this.entry), this.entry.host], VERSION_TIMEOUT_MS);
    if (!/^forwardagent yes$/im.test(resolved.stdout)) return [];
    return ['-R', `${bootstrap.agentSocket}:${localSocket}`];
  }

  private async openTunnel(bootstrap: BootstrapResult): Promise<HostEndpoint> {
    const localPort = await this.allocatePort();
    const agentArgs = await this.agentForwardArgs(bootstrap);
    const args = [
      '-N',
      '-T',
      ...SSH_OPTIONS,
      '-o',
      'ExitOnForwardFailure=yes',
      ...identityArgs(this.entry),
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${bootstrap.port}`,
      ...agentArgs,
      this.entry.host,
    ];
    const child = spawn(this.sshProgram, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.env });
    let stderr = '';
    let exited = false;
    let exitCode: number | null = null;
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code) => {
      exited = true;
      exitCode = code;
      this.onTunnelClosed(child);
    });
    this.tunnel = child;
    const origin = `http://127.0.0.1:${localPort}`;
    for (let attempt = 0; attempt < TUNNEL_READY_ATTEMPTS && !exited; attempt += 1) {
      if (await this.isHealthy(origin)) {
        return { origin, port: localPort, token: bootstrap.token, version: bootstrap.version };
      }
      await sleep(TUNNEL_POLL_MS);
    }
    child.kill();
    if (exited && agentArgs.length > 0 && /forwarding failed/i.test(stderr)) {
      this.agentForwardBlocked = true;
      this.options.logger?.warn({ host: this.entry.host }, 'ssh agent forwarding rejected; continuing without it');
      return this.openTunnel(bootstrap);
    }
    throw new HostConnectError(
      exited ? classifySshFailure(stderr, exitCode) : 'connect_timeout',
      stderr.trim() || 'ssh tunnel did not become ready',
    );
  }

  private onTunnelClosed(child: ChildProcess): void {
    if (this.tunnel !== child) return;
    this.tunnel = undefined;
    if (this.disposed || this.statusValue !== 'ready') return;
    this.endpointValue = undefined;
    this.update('connecting');
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    for (let delay = 1000; !this.disposed; delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS)) {
      await sleep(delay);
      if (this.disposed) return;
      try {
        await this.connect();
        return;
      } catch (error) {
        if (error instanceof HostConnectError && !RETRYABLE.has(error.failure)) return;
      }
    }
  }

  private async isHealthy(origin: string): Promise<boolean> {
    try {
      const response = await fetch(`${origin}/api/v1/healthz`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private runSsh(remoteCommand: readonly string[], timeoutMs: number): Promise<SshResult> {
    return this.collect(
      ['-T', ...SSH_OPTIONS, ...identityArgs(this.entry), this.entry.host, ...remoteCommand],
      timeoutMs,
    );
  }

  private collect(args: readonly string[], timeoutMs: number): Promise<SshResult> {
    return new Promise((resolve) => {
      const child = spawn(this.sshProgram, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stderr += '\nssh timed out';
        child.kill();
      }, timeoutMs);
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        stderr += error.message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
