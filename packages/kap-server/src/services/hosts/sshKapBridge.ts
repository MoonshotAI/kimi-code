import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from './hostProtocol';
import type { HostEntry } from './hostsConfig';
import type { HostSession } from './hostSession';
import { StdioHostSession } from './stdioHostSession';

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

export interface BootstrapResult {
  readonly version: string;
  readonly pid?: number;
}

interface BootstrapMarker {
  readonly protocol: number | undefined;
  readonly api_level?: number;
  readonly version?: string;
  readonly pid?: number;
  readonly error?: string;
  readonly message?: string;
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
  if (/unknown command|unknown option|too many arguments|excess arguments|has been deprecated/i.test(stderr)) return 'executor_outdated';
  return 'unknown';
}

function readVersionLine(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => VERSION_LINE.test(line));
}

function readMarker(stdout: string): BootstrapMarker | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(BOOTSTRAP_MARKER));
  if (line === undefined) return undefined;
  try {
    const marker: unknown = JSON.parse(line.slice(BOOTSTRAP_MARKER.length));
    if (typeof marker === 'object' && marker !== null) return marker as BootstrapMarker;
  } catch {
  }
  return undefined;
}

function outdatedError(version: string | undefined): HostConnectError {
  return new HostConnectError(
    'executor_outdated',
    `kimi ${version ?? '(unknown version)'} on this host is too old for this app; run \`kimi upgrade\` on the host`,
    version,
  );
}

function checkedMarker(stdout: string): { readonly marker: BootstrapMarker & { readonly protocol: number }; readonly version?: string } | undefined {
  const marker = readMarker(stdout);
  if (marker === undefined) return undefined;
  const version = marker.version ?? readVersionLine(stdout);
  if (marker.protocol === undefined || marker.protocol < HOST_PROTOCOL_VERSION) throw outdatedError(version);
  if (marker.api_level === undefined || marker.api_level < HOST_API_LEVEL) throw outdatedError(version);
  if (marker.error !== undefined) {
    throw new HostConnectError(
      ENSURE_DAEMON_FAILURES[marker.error] ?? 'unknown',
      marker.message ?? marker.error,
      version,
    );
  }
  return { marker: { ...marker, protocol: marker.protocol }, version };
}

export function parseBootstrapOutput(stdout: string): BootstrapResult | undefined {
  const checked = checkedMarker(stdout);
  if (checked === undefined) return undefined;
  const { marker, version } = checked;
  return {
    version: version ?? 'unknown',
    pid: typeof marker.pid === 'number' ? marker.pid : undefined,
  };
}

