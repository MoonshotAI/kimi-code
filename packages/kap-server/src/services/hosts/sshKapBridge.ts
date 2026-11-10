import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_RPC_MAX_BODY_BYTES, WS_BACKPRESSURE_TIMEOUT_MS, type RpcFrame } from '../../transport/stdioRpc';
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

export interface HostHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body?: Buffer;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const HOST_HTTP_TIMEOUT_MS = 30_000;

export interface HostHttpResponse {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body: Buffer;
}

export interface HostWsHandlers {
  onMessage(data: string): void;
  onClose(code?: number, reason?: string): void;
  onBackpressure(blocked: boolean): void;
}

export interface HostWsSession {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HostSession {
  readonly version: string;
  request(req: HostHttpRequest): Promise<HostHttpResponse>;
  openWebSocket(path: string, handlers: HostWsHandlers): HostWsSession;
}

export interface BootstrapResult {
  readonly version: string;
  readonly pid?: number;
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

function readMarker(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(BOOTSTRAP_MARKER));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.slice(BOOTSTRAP_MARKER.length)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  return {
    version: version ?? 'unknown',
    pid: typeof marker['pid'] === 'number' ? marker['pid'] : undefined,
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

class ActiveHostSession implements HostSession {
  private nextId = 0;
  private closed = false;
  private readonly pendingHttp = new Map<
    string,
    {
      resolve(res: HostHttpResponse): void;
      reject(err: Error): void;
      timeout: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      onCancel?: () => void;
    }
  >();
  private readonly wsChannels = new Map<string, HostWsHandlers>();
  private readonly pausedWs = new Set<string>();
  private blocked = false;
  private blockedTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly version: string,
    private readonly child: ChildProcess,
  ) {
    child.stdin?.on('drain', () => {
      this.blocked = false;
      if (this.blockedTimer !== undefined) clearTimeout(this.blockedTimer);
      this.blockedTimer = undefined;
      for (const id of this.pausedWs) this.wsChannels.get(id)?.onBackpressure(false);
      this.pausedWs.clear();
    });
  }

  request(req: HostHttpRequest): Promise<HostHttpResponse> {
    if (this.closed) {
      return Promise.reject(new HostConnectError('connection_refused', 'host session is closed'));
    }
    if (req.signal?.aborted === true) return Promise.reject(new Error('host request cancelled'));
    const id = String(++this.nextId);
    const body = req.body !== undefined && req.body.length > 0 ? req.body.toString('base64') : undefined;
    return new Promise<HostHttpResponse>((resolve, reject) => {
      const cancel = (message: string): void => {
        const pending = this.pendingHttp.get(id);
        if (pending === undefined) return;
        this.pendingHttp.delete(id);
        clearTimeout(pending.timeout);
        if (pending.signal !== undefined && pending.onCancel !== undefined) {
          pending.signal.removeEventListener('abort', pending.onCancel);
        }
        this.write({ type: 'http.cancel', id });
        pending.reject(new Error(message));
      };
      const onCancel = req.signal === undefined ? undefined : () => cancel('host request cancelled');
      const timeout = setTimeout(() => cancel('host request timed out'), req.timeoutMs ?? HOST_HTTP_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingHttp.set(id, { resolve, reject, timeout, signal: req.signal, onCancel });
      req.signal?.addEventListener('abort', onCancel!, { once: true });
      this.write({
        type: 'http.req',
        id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body,
      });
    });
  }

  openWebSocket(path: string, handlers: HostWsHandlers): HostWsSession {
    const id = String(++this.nextId);
    if (this.closed) {
      queueMicrotask(() => handlers.onClose(1001, 'host session is closed'));
      return { send() {}, close() {} };
    }
    this.wsChannels.set(id, handlers);
    this.write({ type: 'ws.open', id, path });
    return {
      send: (data) => {
        if (!this.closed && this.wsChannels.has(id)) {
          this.write({ type: 'ws.msg', id, data }, id);
        }
      },
      close: (code, reason) => {
        if (this.wsChannels.delete(id)) {
          this.pausedWs.delete(id);
          this.write({ type: 'ws.close', id, code, reason });
        }
      },
    };
  }

  onFrame(frame: RpcFrame): void {
    if (frame.type === 'http.res') {
      const pending = this.pendingHttp.get(frame.id);
      if (pending === undefined) return;
      this.pendingHttp.delete(frame.id);
      clearTimeout(pending.timeout);
      if (pending.signal !== undefined && pending.onCancel !== undefined) {
        pending.signal.removeEventListener('abort', pending.onCancel);
      }
      pending.resolve({
        status: frame.status,
        headers: frame.headers,
        body: frame.body === undefined ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64'),
      });
      return;
    }
    if (frame.type === 'ws.msg') {
      this.wsChannels.get(frame.id)?.onMessage(frame.data);
      return;
    }
    if (frame.type === 'ws.close') {
      const handlers = this.wsChannels.get(frame.id);
      this.wsChannels.delete(frame.id);
      this.pausedWs.delete(frame.id);
      handlers?.onClose(frame.code, frame.reason);
    }
  }

  failAll(): boolean {
    this.closed = true;
    if (this.blockedTimer !== undefined) clearTimeout(this.blockedTimer);
    this.blockedTimer = undefined;
    const hadActive = this.pendingHttp.size > 0 || this.wsChannels.size > 0;
    const error = new HostConnectError('connection_refused', 'host connection closed');
    for (const pending of this.pendingHttp.values()) {
      clearTimeout(pending.timeout);
      if (pending.signal !== undefined && pending.onCancel !== undefined) {
        pending.signal.removeEventListener('abort', pending.onCancel);
      }
      pending.reject(error);
    }
    this.pendingHttp.clear();
    for (const handlers of this.wsChannels.values()) handlers.onClose(1001, 'host connection closed');
    this.wsChannels.clear();
    this.pausedWs.clear();
    return hadActive;
  }

  kill(): void {
    this.failAll();
    this.child.kill();
  }

  private write(frame: RpcFrame, wsId?: string): void {
    const stdin = this.child.stdin;
    if (this.closed || stdin === null || stdin.destroyed) return;
    const blocked = !stdin.write(`${JSON.stringify(frame)}\n`);
    if (stdin.writableLength > HOST_RPC_MAX_BODY_BYTES) {
      this.child.kill();
      return;
    }
    if (!blocked) return;
    if (!this.blocked) {
      this.blocked = true;
      this.blockedTimer = setTimeout(() => {
        if (this.blocked) this.child.kill();
      }, WS_BACKPRESSURE_TIMEOUT_MS);
      this.blockedTimer.unref?.();
    }
    if (wsId !== undefined && !this.pausedWs.has(wsId)) {
      this.pausedWs.add(wsId);
      this.wsChannels.get(wsId)?.onBackpressure(true);
    }
  }
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
    return this.sessionValue;
  }

  connect(): Promise<HostSession> {
    if (this.sessionValue !== undefined) {
      return Promise.resolve(this.sessionValue);
    }
    this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  dispose(): void {
    this.disposed = true;
    this.reconnectGeneration += 1;
    this.sessionValue?.kill();
    this.sessionValue = undefined;
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
      const session = await this.openSession();
      if (this.disposed) {
        session.kill();
        throw new HostConnectError('unknown', 'host bridge disposed');
      }
      this.remoteVersionValue = session.version;
      this.sessionValue = session;
      this.update('ready');
      return session;
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
    if (this.disposed) {
      return Promise.reject(new HostConnectError('unknown', 'host bridge disposed'));
    }
    return new Promise<ActiveHostSession>((resolve, reject) => {
      const args = [
        '-T',
        ...SSH_OPTIONS,
        ...identityArgs(this.entry),
        this.entry.host,
        remoteKimiCommand(this.entry.remoteBin, 'server ensure-daemon'),
      ];
      const child = spawn(this.sshProgram, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
      this.track(child);
      if (this.disposed) {
        child.kill();
        reject(new HostConnectError('unknown', 'host bridge disposed'));
        return;
      }

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

      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (activeSession !== undefined) {
          const trimmed = line.trim();
          if (trimmed.length === 0) return;
          try {
            activeSession.onFrame(JSON.parse(trimmed) as RpcFrame);
          } catch {
          }
          return;
        }
        preMarkerStdout += `${line}\n`;
        if (!line.startsWith(BOOTSTRAP_MARKER)) return;
        try {
          const parsed = parseBootstrapOutput(preMarkerStdout);
          if (parsed === undefined) return;
          settled = true;
          clearTimeout(timer);
          activeSession = new ActiveHostSession(parsed.version, child);
          resolve(activeSession);
        } catch (error) {
          finishReject(
            error instanceof HostConnectError
              ? error
              : new HostConnectError('unknown', error instanceof Error ? error.message : String(error)),
          );
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
        lines.close();
        if (!settled) {
          settled = true;
          reject(sshFailure({ code, stdout: preMarkerStdout, stderr }));
          return;
        }
        if (activeSession !== undefined) {
          this.onSessionClosed(activeSession, code);
        }
      });
    });
  }

  private onSessionClosed(session: ActiveHostSession, code: number | null): void {
    const hadActive = session.failAll();
    if (this.sessionValue !== session) return;
    this.sessionValue = undefined;
    if (this.disposed || this.statusValue !== 'ready') return;
    if (code === 0 && !hadActive) return;
    this.update('connecting');
    void this.reconnect();
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
        if (this.disposed || generation !== this.reconnectGeneration) return;
        try {
          await this.connect();
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
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
