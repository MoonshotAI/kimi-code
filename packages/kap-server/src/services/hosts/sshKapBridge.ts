import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import type { HostEntry } from '@moonshot-ai/agent-core-v2';

import { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from './hostProtocol';
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
  | 'executor_not_found'
  | 'executor_outdated'
  | 'remote_busy'
  | 'remote_start_failed'
  | 'unknown';

interface BootstrapMarker {
  readonly protocol: number | undefined;
  readonly api_level?: number;
  readonly version?: string;
  readonly windows_ipc?: boolean;
  readonly error?: string;
  readonly message?: string;
}

type SshPlatform = 'posix' | 'windows';

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

function powerShellCommand(script: string): string {
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

export function remoteBinCommand(remoteBin: string | undefined): string {
  const bin = remoteBin ?? DEFAULT_REMOTE_BIN;
  if (BARE_BIN.test(bin)) return bin;
  return bin.startsWith('~/') ? `"$HOME"/${shQuote(bin.slice(2))}` : shQuote(bin);
}

export function remoteKimiCommand(remoteBin: string | undefined, subcommand: string, platform: SshPlatform = 'posix'): string {
  if (platform === 'windows') {
    const configured = remoteBin ?? '~/.kimi-code/bin/kimi.exe';
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const bin = BARE_BIN.test(configured)
      ? literal(configured)
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? `($env:USERPROFILE + ${literal(configured.slice(1))})`
        : literal(configured);
    return powerShellCommand(`$ErrorActionPreference = 'Stop'; & ${bin} --version; & ${bin} ${subcommand}; exit $LASTEXITCODE`);
  }
  const bin = remoteBinCommand(remoteBin);
  return `${bin} --version; ${bin} ${subcommand}`;
}

export function classifySshFailure(stderr: string, exitCode: number | null): HostConnectFailure {
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return 'host_not_found';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'host_key_changed';
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return 'authentication_failed';
  if (/Connection refused/i.test(stderr)) return 'connection_refused';
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'host_unreachable';
  if (/timed out/i.test(stderr)) return 'connect_timeout';
  if (exitCode === 126 || exitCode === 127 || /not recognized as an internal or external command|is not recognized as the name of a cmdlet/i.test(stderr)) return 'executor_not_found';
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

export function checkBootstrapOutput(stdout: string, platform: SshPlatform = 'posix'): boolean {
  const marker = readMarker(stdout);
  if (marker === undefined) return false;
  const version = marker.version ?? readVersionLine(stdout);
  if (marker.protocol === undefined || marker.protocol < HOST_PROTOCOL_VERSION) throw outdatedError(version);
  if (marker.api_level === undefined || marker.api_level < HOST_API_LEVEL) throw outdatedError(version);
  if (platform === 'windows' && marker.windows_ipc !== true) throw outdatedError(version);
  if (marker.error !== undefined) {
    throw new HostConnectError(
      ENSURE_DAEMON_FAILURES[marker.error] ?? 'unknown',
      marker.message ?? marker.error,
      version,
    );
  }
  return true;
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
  private platformValue: Promise<SshPlatform> | undefined;

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
    return this.establishOnce();
  }

  resumeIfIdle(): Promise<HostSession> | undefined {
    if (this.disposed || this.statusValue !== 'ready' || this.sessionValue !== undefined) return undefined;
    return this.establishOnce();
  }

  start(): void {
    void this.connect().catch(() => {});
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

  async probe(): Promise<void> {
    const platform = await this.platform();
    const result = await this.collect(
      this.commandArgs(remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon --probe', platform)),
      VERSION_TIMEOUT_MS,
    );
    if (checkBootstrapOutput(result.stdout, platform)) return;
    throw sshFailure(result);
  }

  private platform(): Promise<SshPlatform> {
    this.platformValue ??= this.detectPlatform();
    return this.platformValue;
  }

  private commandArgs(command: string): string[] {
    return ['-T', ...SSH_OPTIONS, ...identityArgs(this.entry), this.entry.host, command];
  }

  private async detectPlatform(): Promise<SshPlatform> {
    const probes = ['uname -s', powerShellCommand("[Console]::WriteLine('KIMI_WINDOWS')")];
    for (const [index, command] of probes.entries()) {
      const result = await this.collect(this.commandArgs(command), VERSION_TIMEOUT_MS);
      if (result.code === 255) throw sshFailure(result);
      const output = result.stdout.trim().split(/\r?\n/).at(-1);
      if (result.code === 0 && output !== undefined && output.length > 0) {
        if (index === 0) return /^(?:MINGW|MSYS|CYGWIN)/i.test(output) ? 'windows' : 'posix';
        if (output === 'KIMI_WINDOWS') return 'windows';
      }
    }
    throw new HostConnectError('unknown', 'Could not detect the SSH target platform');
  }

  private update(status: HostStatus, failure?: HostConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    this.options.onChange?.();
  }

  private async establish(): Promise<HostSession> {
    if (this.statusValue !== 'ready') this.update('connecting', this.failureValue, this.errorValue);
    try {
      const active = await this.openSession();
      if (this.disposed) {
        active.session.close(new Error('host bridge disposed'));
        active.child.kill();
        throw new HostConnectError('unknown', 'host bridge disposed');
      }
      this.sessionValue = active;
      this.reconnectGeneration += 1;
      this.reconnecting = false;
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
      if (RETRYABLE.has(failure)) void this.reconnect();
      throw error instanceof HostConnectError ? error : new HostConnectError(failure, message);
    }
  }

  private async openSession(): Promise<ActiveHostSession> {
    if (this.disposed) throw new HostConnectError('unknown', 'host bridge disposed');
    const platform = await this.platform();
    const command = remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon', platform);
    return new Promise<ActiveHostSession>((resolve, reject) => {
      const child = spawn(
        this.sshProgram,
        this.commandArgs(command),
        { stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true },
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
          if (!checkBootstrapOutput(preMarkerStdout, platform)) return;

          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          const stream = createProcessStream(child, bootstrap.subarray(lineEnd + 1));
          const session = new StdioHostSession(stream);
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
            checkBootstrapOutput(preMarkerStdout, platform);
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
          this.update('connecting', this.failureValue, this.errorValue);
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
      const child = spawn(this.sshProgram, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env, windowsHide: true });
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
