import { encodeFrame, LineFrameDecoder } from '#/remote/protocol/codec';
import { RpcError } from '#/remote/protocol/errors';
import {
  classifyMessage,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolViolationError,
  type RequestId,
} from '#/remote/protocol/messages';
import {
  compareVersions,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  MAX_IN_FLIGHT_CALLS,
  MIN_EXECUTOR_VERSION,
  SERVER_NOTIFICATION_METHODS,
  type InitializeResult,
  type RemoteEnvironmentInfo,
} from '#/remote/protocol/methods';
import type { BytePipe } from './execBridge';

export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_CALL_TIMEOUT_MS = 60_000;

export interface ConnectOptions {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly requestCallTimeoutMs?: number;
}

export interface ConnectionCloseInfo {
  readonly reason: string;
}

export class ConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

export type HandshakeErrorKind = 'timeout' | 'executor-exit' | 'incompatible';

export interface HandshakeErrorDetails {
  readonly kind?: HandshakeErrorKind;
  readonly exitCode?: number | null;
  readonly executorVersion?: string;
  readonly minExecutorVersion?: string;
  readonly cause?: unknown;
}

export class HandshakeError extends Error {
  readonly kind?: HandshakeErrorKind;
  readonly exitCode?: number | null;
  readonly executorVersion?: string;
  readonly minExecutorVersion?: string;

