import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import type { SshDeviceEntry } from '@moonshot-ai/agent-core-v2';

import {
  DEFAULT_UPGRADE_TIMEOUT_MS,
  DeviceConnectError,
  DeviceUpgradeInProgressError,
  isUpgrading,
  readRemoteMeta,
  upgradeTimeoutError,
  type DeviceBridge,
  type DeviceConnectFailure,
  type DeviceStatus,
  type DeviceUpgradeResult,
  type DeviceUpgradeState,
  type RemoteDeviceIdentity,
} from './deviceBridge';
import { DEVICE_API_LEVEL, DEVICE_PROTOCOL_VERSION } from './deviceProtocol';
import type { DeviceSession } from './deviceSession';
import { readVersionLine, upgradeOutputTail } from './deviceUpgrade';
import { StdioDeviceSession } from './stdioDeviceSession';

interface BootstrapMarker {
  readonly protocol: number | undefined;
  readonly api_level?: number;
  readonly version?: string;
  readonly error?: string;
  readonly message?: string;
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
const UPGRADE_TIMEOUT_MS = 10 * 60_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RETRYABLE: ReadonlySet<DeviceConnectFailure> = new Set([
  'connection_refused',
  'host_unreachable',
  'connect_timeout',
  'remote_busy',
  'remote_start_failed',
  'unknown',
]);
const ENSURE_DAEMON_FAILURES: Readonly<Record<string, DeviceConnectFailure>> = {
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

export function remoteUpgradeCommand(remoteBin: string | undefined): string {
  const bin = remoteBinCommand(remoteBin);
  return `${bin} upgrade --yes && ${bin} --version`;
}

export function classifySshFailure(stderr: string, exitCode: number | null): DeviceConnectFailure {
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return 'host_not_found';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'host_key_changed';
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return 'authentication_failed';
  if (/Connection refused/i.test(stderr)) return 'connection_refused';
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'host_unreachable';
  if (/timed out/i.test(stderr)) return 'connect_timeout';
  if (exitCode === 126 || exitCode === 127) return 'executor_not_found';
  if (/unknown command|unknown option|too many arguments|excess arguments|has been deprecated/i.test(stderr)) return 'outdated';
  return 'unknown';
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

function outdatedError(version: string | undefined): DeviceConnectError {
  return new DeviceConnectError(
    'outdated',
    `kimi ${version ?? '(unknown version)'} on this device is too old for this app; run \`kimi upgrade\` on the device`,
    version,
  );
}

export function checkBootstrapOutput(stdout: string): boolean {
  const marker = readMarker(stdout);
  if (marker === undefined) return false;
  const version = marker.version ?? readVersionLine(stdout);
  if (marker.protocol === undefined || marker.protocol < DEVICE_PROTOCOL_VERSION) throw outdatedError(version);
  if (marker.api_level === undefined || marker.api_level < DEVICE_API_LEVEL) throw outdatedError(version);
  if (marker.error !== undefined) {
    throw new DeviceConnectError(
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

function sshFailure(result: SshResult): DeviceConnectError {
  return new DeviceConnectError(
    classifySshFailure(result.stderr, result.code),
    result.stderr.trim() || `ssh exited with code ${String(result.code)}`,
    readVersionLine(result.stdout),
  );
}

function identityArgs(entry: SshDeviceEntry): string[] {
  return entry.identityFile === undefined
    ? []
    : ['-i', entry.identityFile, '-o', 'IdentitiesOnly=yes'];
}

interface ActiveDeviceSession {
  readonly session: StdioDeviceSession;
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

export interface SshDeviceBridgeOptions {
  readonly sshProgram?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly upgradeTimeoutMs?: number;
  readonly onChange?: () => void;
}

export class SshDeviceBridge implements DeviceBridge {
  private statusValue: DeviceStatus = 'pending';
  private failureValue: DeviceConnectFailure | undefined;
  private errorValue: string | undefined;
  private remoteVersionValue: string | undefined;
  private identityValue: RemoteDeviceIdentity | undefined;
  private upgradeValue: DeviceUpgradeState | undefined;
  private upgradeFrom: string | undefined;
  private upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionValue: ActiveDeviceSession | undefined;
  private connecting: Promise<DeviceSession> | undefined;
  private readonly children = new Set<ChildProcess>();
  private disposed = false;
  private reconnecting = false;
  private reconnectGeneration = 0;
  private readonly sshProgram: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly upgradeTimeoutMs: number;

  constructor(
    private readonly entry: SshDeviceEntry,
    private readonly options: SshDeviceBridgeOptions = {},
  ) {
    this.sshProgram = options.sshProgram ?? 'ssh';
    this.env = options.env ?? process.env;
    this.upgradeTimeoutMs = options.upgradeTimeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS;
  }

  get status(): DeviceStatus {
    return this.statusValue;
  }

  get failure(): DeviceConnectFailure | undefined {
    return this.failureValue;
  }

  get error(): string | undefined {
    return this.errorValue;
  }

  get remoteVersion(): string | undefined {
    return this.remoteVersionValue;
  }

  get session(): DeviceSession | undefined {
    return this.sessionValue?.session;
  }

  get identity(): RemoteDeviceIdentity | undefined {
    return this.identityValue;
  }

  get upgradeState(): DeviceUpgradeState | undefined {
    return this.upgradeValue;
  }

  connect(): Promise<DeviceSession> {
    if (this.disposed) return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
    if (this.sessionValue !== undefined) return Promise.resolve(this.sessionValue.session);
    return this.establishOnce();
  }

  upgrade(): Promise<DeviceUpgradeResult> {
    if (this.disposed) return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
    if (isUpgrading(this.upgradeValue)) return Promise.reject(new DeviceUpgradeInProgressError());
    this.upgradeFrom = this.remoteVersionValue;
    this.setUpgrade({ status: 'installing' });
    clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => {
      if (isUpgrading(this.upgradeValue)) this.setUpgrade({ status: 'failed', error: upgradeTimeoutError(this.upgradeTimeoutMs) });
    }, this.upgradeTimeoutMs);
    this.upgradeTimer.unref?.();
    void this.install();
    return Promise.resolve({ status: 'started' });
  }

  start(): void {
    void this.connect().catch(() => {});
  }

  private establishOnce(): Promise<DeviceSession> {
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  dispose(): void {
    this.disposed = true;
    this.reconnectGeneration += 1;
    clearTimeout(this.upgradeTimer);
    const active = this.sessionValue;
    this.sessionValue = undefined;
    active?.session.close(new Error('device bridge disposed'));
    active?.child.kill();
    for (const child of this.children) child.kill();
  }

  async probe(): Promise<void> {
    const result = await this.collect(
      this.sshArgs(remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon --probe')),
      VERSION_TIMEOUT_MS,
    );
    if (checkBootstrapOutput(result.stdout)) return;
    throw sshFailure(result);
  }

  private sshArgs(remoteCommand: string): string[] {
    return ['-T', ...SSH_OPTIONS, ...identityArgs(this.entry), this.entry.host, remoteCommand];
  }

  private update(status: DeviceStatus, failure?: DeviceConnectFailure, error?: string): void {
    this.statusValue = status;
    this.failureValue = failure;
    this.errorValue = error;
    if (this.upgradeValue !== undefined) this.upgradeValue = this.settledUpgrade(this.upgradeValue);
    this.options.onChange?.();
  }

  private setUpgrade(state: DeviceUpgradeState): void {
    this.upgradeValue = state;
    if (!isUpgrading(state)) clearTimeout(this.upgradeTimer);
    this.options.onChange?.();
  }

  private async install(): Promise<void> {
    const result = await this.collect(this.sshArgs(remoteUpgradeCommand(this.entry.remoteBin)), UPGRADE_TIMEOUT_MS);
    if (this.disposed || this.upgradeValue?.status !== 'installing') return;
    if (result.code !== 0) {
      this.setUpgrade({
        status: 'failed',
        error: upgradeOutputTail(result.stderr) ?? upgradeOutputTail(result.stdout) ?? `kimi upgrade exited with code ${String(result.code)}`,
      });
      return;
    }
    const installed = readVersionLine(result.stdout);
    if (installed !== undefined && installed === this.upgradeFrom) {
      this.setUpgrade({ status: 'failed', error: upgradeOutputTail(result.stdout) ?? `kimi ${installed} is already the newest version` });
      return;
    }
    this.setUpgrade({ status: 'restarting' });
    await this.restart();
  }

  private async restart(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    if (this.disposed) return;
    const active = this.sessionValue;
    this.sessionValue = undefined;
    active?.session.close(new Error('the device server is restarting after an upgrade'));
    active?.child.kill();
    await this.establishOnce().catch(() => undefined);
  }

  private settledUpgrade(upgrade: DeviceUpgradeState): DeviceUpgradeState | undefined {
    if (upgrade.status === 'installing') return upgrade;
    if (this.statusValue === 'ready') {
      if (this.remoteVersionValue !== this.upgradeFrom) return undefined;
      return upgrade.status === 'restarting'
        ? { status: 'failed', error: `the device still runs kimi ${this.remoteVersionValue ?? '(unknown version)'} after the upgrade` }
        : upgrade;
    }
    const gaveUp = this.statusValue === 'disconnected' && this.failureValue !== undefined && !RETRYABLE.has(this.failureValue);
    return upgrade.status === 'restarting' && gaveUp
      ? { status: 'failed', error: this.errorValue ?? 'the device did not reconnect after the upgrade' }
      : upgrade;
  }

  private async establish(): Promise<DeviceSession> {
    if (this.statusValue !== 'ready') this.update('connecting');
    try {
      const active = await this.openSession();
      await this.identify(active);
      if (this.disposed) {
        active.session.close(new Error('device bridge disposed'));
        active.child.kill();
        throw new DeviceConnectError('unknown', 'device bridge disposed');
      }
      this.sessionValue = active;
      this.reconnectGeneration += 1;
      this.reconnecting = false;
      this.update('ready');
      return active.session;
    } catch (error) {
      const failure = error instanceof DeviceConnectError ? error.failure : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this.sessionValue = undefined;
      if (this.disposed) throw error instanceof DeviceConnectError ? error : new DeviceConnectError(failure, message);
      if (error instanceof DeviceConnectError && error.remoteVersion !== undefined) {
        this.remoteVersionValue = error.remoteVersion;
      }
      this.update('disconnected', failure, message);
      if (RETRYABLE.has(failure)) void this.reconnect();
      throw error instanceof DeviceConnectError ? error : new DeviceConnectError(failure, message);
    }
  }

  private async identify(active: ActiveDeviceSession): Promise<void> {
    try {
      const meta = await readRemoteMeta(active.session);
      if (meta.identity === undefined) throw outdatedError(meta.serverVersion);
      this.identityValue = meta.identity;
      this.remoteVersionValue = meta.serverVersion;
    } catch (error) {
      active.session.close();
      active.child.kill();
      if (error instanceof DeviceConnectError) throw error;
      throw new DeviceConnectError(
        'unknown',
        `could not read the device server metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private openSession(): Promise<ActiveDeviceSession> {
    if (this.disposed) return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
    return new Promise<ActiveDeviceSession>((resolve, reject) => {
      const child = spawn(
        this.sshProgram,
        this.sshArgs(remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon')),
        { stdio: ['pipe', 'pipe', 'pipe'], env: this.env },
      );
      this.track(child);
      if (this.disposed) {
        child.kill();
        reject(new DeviceConnectError('unknown', 'device bridge disposed'));
        return;
      }

      let bootstrap = Buffer.alloc(0);
      let preMarkerStdout = '';
      let stderr = '';
      let settled = false;
      let activeSession: ActiveDeviceSession | undefined;
      const timer = setTimeout(() => {
        stderr += '\nssh timed out';
        child.kill();
      }, BOOTSTRAP_TIMEOUT_MS);
      const finishReject = (error: DeviceConnectError): void => {
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
          if (!checkBootstrapOutput(preMarkerStdout)) return;

          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          const stream = createProcessStream(child, bootstrap.subarray(lineEnd + 1));
          const session = new StdioDeviceSession(stream);
          activeSession = { session, child };
          settled = true;
          resolve(activeSession);
        } catch (error) {
          finishReject(error instanceof DeviceConnectError ? error : new DeviceConnectError('unknown', String(error)));
        }
      };
      child.stdout?.on('data', onStdout);
      child.stdout?.on('end', () => {
        if (activeSession !== undefined) return;
        if (bootstrap.length > 0) {
          preMarkerStdout = bootstrap.toString('utf8');
          try {
            checkBootstrapOutput(preMarkerStdout);
          } catch (error) {
            finishReject(error instanceof DeviceConnectError ? error : new DeviceConnectError('unknown', String(error)));
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
          if (error instanceof DeviceConnectError && !RETRYABLE.has(error.failure)) return;
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
