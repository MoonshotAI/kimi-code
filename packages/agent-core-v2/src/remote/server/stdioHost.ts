import type { Readable, Writable } from 'node:stream';
import { once } from 'node:events';

import { encodeFrame, LineFrameDecoder } from '#/remote/protocol/codec';
import { RpcError, RpcErrorCode, toRpcError } from '#/remote/protocol/errors';
import {
  classifyMessage,
  isNotification,
  isRequest,
  ProtocolViolationError,
  type JsonRpcRequest,
  type RequestId,
} from '#/remote/protocol/messages';
import {
  FS_READ_FILE_METHOD,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  MAX_IN_FLIGHT_CALLS,
  MAX_PENDING_SEND_BYTES,
  PROCESS_FLOW_METHOD,
  PROCESS_RESIZE_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_TERMINATE_METHOD,
  PROCESS_WRITE_METHOD,
  type InitializeResult,
  type RemoteEnvironmentInfo,
} from '#/remote/protocol/methods';
import { FsHandler } from './fsHandler';
import { ProcessManager } from './processManager';

export interface StdioHostOptions {
  readonly version: string;
  readonly environment: RemoteEnvironmentInfo;
  readonly input: Readable;
  readonly output: Writable;
  readonly log: (line: string) => void;
}

type Lane = 'control' | 'data';

type Handler = (params: unknown) => Promise<unknown>;

const CONTROL_METHODS: ReadonlySet<string> = new Set([
  PROCESS_WRITE_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_TERMINATE_METHOD,
  PROCESS_RESIZE_METHOD,
]);

const DATA_LANE_RESPONSE_METHODS: ReadonlySet<string> = new Set([FS_READ_FILE_METHOD]);

class OutboundWriter {
  private control: Uint8Array[] = [];
  private data: Uint8Array[] = [];
  private controlBytes = 0;
  private dataBytes = 0;
  private pumping = false;
  private destroyed = false;
  private paused = false;

  constructor(
    private readonly output: Writable,
    private readonly watermarkBytes: number,
    private readonly onFuseBreach: () => void,
    private readonly onWatermarkChange: (paused: boolean) => void,
  ) {}

