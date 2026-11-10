import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_PROTOCOL_VERSION } from './hostProtocol';
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
  | 'remote_start_failed'
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

export interface RemoteProbe {
  readonly version: string;
  readonly protocol: number;
}

export interface BridgeLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export class HostConnectError extends Error {
  constructor(
    readonly failure: HostConnectFailure,
    message: string,
    readonly remoteVersion?: string,
  ) {
    super(message);
    this.name = 'HostConnectError';
  }
}

const BOOTSTRAP_MARKER = '__KIMI_ENSURE_DAEMON__';
const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
const BARE_BIN = /^[A-Za-z0-9._+-]+$/;
const VERSION_LINE = /^v?\d+\.\d+\.\d+\S*$/;
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
  'remote_busy',
  'remote_start_failed',
  'unknown',
]);
const ENSURE_DAEMON_FAILURES: Readonly<Record<string, HostConnectFailure>> = {
  version_mismatch_busy: 'remote_busy',
  lock_timeout: 'remote_start_failed',
  start_timeout: 'remote_start_failed',
  token_unavailable: 'remote_start_failed',
};

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function remoteBinCommand(remoteBin: string | undefined): string {
  const bin = remoteBin ?? DEFAULT_REMOTE_BIN;
  if (BARE_BIN.test(bin)) return bin;
  return bin.startsWith('~/') ? `"$HOME"/${shQuote(bin.slice(2))}` : shQuote(bin);
}

export function remoteKimiCommand(remoteBin: string | undefined, subcommand: string): string {
  const bin = remoteBinCommand(remoteBin);
  return `${bin} --version; ${bin} ${subcommand}`;
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
  if (/unknown command|unknown option|too many arguments|excess arguments/i.test(stderr)) return 'executor_outdated';
  return 'unknown';
}

function readVersionLine(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => VERSION_LINE.test(line));
}

function readMarker(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(BOOTSTRAP_MARKER));
  return line === undefined ? undefined : (JSON.parse(line.slice(BOOTSTRAP_MARKER.length)) as Record<string, unknown>);
}

function outdatedError(version: string | undefined): HostConnectError {
  return new HostConnectError(
    'executor_outdated',
    `kimi ${version ?? '(unknown version)'} on this host does not support host protocol ${String(HOST_PROTOCOL_VERSION)}; run \`kimi upgrade\` on the host`,
    version,
  );
}

function checkedMarker(stdout: string): { readonly marker: Record<string, unknown>; readonly version?: string } | undefined {
  const marker = readMarker(stdout);
  if (marker === undefined) return undefined;
  const version = typeof marker['version'] === 'string' ? marker['version'] : readVersionLine(stdout);
  const protocol = marker['protocol'];
  if (typeof protocol !== 'number' || protocol < HOST_PROTOCOL_VERSION) throw outdatedError(version);
  const error = marker['error'];
  if (typeof error === 'string') {
    const message = typeof marker['message'] === 'string' ? marker['message'] : error;
    throw new HostConnectError(ENSURE_DAEMON_FAILURES[error] ?? 'unknown', message, version);
  }
  return { marker, version };
}

export function parseBootstrapOutput(stdout: string): BootstrapResult | undefined {
  const checked = checkedMarker(stdout);
  if (checked === undefined) return undefined;
  const { marker, version } = checked;
  if (typeof marker['port'] !== 'number' || typeof marker['token'] !== 'string') return undefined;
  return {
    port: marker['port'],
    token: marker['token'],
    version: version ?? 'unknown',
    agentSocket: typeof marker['agentSocket'] === 'string' ? marker['agentSocket'] : undefined,
  };
}

export function parseProbeOutput(stdout: string): RemoteProbe | undefined {
  const checked = checkedMarker(stdout);
  if (checked === undefined) return undefined;
  return { version: checked.version ?? 'unknown', protocol: checked.marker['protocol'] as number };
}

interface SshResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function sshFailure(result: SshResult): HostConnectError {
  return new HostConnectError(
    classifySshFailure(result.stderr, result.code),
    result.stderr.trim() || `ssh exited with code ${String(result.code)}`,
    readVersionLine(result.stdout),
  );
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
  private remoteVersionValue: string | undefined;
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

  get remoteVersion(): string | undefined {
    return this.remoteVersionValue;
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

  async probe(): Promise<RemoteProbe> {
    const result = await this.runSsh(
      [remoteKimiCommand(this.entry.remoteBin, 'web ensure-daemon --probe')],
      VERSION_TIMEOUT_MS,
    );
    const parsed = parseProbeOutput(result.stdout);
    if (parsed !== undefined) return parsed;
    throw sshFailure(result);
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
      this.remoteVersionValue = bootstrap.version;
      const endpoint = await this.openTunnel(bootstrap);
      this.endpointValue = endpoint;
      this.update('ready');
      return endpoint;
    } catch (error) {
      const failure = error instanceof HostConnectError ? error.failure : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this.endpointValue = undefined;
      if (error instanceof HostConnectError && error.remoteVersion !== undefined) {
        this.remoteVersionValue = error.remoteVersion;
      }
      this.update('disconnected', failure, message);
      throw error instanceof HostConnectError ? error : new HostConnectError(failure, message);
    }
  }

  private async bootstrap(): Promise<BootstrapResult> {
    const result = await this.runSsh(
      [remoteKimiCommand(this.entry.remoteBin, 'web ensure-daemon')],
      BOOTSTRAP_TIMEOUT_MS,
    );
    const parsed = parseBootstrapOutput(result.stdout);
    if (parsed !== undefined) return parsed;
    throw sshFailure(result);
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
