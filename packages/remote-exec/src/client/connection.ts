import { encodeFrame, LineFrameDecoder } from '#/protocol/codec';
import { RpcError } from '#/protocol/errors';
import {
  classifyMessage,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolViolationError,
  type RequestId,
} from '#/protocol/messages';
import {
  compareVersions,
  CONTROL_CALL_METHODS,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  LONG_POLL_METHODS,
  MAX_IN_FLIGHT_CALLS,
  MIN_EXECUTOR_VERSION,
  SERVER_NOTIFICATION_METHODS,
  isValidServerNotificationParams,
  type InitializeResult,
  type RemoteCapabilities,
  type RemoteEnvironmentInfo,
} from '#/protocol/methods';
import type { BytePipe } from './execBridge';

export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTROL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_CALL_TIMEOUT_MS = 60_000;

export interface ConnectOptions {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly minExecutorVersion?: string;
  readonly initializeTimeoutMs?: number;
  readonly controlCallTimeoutMs?: number;
  readonly requestCallTimeoutMs?: number;
}

export interface ConnectionCloseInfo {
  readonly reason: string;
  readonly error?: Error;
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

// A control-plane call that the executor never answered. The connection is
// treated as broken (the peer answered the handshake, so transport is alive —
// the stall is application-level) and closed, which rejects every pending
// call with ConnectionClosedError: the same D3 disconnect surface as a
// transport drop.
export class ControlCallTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`control call ${method} timed out after ${String(timeoutMs)}ms; closing the connection`);
    this.name = 'ControlCallTimeoutError';
  }
}

// A business call that the executor did not answer in time. Only the stalled
// request fails — the connection stays up, and the request id is remembered
// so the late response, if it ever arrives, is discarded instead of being
// treated as a protocol violation.
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
  private controlCallTimeoutMs = DEFAULT_CONTROL_CALL_TIMEOUT_MS;
  private requestCallTimeoutMs = DEFAULT_REQUEST_CALL_TIMEOUT_MS;
  private closeInfo: ConnectionCloseInfo | undefined;
  // Ids of requests that timed out and whose late response must be discarded.
  // Bounded like the in-flight cap: ids are consumed by the late response, and
  // the oldest is evicted beyond the cap so a long-lived connection cannot
  // grow the set without limit.
  private readonly expiredIds = new Set<RequestId>();

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

  get capabilities(): RemoteCapabilities {
    return this.capabilitiesValue;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  get closeReason(): ConnectionCloseInfo | undefined {
    return this.closeInfo;
  }

  private environmentValue!: RemoteEnvironmentInfo;
  private executorVersionValue!: string;
  private capabilitiesValue!: RemoteCapabilities;

  private handshake(options: ConnectOptions): Promise<RemoteExecConnection> {
    return new Promise<RemoteExecConnection>((resolve, reject) => {
      const timeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
      this.controlCallTimeoutMs = options.controlCallTimeoutMs ?? DEFAULT_CONTROL_CALL_TIMEOUT_MS;
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
          // An error answer to initialize (wrong-dialect peer) must surface
          // immediately, not be misreported later as an initialize timeout.
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
    this.capabilitiesValue = parsed.capabilities;
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
    if (result.capabilities === null || typeof result.capabilities !== 'object') {
      return new HandshakeError('initialize response must carry a capabilities object');
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
      if (CONTROL_CALL_METHODS.has(method)) {
        pending.timer = setTimeout(() => {
          this.fail(new ControlCallTimeoutError(method, this.controlCallTimeoutMs));
        }, this.controlCallTimeoutMs);
        pending.timer.unref?.();
      } else if (!LONG_POLL_METHODS.has(method)) {
        pending.timer = setTimeout(() => {
          this.expireRequest(id, method);
        }, this.requestCallTimeoutMs);
        pending.timer.unref?.();
      }
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
        // A response to a request that already timed out is stale: discard it
        // instead of faulting the connection it arrived on.
        if (!this.expiredIds.delete(message.id)) {
          this.fail(new ProtocolViolationError(`response for unknown id ${String(message.id)}`));
        }
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
      // A malformed notification is dropped, not faulted: one bad frame from
      // a misbehaving peer must not kill an otherwise healthy connection.
      if (!isValidServerNotificationParams(message.method, message.params)) return;
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch {
            // A throwing handler must not escape the dispatch loop — an
            // uncaught throw here would crash the host process.
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
    this.expiredIds.add(id);
    if (this.expiredIds.size > MAX_IN_FLIGHT_CALLS) {
      const oldest = this.expiredIds.values().next();
      if (!oldest.done) this.expiredIds.delete(oldest.value);
    }
    this.releaseSlot();
    pending.reject(new RequestTimeoutError(method, this.requestCallTimeoutMs));
  }

  private onPipeEnd(): void {
    this.fail(new ConnectionClosedError('pipe ended'));
  }

  private fail(error: Error): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closeInfo = { reason: error.message, error };
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
    // Queued calls re-enter call(), which now rejects with ConnectionClosedError.
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