  constructor(message: string, details: HandshakeErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'HandshakeError';
    this.kind = details.kind;
    this.exitCode = details.exitCode;
    this.executorVersion = details.executorVersion;
    this.minExecutorVersion = details.minExecutorVersion;
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`request ${method} timed out after ${String(timeoutMs)}ms`);
    this.name = 'RequestTimeoutError';
  }
}

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export class RemoteExecConnection {
  private readonly decoder = new LineFrameDecoder();
  private readonly pending = new Map<RequestId, PendingCall>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<(info: ConnectionCloseInfo) => void>();
  private readonly callQueue: Array<() => void> = [];
  private nextId = 1;
  private inFlight = 0;
  private state: 'handshake' | 'ready' | 'closed' = 'handshake';
  private handshakeComplete = false;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private requestCallTimeoutMs = DEFAULT_REQUEST_CALL_TIMEOUT_MS;
  private closeInfo: ConnectionCloseInfo | undefined;

  private constructor(private readonly pipe: BytePipe) {}

  static async connect(pipe: BytePipe, options: ConnectOptions): Promise<RemoteExecConnection> {
    const connection = new RemoteExecConnection(pipe);
    return connection.handshake(options);
  }

  get environment(): RemoteEnvironmentInfo {
    return this.environmentValue;
  }

  get executorVersion(): string {
    return this.executorVersionValue;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  get closeReason(): ConnectionCloseInfo | undefined {
    return this.closeInfo;
  }

  private environmentValue!: RemoteEnvironmentInfo;
  private executorVersionValue!: string;

  private handshake(options: ConnectOptions): Promise<RemoteExecConnection> {
    return new Promise<RemoteExecConnection>((resolve, reject) => {
      const timeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
      this.requestCallTimeoutMs = options.requestCallTimeoutMs ?? DEFAULT_REQUEST_CALL_TIMEOUT_MS;
      this.handshakeTimer = setTimeout(() => {
        this.fail(new HandshakeError(`initialize timed out after ${timeoutMs}ms`, { kind: 'timeout' }));
      }, timeoutMs);
      this.handshakeTimer.unref?.();

      this.pipe.onData((chunk) => {
        this.onData(chunk);
      });
      this.pipe.onEnd(() => {
        this.onPipeEnd();
      });
      this.pipe.onError((error) => {
        this.fail(new ConnectionClosedError(`pipe error: ${error.message}`));
      });

      this.onHandshakeResponse = (error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        const gate = this.gateEnvironment(options.minExecutorVersion ?? MIN_EXECUTOR_VERSION);
        if (gate !== undefined) {
          this.teardown();
          reject(gate);
          return;
        }
        this.state = 'ready';
        this.pipe.write(encodeFrame({ method: INITIALIZED_METHOD }));
        resolve(this);
      };

      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (result) => {
          this.onInitializeResult(result as InitializeResult);
        },
        reject: (error: Error) => {

          this.onHandshakeResponse(error);
          this.teardown();
        },
      });
      this.pipe.write(
        encodeFrame({
          id,
          method: INITIALIZE_METHOD,
          params: { clientName: options.clientName, clientVersion: options.clientVersion },
        }),
      );
    });
  }

  private onHandshakeResponse: (error?: Error) => void = () => {};

  private onInitializeResult(result: InitializeResult): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    const parsed = this.validateInitializeResult(result);
    if (parsed instanceof Error) {
      this.onHandshakeResponse(parsed);
      this.teardown();
      return;
    }
    this.executorVersionValue = parsed.executorVersion;
    this.environmentValue = parsed.environment;
    this.handshakeComplete = true;
    this.onHandshakeResponse(undefined);
  }

  private validateInitializeResult(result: InitializeResult): InitializeResult | Error {
    if (result === null || typeof result !== 'object') {
      return new HandshakeError('initialize response must be an object');
    }
    if (typeof result.executorVersion !== 'string' || result.executorVersion.length === 0) {
      return new HandshakeError('initialize response must carry executorVersion');
    }
    const environment = result.environment;
    if (environment === null || typeof environment !== 'object') {
      return new HandshakeError('initialize response must carry an environment object');
    }
    for (const field of [
      'osKind',
      'osArch',
      'osVersion',
      'shellName',
      'shellPath',
      'pathClass',
      'homeDir',
      'cwd',
      'tempDir',
    ] as const) {
      if (typeof environment[field] !== 'string' || environment[field].length === 0) {
        return new HandshakeError(`environment.${field} must be a non-empty string`);
      }
    }
    return result;
  }

  private gateEnvironment(minExecutorVersion: string): Error | undefined {
    if (compareVersions(this.executorVersionValue, minExecutorVersion) < 0) {
      return new HandshakeError(
        `executor version ${this.executorVersionValue} is below the minimum ${minExecutorVersion}; upgrade the remote executor (kimi exec-server) and retry`,
        {
          kind: 'incompatible',
          executorVersion: this.executorVersionValue,
          minExecutorVersion,
        },
      );
    }
    if (this.environmentValue.pathClass !== 'posix') {
      return new HandshakeError(
        `executor environment ${this.environmentValue.osKind} is not posix; remote environments require a posix target`,
        { kind: 'incompatible' },
      );
    }
    return undefined;
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== 'ready') {
      return Promise.reject(
        new ConnectionClosedError(
          this.closeInfo === undefined
            ? 'connection is not ready'
            : `connection is closed: ${this.closeInfo.reason}`,
        ),
      );
    }
    if (this.inFlight >= MAX_IN_FLIGHT_CALLS) {
      return new Promise<unknown>((resolve, reject) => {
        this.callQueue.push(() => {
          this.call(method, params).then(resolve, reject);
        });
      });
    }
    const id = this.nextId++;
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ id, method, params });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.inFlight += 1;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = { resolve, reject };
      pending.timer = setTimeout(() => {
        this.expireRequest(id, method);
      }, this.requestCallTimeoutMs);
      pending.timer.unref?.();
      this.pending.set(id, pending);
      this.pipe.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== 'ready') return;
    this.pipe.write(encodeFrame({ method, params }));
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (handlers === undefined) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  onDidClose(listener: (info: ConnectionCloseInfo) => void): void {
    if (this.closeInfo !== undefined) {
      listener(this.closeInfo);
      return;
    }
    this.closeListeners.add(listener);
  }

  close(): void {
    this.fail(new ConnectionClosedError('connection closed by client'));
  }

  private onData(chunk: Uint8Array): void {
    if (this.closed) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolViolationError(String(error)));
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: unknown): void {
    let message;
    try {
      message = classifyMessage(frame);
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolViolationError(String(error)));
      return;
    }
    if (isResponse(message) || isErrorResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (this.handshakeComplete) this.releaseSlot();
      if (isResponse(message)) {
        pending.resolve(message.result);
      } else {
        pending.reject(RpcError.fromErrorBody(message.error));
      }
      return;
    }
    if (!this.handshakeComplete) {
      this.fail(new ProtocolViolationError('received a message before the initialize response'));
      return;
    }
    if (isRequest(message)) {
      this.fail(new ProtocolViolationError(`unexpected server request ${message.method}`));
      return;
    }
    if (isNotification(message)) {
      if (!SERVER_NOTIFICATION_METHODS.has(message.method)) {
        this.fail(new ProtocolViolationError(`unknown notification ${message.method}`));
        return;
      }
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch {

          }
        }
      }
      return;
    }
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.callQueue.shift();
    if (next !== undefined) next();
  }

  private expireRequest(id: RequestId, method: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.releaseSlot();
    pending.reject(new RequestTimeoutError(method, this.requestCallTimeoutMs));
  }

  private onPipeEnd(): void {
    this.fail(new ConnectionClosedError('pipe ended'));
  }

  private fail(error: Error): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeInfo = { reason: error.message };
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    if (!this.handshakeComplete) {
      this.onHandshakeResponse(error);
    }
    const failure = error instanceof ConnectionClosedError ? error : new ConnectionClosedError(error.message);
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();

    for (const run of this.callQueue.splice(0)) {
      run();
    }
    for (const listener of this.closeListeners) listener(this.closeInfo);
    this.closeListeners.clear();
    this.teardown();
  }

  private teardown(): void {
    try {
      this.pipe.end();
    } catch {
    }
  }
}