  enqueue(frame: Uint8Array, lane: Lane): void {
    if (this.destroyed) return;
    if (this.controlBytes + this.dataBytes + frame.length > MAX_PENDING_SEND_BYTES) {
      this.onFuseBreach();
      return;
    }
    if (lane === 'control') {
      this.control.push(frame);
      this.controlBytes += frame.length;
    } else {
      this.data.push(frame);
      this.dataBytes += frame.length;
      if (!this.paused && this.dataBytes > this.watermarkBytes) {
        this.paused = true;
        this.onWatermarkChange(true);
      }
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      for (;;) {
        const lane: Lane = this.control.length > 0 ? 'control' : 'data';
        const queue = lane === 'control' ? this.control : this.data;
        const frame = queue.shift();
        if (frame === undefined) break;
        if (lane === 'control') this.controlBytes -= frame.length;
        else this.dataBytes -= frame.length;
        if (this.paused && this.dataBytes <= this.watermarkBytes / 2) {
          this.paused = false;
          this.onWatermarkChange(false);
        }
        if (this.destroyed) return;
        if (!this.output.write(frame)) {
          await once(this.output, 'drain');
        }
        if (this.destroyed) return;
      }
    } catch {
      this.destroy();
    } finally {
      this.pumping = false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.control = [];
    this.data = [];
    this.controlBytes = 0;
    this.dataBytes = 0;
  }
}

export class StdioHost {
  private readonly decoder = new LineFrameDecoder();
  private readonly writer: OutboundWriter;
  private readonly processManager: ProcessManager;
  private readonly fsHandler = new FsHandler();
  private readonly handlers: ReadonlyMap<string, Handler>;
  private state: 'pre-init' | 'awaiting-initialized' | 'ready' = 'pre-init';
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];
  private shuttingDown = false;
  private readonly donePromise: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly options: StdioHostOptions) {
    this.processManager = new ProcessManager({
      notify: (method, params) => {
        this.sendNotification(method, params);
      },
    });
    this.writer = new OutboundWriter(
      options.output,
      8 * 1024 * 1024,
      () => {
        this.options.log('outbound pending frame fuse breached');
        void this.shutdown('send buffer fuse');
      },
      (paused) => {
        this.processManager.setOutputPaused(paused);
      },
    );
    const fs = this.fsHandler;
    const pm = this.processManager;
    this.handlers = new Map<string, Handler>([
      ['fs/readFile', (p) => fs.readFile(p)],
      ['fs/writeFile', (p) => fs.writeFile(p)],
      ['fs/createDirectory', (p) => fs.createDirectory(p)],
      ['fs/getMetadata', (p) => fs.getMetadata(p)],
      ['fs/canonicalize', (p) => fs.canonicalize(p)],
      ['fs/readDirectory', (p) => fs.readDirectory(p)],
      ['fs/remove', (p) => fs.remove(p)],
      ['fs/rename', (p) => fs.rename(p)],
      ['process/start', (p) => pm.start(p)],
      ['process/write', (p) => pm.write(p)],
      ['process/signal', (p) => pm.signal(p)],
      ['process/terminate', (p) => pm.terminate(p)],
      ['process/resize', (p) => pm.resize(p)],
    ]);
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get done(): Promise<void> {
    return this.donePromise;
  }

  start(): void {
    this.options.input.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    this.options.input.on('end', () => {
      void this.shutdown('stdin eof');
    });
    this.options.input.on('error', (error) => {
      this.options.log(`stdin error: ${error.message}`);
      void this.shutdown('stdin error');
    });
    this.options.output.on('error', (error) => {
      this.options.log(`stdout error: ${error.message}`);
      void this.shutdown('stdout error');
    });
  }

  private onData(chunk: Buffer): void {
    if (this.shuttingDown) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.violation(error);
      return;
    }
    for (const frame of frames) {
      if (this.shuttingDown) return;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: unknown): void {
    let message;
    try {
      message = classifyMessage(frame);
    } catch (error) {
      this.violation(error);
      return;
    }

    if (this.state === 'pre-init') {
      if (!isRequest(message) || message.method !== INITIALIZE_METHOD) {
        this.violation(new ProtocolViolationError('expected initialize as the first message'));
        return;
      }
      this.onInitialize(message);
      return;
    }

    if (isNotification(message)) {
      if (message.method === INITIALIZED_METHOD && this.state === 'awaiting-initialized') {
        this.state = 'ready';
        return;
      }
      if (message.method === PROCESS_FLOW_METHOD && this.state === 'ready') {
        this.onProcessFlow(message.params);
        return;
      }
      this.violation(new ProtocolViolationError(`unexpected notification ${message.method}`));
      return;
    }

    if (!isRequest(message)) {
      this.violation(new ProtocolViolationError('server received a response message'));
      return;
    }

    this.onRequest(message);
  }

  private onInitialize(message: JsonRpcRequest): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (typeof params['clientName'] !== 'string' || typeof params['clientVersion'] !== 'string') {
      this.violation(new ProtocolViolationError('initialize params must carry clientName and clientVersion'));
      return;
    }
    const result: InitializeResult = {
      executorVersion: this.options.version,
      environment: this.options.environment,
      capabilities: {},
    };
    this.respond(message.id, result, 'control');
    this.state = 'awaiting-initialized';
  }

  private onProcessFlow(params: unknown): void {

    if (params === null || typeof params !== 'object') return;
    const record = params as Record<string, unknown>;
    if (typeof record['processId'] !== 'string' || typeof record['paused'] !== 'boolean') return;
    this.processManager.setClientPaused(record['processId'], record['paused']);
  }

  private onRequest(message: JsonRpcRequest): void {
    if (message.method === INITIALIZE_METHOD) {
      this.respondError(message.id, new RpcError(RpcErrorCode.InvalidRequest, 'already initialized'));
      return;
    }
    if (this.state !== 'ready') {
      this.respondError(
        message.id,
        new RpcError(RpcErrorCode.InvalidRequest, 'connection is not initialized'),
      );
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.respondError(
        message.id,
        new RpcError(RpcErrorCode.MethodNotFound, `unknown method ${message.method}`),
      );
      return;
    }
    const lane: Lane = DATA_LANE_RESPONSE_METHODS.has(message.method) ? 'data' : 'control';
    if (CONTROL_METHODS.has(message.method)) {
      void this.runHandler(message.id, handler, message.params, lane, false);
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT_CALLS) {
      this.waiting.push(() => {
        void this.runHandler(message.id, handler, message.params, lane, true);
      });
      return;
    }
    this.inFlight += 1;
    void this.runHandler(message.id, handler, message.params, lane, true);
  }

  private async runHandler(
    id: RequestId,
    handler: Handler,
    params: unknown,
    lane: Lane,
    heldSlot: boolean,
  ): Promise<void> {
    try {
      const result = await handler(params);
      this.respond(id, result ?? {}, lane);
    } catch (error) {
      this.respondError(id, toRpcError(error));
    } finally {
      if (heldSlot) this.releaseSlot();
    }
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next !== undefined && !this.shuttingDown) {
      next();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private respond(id: RequestId, result: unknown, lane: Lane): void {
    try {
      this.writer.enqueue(encodeFrame({ id, result }), lane);
    } catch {
      this.respondError(
        id,
        new RpcError(RpcErrorCode.InternalError, 'response exceeds the frame cap'),
      );
    }
  }

  private respondError(id: RequestId, error: RpcError): void {
    try {
      this.writer.enqueue(encodeFrame({ id, error: error.toErrorBody() }), 'control');
    } catch {
      void this.shutdown('failed to encode error response');
    }
  }

  private sendNotification(method: string, params: unknown): void {
    try {
      this.writer.enqueue(encodeFrame({ method, params }), 'data');
    } catch {
      void this.shutdown('failed to encode notification');
    }
  }

  private violation(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log(`protocol violation: ${message}`);
    void this.shutdown('protocol violation');
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return this.donePromise;
    this.shuttingDown = true;
    this.options.log(`shutdown: ${reason}`);
    this.waiting.length = 0;
    await this.processManager.terminateAll();
    this.writer.destroy();
    this.options.output.end();
    this.resolveDone();
    return this.donePromise;
  }
}
