import type { IncomingMessage } from 'node:http';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { AuthPrincipal } from '../services/auth/principal';
import { selectWsBearerProtocol } from '../transport/ws/bearerProtocol';
import { DeviceRegistry, DeviceBridgeError, type ActiveDevice, type DeviceRegistryChange, type DeviceSnapshot } from './deviceRegistry';
import {
  DEVICE_BRIDGE_MAX_BUFFERED_BYTES,
  DEVICE_BRIDGE_MAX_PAYLOAD_BYTES,
  DEVICE_BRIDGE_MAX_PENDING_PER_DEVICE,
  DEVICE_BRIDGE_PROTOCOL_VERSION,
  deviceClientFrameSchema,
  deviceHelloSchema,
  type DeviceServerFrame,
  type RemoteRuntimeMethod,
} from './protocol';

export interface DeviceBridgeHubOptions {
  readonly catalogFile: string;
  readonly enabled: () => boolean;
  readonly defaultTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly helloTimeoutMs?: number;
}

interface SocketState {
  readonly socket: WebSocket;
  readonly req: IncomingMessage;
  active?: ActiveDevice;
  helloTimer?: NodeJS.Timeout;
  closed: boolean;
  lastInboundAt: number;
}

export class DeviceBridgeHub {
  readonly wss: WebSocketServer;
  private readonly sockets = new Set<SocketState>();
  private readonly heartbeatTimer?: NodeJS.Timeout;
  private closed = false;