export function parseProbeOutput(stdout: string): RemoteProbe | undefined {
  const checked = checkedMarker(stdout);
  if (checked === undefined) return undefined;
  return { version: checked.version ?? 'unknown', protocol: checked.marker.protocol };
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

interface ActiveHostSession {
  readonly session: StdioHostSession;
  readonly child: ChildProcess;
}

function createProcessStream(child: ChildProcess, initial: Buffer): Duplex {
  const source = child.stdout;
  const sink = child.stdin;
  if (source === null || sink === null) {
    return new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback(new Error('SSH stdio is unavailable'));
      },
    });
  }
  source.pause();
  const stream = new Duplex({
    read() {
      source.resume();
    },
    write(chunk, encoding, callback) {
      if (sink.destroyed) {
        callback(new Error('SSH stdin is closed'));
        return;
      }
      sink.write(chunk, encoding, callback);
    },
  });
  source.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) source.pause();
  });
  if (source.readableEnded) {
    stream.push(null);
  } else {
    source.once('end', () => {
      stream.push(null);
    });
  }
  source.once('error', (error) => {
    stream.destroy(error);
  });
  sink.once('error', (error) => {
    stream.destroy(error);
  });
  stream.once('error', () => {
    child.kill();
  });
  stream.once('close', () => {
    source.destroy();
    sink.destroy();
  });
  if (initial.length > 0) stream.push(initial);
  return stream;
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
  private sessionValue: ActiveHostSession | undefined;
  private connecting: Promise<HostSession> | undefined;
  private readonly children = new Set<ChildProcess>();
  private disposed = false;
  private reconnecting = false;
  private reconnectGeneration = 0;
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

  get session(): HostSession | undefined {
    return this.sessionValue?.session;
  }

  connect(): Promise<HostSession> {
    if (this.disposed) return Promise.reject(new HostConnectError('unknown', 'host bridge disposed'));
    if (this.sessionValue !== undefined) return Promise.resolve(this.sessionValue.session);
    this.reconnectGeneration += 1;
    this.reconnecting = false;
    return this.establishOnce();
  }

  start(): void {
    void this.connect().catch((error: unknown) => {
      if (error instanceof HostConnectError && !RETRYABLE.has(error.failure)) return;
      void this.reconnect();
    });
  }

  private establishOnce(): Promise<HostSession> {
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  dispose(): void {
    this.disposed = true;
    this.reconnectGeneration += 1;
    const active = this.sessionValue;
    this.sessionValue = undefined;
    active?.session.close(new Error('host bridge disposed'));
    active?.child.kill();
    for (const child of this.children) child.kill();
  }

  async probe(): Promise<RemoteProbe> {
    const result = await this.collect(
      [
        '-T',
        ...SSH_OPTIONS,
        ...identityArgs(this.entry),
        this.entry.host,
        remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon --probe'),
      ],
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

  private async establish(): Promise<HostSession> {
    if (this.statusValue !== 'ready') this.update('connecting');
    try {
      const active = await this.openSession();
      if (this.disposed) {
        active.session.close(new Error('host bridge disposed'));
        active.child.kill();
        throw new HostConnectError('unknown', 'host bridge disposed');
      }
      this.remoteVersionValue = active.session.version;
      this.sessionValue = active;
      this.update('ready');
      return active.session;
    } catch (error) {
      const failure = error instanceof HostConnectError ? error.failure : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this.sessionValue = undefined;
      if (this.disposed) throw error instanceof HostConnectError ? error : new HostConnectError(failure, message);
      if (error instanceof HostConnectError && error.remoteVersion !== undefined) {
        this.remoteVersionValue = error.remoteVersion;
      }
      this.update('disconnected', failure, message);
      throw error instanceof HostConnectError ? error : new HostConnectError(failure, message);
    }
  }

  private openSession(): Promise<ActiveHostSession> {
    if (this.disposed) return Promise.reject(new HostConnectError('unknown', 'host bridge disposed'));
    return new Promise<ActiveHostSession>((resolve, reject) => {
      const child = spawn(
        this.sshProgram,
        [
          '-T',
          ...SSH_OPTIONS,
          ...identityArgs(this.entry),
          this.entry.host,
          remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon'),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: this.env },
      );
      this.track(child);
      if (this.disposed) {
        child.kill();
        reject(new HostConnectError('unknown', 'host bridge disposed'));
        return;
      }

      let bootstrap = Buffer.alloc(0);
      let preMarkerStdout = '';
      let stderr = '';
      let settled = false;
      let activeSession: ActiveHostSession | undefined;
      const timer = setTimeout(() => {
        stderr += '\nssh timed out';
        child.kill();
      }, BOOTSTRAP_TIMEOUT_MS);
      const finishReject = (error: HostConnectError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };

      const onStdout = (chunk: Buffer): void => {
        bootstrap = Buffer.concat([bootstrap, chunk]);
        const markerIndex = bootstrap.indexOf(`\n${BOOTSTRAP_MARKER}`);
        const markerStart = bootstrap.toString('utf8', 0, BOOTSTRAP_MARKER.length) === BOOTSTRAP_MARKER
          ? 0
          : markerIndex < 0 ? -1 : markerIndex + 1;
        if (markerStart < 0) return;
        const lineEnd = bootstrap.indexOf('\n', markerStart);
        if (lineEnd < 0) return;
        let marker: unknown;
        try {
          marker = JSON.parse(bootstrap.toString('utf8', markerStart + BOOTSTRAP_MARKER.length, lineEnd));
        } catch {
          return;
        }
        if (typeof marker !== 'object' || marker === null) return;
        preMarkerStdout = bootstrap.toString('utf8', 0, lineEnd + 1);
        try {
          const parsed = parseBootstrapOutput(preMarkerStdout);
          if (parsed === undefined) return;

          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          const stream = createProcessStream(child, bootstrap.subarray(lineEnd + 1));
          const session = new StdioHostSession(parsed.version, stream);
          activeSession = { session, child };
          settled = true;
          resolve(activeSession);
        } catch (error) {
          finishReject(error instanceof HostConnectError ? error : new HostConnectError('unknown', String(error)));
        }
      };
      child.stdout?.on('data', onStdout);
      child.stdout?.on('end', () => {
        if (activeSession !== undefined) return;
        if (bootstrap.length > 0) {
          preMarkerStdout = bootstrap.toString('utf8');
          try {
            parseBootstrapOutput(preMarkerStdout);
          } catch (error) {
            finishReject(error instanceof HostConnectError ? error : new HostConnectError('unknown', String(error)));
          }
        }
      });

      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        stderr += error.message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          preMarkerStdout ||= bootstrap.toString('utf8');
          reject(sshFailure({ code, stdout: preMarkerStdout, stderr }));
          return;
        }
        if (activeSession !== undefined) {
          activeSession.session.close();
          if (this.sessionValue !== activeSession) return;
          this.sessionValue = undefined;
          if (this.disposed || this.statusValue !== 'ready' || code === 0) return;
          this.update('connecting');
          void this.reconnect();
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;
    const generation = this.reconnectGeneration;
    try {
      for (
        let delay = 1000;
        !this.disposed && generation === this.reconnectGeneration;
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS)
      ) {
        await sleep(delay);
        if (this.disposed || generation !== this.reconnectGeneration || this.sessionValue !== undefined) return;
        try {
          await this.establishOnce();
          return;
        } catch (error) {
          if (error instanceof HostConnectError && !RETRYABLE.has(error.failure)) return;
        }
      }
    } finally {
      if (generation === this.reconnectGeneration) this.reconnecting = false;
    }
  }

  private track(child: ChildProcess): void {
    if (this.disposed) {
      child.kill();
      return;
    }
    this.children.add(child);
    child.on('close', () => {
      this.children.delete(child);
    });
  }

  private collect(args: readonly string[], timeoutMs: number): Promise<SshResult> {
    return new Promise((resolve) => {
      const child = spawn(this.sshProgram, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
      this.track(child);
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
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