  private constructor(
    readonly registry: DeviceRegistry,
    private readonly opts: DeviceBridgeHubOptions,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: DEVICE_BRIDGE_MAX_PAYLOAD_BYTES,
      handleProtocols: selectWsBearerProtocol,
    });
    this.wss.on('connection', (socket, req, principal?: AuthPrincipal) => {
      this.onConnection(socket, req, principal);
    });
    const heartbeatMs = opts.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const state of this.sockets) {
        if (now - state.lastInboundAt > heartbeatMs * 2) {
          this.closeState(state, 1001, 'heartbeat timeout');
          continue;
        }
        if (state.active !== undefined) this.sendState(state, { type: 'device.ping' });
      }
    }, heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  static async create(opts: DeviceBridgeHubOptions): Promise<DeviceBridgeHub> {
    const registry = await DeviceRegistry.load({
      catalogFile: opts.catalogFile,
      defaultTimeoutMs: opts.defaultTimeoutMs,
    });
    return new DeviceBridgeHub(registry, opts);
  }

  get enabled(): boolean {
    return this.opts.enabled();
  }

  list(): DeviceSnapshot[] {
    return this.registry.list();
  }

  get(deviceId: string): DeviceSnapshot | undefined {
    return this.registry.get(deviceId);
  }

  onDidChange(listener: (change: DeviceRegistryChange) => void): { dispose(): void } {
    return this.registry.onDidChange(listener);
  }

  request(
    deviceId: string,
    method: RemoteRuntimeMethod,
    params: unknown,
    options: { readonly mutating?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.enabled) {
      return Promise.reject(new DeviceBridgeError('runtime.unsupported', 'internal central server experiment is disabled'));
    }
    return this.registry.request(deviceId, method, params, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    for (const state of this.sockets) this.closeState(state, 1001, 'server shutting down');
    await this.registry.close();
    this.wss.close();
  }

  private onConnection(socket: WebSocket, req: IncomingMessage, principal?: AuthPrincipal): void {
    const state: SocketState = {
      socket,
      req,
      closed: false,
      lastInboundAt: Date.now(),
    };
    this.sockets.add(state);
    const transport = {
      get bufferedAmount(): number {
        return socket.bufferedAmount;
      },
      send: (frame: DeviceServerFrame): void => {
        this.sendState(state, frame);
      },
    };
    if (!this.enabled || principal === undefined) {
      this.sendState(state, {
        type: 'device.error',
        error: {
          code: this.enabled ? 'auth.unauthorized' : 'runtime.unsupported',
          message: this.enabled ? 'authenticated user required' : 'internal central server experiment is disabled',
        },
      });
      this.closeState(state, 1008, 'unauthorized');
      return;
    }
    state.helloTimer = setTimeout(() => {
      this.closeState(state, 1008, 'device hello timeout');
    }, this.opts.helloTimeoutMs ?? 5_000);
    state.helloTimer.unref?.();
    socket.on('message', (data: RawData, isBinary: boolean) => {
      this.onMessage(state, transport, principal, data, isBinary);
    });
    socket.on('close', () => this.onSocketClosed(state));
    socket.on('error', () => this.onSocketClosed(state));
  }

  private onMessage(
    state: SocketState,
    transport: { readonly bufferedAmount: number; send(frame: DeviceServerFrame): void },
    principal: AuthPrincipal,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (state.closed) return;
    state.lastInboundAt = Date.now();
    if (isBinary) {
      this.failState(state, 'runtime.protocol_error', 'binary frames are not supported; encode bytes as base64 in JSON');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawDataToString(data));
    } catch {
      this.failState(state, 'runtime.protocol_error', 'invalid JSON frame');
      return;
    }
    const parsed = deviceClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      const version = typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['protocol_version']
        : undefined;
      this.failState(
        state,
        version !== undefined && version !== DEVICE_BRIDGE_PROTOCOL_VERSION ? 'runtime.unsupported' : 'runtime.protocol_error',
        version !== undefined && version !== DEVICE_BRIDGE_PROTOCOL_VERSION
          ? `unsupported device bridge protocol ${JSON.stringify(version)}`
          : 'invalid device bridge frame',
      );
      return;
    }
    const frame = parsed.data;
    if (state.active === undefined) {
      if (frame.type !== 'device.hello') {
        this.failState(state, 'runtime.protocol_error', 'device.hello must be the first frame');
        return;
      }
      const hello = deviceHelloSchema.parse(frame);
      void this.registry.connect(hello, principal, transport).then(
        (active) => {
          if (state.closed) {
            this.registry.disconnect(active);
            return;
          }
          if (state.helloTimer !== undefined) clearTimeout(state.helloTimer);
          state.helloTimer = undefined;
          state.active = active;
          this.sendState(state, {
            type: 'device.welcome',
            protocol_version: DEVICE_BRIDGE_PROTOCOL_VERSION,
            device_id: active.deviceId,
            connection_id: active.connectionId,
            generation: active.generation,
            limits: {
              max_payload_bytes: DEVICE_BRIDGE_MAX_PAYLOAD_BYTES,
              max_binary_bytes: 10 * 1024 * 1024,
              max_pending_requests: DEVICE_BRIDGE_MAX_PENDING_PER_DEVICE,
            },
          });
        },
        (error: unknown) => {
          const payload = bridgeError(error);
          this.sendState(state, { type: 'device.error', error: payload });
          this.closeState(state, 1008, payload.code);
        },
      );
      return;
    }
    if (frame.type === 'device.hello') {
      this.failState(state, 'runtime.protocol_error', 'device.hello is only valid once');
      return;
    }
    const active = state.active;
    this.registry.touch(active);
    switch (frame.type) {
      case 'device.command':
        this.registry.handleCommand(active, frame);
        return;
      case 'runtime.result':
        this.registry.handleResult(active, frame);
        return;
      case 'runtime.error':
        this.registry.handleError(active, frame);
        return;
      case 'device.pong':
        return;
    }
  }

  private failState(state: SocketState, code: string, message: string): void {
    this.sendState(state, { type: 'device.error', error: { code, message } });
    this.closeState(state, 1008, code);
  }

  private sendState(state: SocketState, frame: DeviceServerFrame): void {
    if (state.closed || state.socket.readyState !== WebSocket.OPEN) {
      throw new DeviceBridgeError('runtime.unavailable', `device ${state.active?.deviceId ?? 'connection'} is not open`);
    }
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > DEVICE_BRIDGE_MAX_PAYLOAD_BYTES) {
      throw new DeviceBridgeError('runtime.too_large', 'device bridge frame exceeds the payload limit');
    }
    if (state.socket.bufferedAmount > DEVICE_BRIDGE_MAX_BUFFERED_BYTES) {
      throw new DeviceBridgeError('runtime.busy', 'device bridge socket is backpressured', { retryable: true });
    }
    state.socket.send(data);
  }

  private closeState(state: SocketState, code: number, reason: string): void {
    if (state.closed) return;
    try {
      state.socket.close(code, reason.slice(0, 120));
    } catch {
      state.socket.terminate();
    }
    this.onSocketClosed(state);
  }

  private onSocketClosed(state: SocketState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.helloTimer !== undefined) clearTimeout(state.helloTimer);
    state.helloTimer = undefined;
    if (state.active !== undefined) this.registry.disconnect(state.active);
    state.active = undefined;
    this.sockets.delete(state);
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function bridgeError(error: unknown): { code: string; message: string; retryable?: boolean; uncertain?: boolean } {
  if (error instanceof DeviceBridgeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      uncertain: error.uncertain,
    };
  }
  return { code: 'runtime.internal', message: error instanceof Error ? error.message : String(error) };
}
