/**
 * `remoteControl` domain — `IRemoteControlService` implementation.
 *
 * Orchestrates OAuth-backed relay connections through `auth`, reads stable host
 * identity through `bootstrap`, checks its experimental gate through `flag`, and
 * records credential-free lifecycle diagnostics through `log`. Bound at App scope.
 */

import { createKimiDeviceId, KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import { Disposable, DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';

import { REMOTE_CONTROL_FLAG_ID } from './flag';
import {
  BAD_GATEWAY_RESPONSE,
  HttpRequestAssembler,
  encodeHttpTunnelMessage,
  encodeManagementMessage,
  parseHttpTunnelMessage,
  parseManagementInbound,
  resolveLocalUrl,
  serializeHttpResponseHead,
  type HttpTunnelMessage,
  type LocalHttpRequest,
  type ManagementInboundMessage,
  type RemoteDisconnectReason,
  type RemoteStreamErrorCode,
} from './protocol';
import {
  IRemoteControlService,
  type RemoteControlStartOptions,
  type RemoteControlState,
} from './remoteControl';
import {
  IRemoteControlTransport,
  type RemoteSocket,
  type RemoteSocketBridge,
} from './remoteControlTransport';

const STREAM_OPEN_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface StreamHandle {
  readonly bridge: RemoteSocketBridge;
  closeListener?: IDisposable;
}

export class RemoteControlService extends Disposable implements IRemoteControlService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeState = this._register(new Emitter<RemoteControlState>());
  readonly onDidChangeState: Event<RemoteControlState> = this._onDidChangeState.event;
  private readonly connectionResources = this._register(new DisposableStore());
  private readonly streams = new Map<string, StreamHandle>();
  private readonly requestControllers = new Map<string, AbortController>();
  private httpTunnelOpening = false;
  private readonly assembler = new HttpRequestAssembler();
  private options: RemoteControlStartOptions | undefined;
  private management: RemoteSocket | undefined;
  private httpTunnel: RemoteSocket | undefined;
  private rootController: AbortController | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private generation = 0;
  private stopping = true;
  private _state: RemoteControlState = 'disabled';

  get state(): RemoteControlState {
    return this._state;
  }

  constructor(
    @IRemoteControlTransport private readonly transport: IRemoteControlTransport,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async start(options: RemoteControlStartOptions): Promise<void> {
    if (!this.flags.enabled(REMOTE_CONTROL_FLAG_ID)) {
      this.setState('disabled');
      return;
    }
    validateStartOptions(options);
    if (!this.stopping) await this.stop('user_requested');
    this.options = options;
    this.stopping = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  async stop(
    reason: Extract<RemoteDisconnectReason, 'user_requested' | 'local_server_stopped' | 'client_upgrading'>,
  ): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.generation++;
    this.clearReconnectTimer();
    if (this.management !== undefined) {
      this.management.send(encodeManagementMessage({ type: 'disconnect', payload: { reason } }));
      await Promise.resolve();
    }
    this.resetConnections();
    this.setState('offline');
  }

  override dispose(): void {
    this.stopping = true;
    this.generation++;
    this.clearReconnectTimer();
    this.resetConnections();
    super.dispose();
  }

  private async connect(): Promise<void> {
    const options = this.options;
    if (options === undefined || this.stopping) return;
    const generation = ++this.generation;
    this.resetConnections();
    this.rootController = new AbortController();
    this.setState('connecting');

    try {
      const token = await this.oauth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME);
      if (token === undefined || token.length === 0) {
        this.setState('offline');
        this.log.info('remote control is waiting for OAuth authentication');
        this.scheduleReconnect(false);
        return;
      }
      const deviceId = createKimiDeviceId(this.bootstrap.homeDir);
      const management = await this.transport.connectManagement(
        options.relayBaseUrl,
        token,
        this.rootController.signal,
      );
      if (generation !== this.generation || this.stopping) {
        management.dispose();
        return;
      }
      this.management = management;
      this.bindManagement(management, token, generation, deviceId);
      management.send(encodeManagementMessage({
        type: 'register',
        payload: {
          device_id: deviceId,
          alias: options.alias,
          platform: this.bootstrap.platform,
          client_version: this.bootstrap.clientIdentity.version,
          local_base_url: options.localBaseUrl,
        },
      }));
    } catch (error) {
      if (generation !== this.generation || this.stopping) return;
      this.setState('offline');
      this.log.warn('remote control connection failed', { error_type: errorType(error) });
      this.scheduleReconnect(false);
    }
  }

  private bindManagement(socket: RemoteSocket, token: string, generation: number, deviceId: string): void {
    this.connectionResources.add(socket.onMessage((data, binary) => {
      if (binary) {
        this.protocolError(socket, generation);
        return;
      }
      let message: ManagementInboundMessage;
      try {
        message = parseManagementInbound(data);
      } catch {
        this.protocolError(socket, generation);
        return;
      }
      void this.handleManagementMessage(message, token, generation, deviceId);
    }));
    this.connectionResources.add(socket.onPing((data) => { socket.pong(data); }));
    this.connectionResources.add(socket.onClose(() => { this.handleConnectionLoss(generation); }));
    this.connectionResources.add(socket.onError(() => { this.handleConnectionLoss(generation); }));
  }

  private async handleManagementMessage(
    message: ManagementInboundMessage,
    token: string,
    generation: number,
    deviceId: string,
  ): Promise<void> {
    if (generation !== this.generation || this.stopping) return;
    switch (message.type) {
      case 'register_ack':
        if (!message.payload.success) {
          this.management?.close(1008, 'registration rejected');
          return;
        }
        await this.openHttpTunnel(token, generation, deviceId);
        return;
      case 'open_ws':
        await this.openStream(message.payload, token, generation);
        return;
      case 'close_ws':
        this.closeStream(message.payload.stream_id, message.payload.close_code, message.payload.reason);
        if (
          message.payload.reason === 'server_shutting_down' &&
          message.payload.path !== undefined
        ) {
          await this.openStream({
            stream_id: message.payload.stream_id,
            path: message.payload.path,
            headers: message.payload.headers ?? {},
          }, token, generation);
        }
        return;
      case 'disconnect':
        if (message.payload.reason === 'user_requested') {
          this.stopping = true;
          this.generation++;
          this.resetConnections();
          this.setState('offline');
        } else {
          this.handleConnectionLoss(generation, true);
        }
    }
  }

  private async openHttpTunnel(token: string, generation: number, deviceId: string): Promise<void> {
    if (
      this.options === undefined ||
      this.rootController === undefined ||
      this.httpTunnel !== undefined ||
      this.httpTunnelOpening
    ) return;
    this.httpTunnelOpening = true;
    try {
      const socket = await this.transport.connectHttpTunnel(
        this.options.relayBaseUrl,
        token,
        deviceId,
        this.rootController.signal,
      );
      if (generation !== this.generation || this.stopping) {
        socket.dispose();
        return;
      }
      this.httpTunnel = socket;
      this.connectionResources.add(socket.onMessage((data, binary) => {
        if (binary) {
          this.protocolError(socket, generation);
          return;
        }
        try {
          const message = parseHttpTunnelMessage(data);
          if (message.type !== 'request') {
            this.protocolError(socket, generation);
            return;
          }
          const request = this.assembler.push(message);
          if (request !== undefined) void this.forwardHttp(message.request_id, request, generation);
        } catch {
          this.protocolError(socket, generation);
        }
      }));
      this.connectionResources.add(socket.onPing((data) => { socket.pong(data); }));
      this.connectionResources.add(socket.onClose(() => { this.handleConnectionLoss(generation); }));
      this.connectionResources.add(socket.onError(() => { this.handleConnectionLoss(generation); }));
      this.reconnectAttempts = 0;
      this.setState('online');
    } catch (error) {
      if (generation !== this.generation || this.stopping) return;
      this.log.warn('remote control HTTP tunnel failed', { error_type: errorType(error) });
      this.handleConnectionLoss(generation);
    } finally {
      this.httpTunnelOpening = false;
    }
  }

  private async forwardHttp(
    requestId: string,
    request: LocalHttpRequest,
    generation: number,
  ): Promise<void> {
    const options = this.options;
    const root = this.rootController;
    if (options === undefined || root === undefined) return;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(root.signal.reason); };
    root.signal.addEventListener('abort', abort, { once: true });
    this.requestControllers.set(requestId, controller);
    try {
      const response = await this.transport.forwardLocalHttp(
        options.localBaseUrl,
        request,
        options.getLocalToken(),
        controller.signal,
      );
      if (generation !== this.generation || controller.signal.aborted) return;
      if (response.streaming) {
        this.sendHttp(requestId, 'response_chunk', false,
          serializeHttpResponseHead(response.statusCode, response.statusMessage, response.headers));
        for await (const chunk of response.body) {
          if (controller.signal.aborted) return;
          this.sendHttp(requestId, 'response_chunk', false, chunk);
        }
        this.sendHttp(requestId, 'response_chunk', true, Buffer.alloc(0));
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const head = serializeHttpResponseHead(
          response.statusCode,
          response.statusMessage,
          response.headers,
          body.byteLength,
        );
        this.sendHttp(requestId, 'response', true, Buffer.concat([head, body]));
      }
    } catch {
      if (!controller.signal.aborted) this.sendHttp(requestId, 'response', true, BAD_GATEWAY_RESPONSE);
    } finally {
      root.signal.removeEventListener('abort', abort);
      this.requestControllers.delete(requestId);
    }
  }

  private sendHttp(
    requestId: string,
    type: Extract<HttpTunnelMessage['type'], 'response' | 'response_chunk'>,
    isLast: boolean,
    body: Buffer,
  ): void {
    this.httpTunnel?.send(encodeHttpTunnelMessage({
      request_id: requestId,
      type,
      is_last: isLast,
      body_base64: body.toString('base64'),
    }));
  }

  private async openStream(
    payload: { stream_id: string; path: string; headers: Record<string, string> },
    token: string,
    generation: number,
  ): Promise<void> {
    const options = this.options;
    const root = this.rootController;
    if (options === undefined || root === undefined) return;
    this.closeStream(payload.stream_id);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => { controller.abort(new Error('timeout')); },
      options.streamOpenTimeoutMs ?? STREAM_OPEN_TIMEOUT_MS,
    );
    const abort = (): void => { controller.abort(root.signal.reason); };
    root.signal.addEventListener('abort', abort, { once: true });
    let local: RemoteSocket | undefined;
    let tunnel: RemoteSocket | undefined;
    // Open the relay stream before the local WebSocket: the local server emits
    // its first frames (e.g. `server_hello`) immediately on connect, and any of
    // them sent before the tunnel is up would be lost on the floor.
    let stage: RemoteStreamErrorCode = 'TUNNEL_STREAM_FAILED';
    try {
      tunnel = await this.transport.connectTunnelStream(
        options.relayBaseUrl,
        payload.stream_id,
        token,
        controller.signal,
      );
      stage = 'LOCAL_WS_FAILED';
      local = await this.transport.connectLocalWebSocket(
        options.localBaseUrl,
        payload.path,
        payload.headers,
        options.getLocalToken(),
        controller.signal,
      );
      if (generation !== this.generation || controller.signal.aborted) throw controller.signal.reason;
      stage = 'UNKNOWN';
      const bridge = this.transport.bridgeWebSockets(local, tunnel);
      const handle: StreamHandle = { bridge };
      this.streams.set(payload.stream_id, handle);
      handle.closeListener = bridge.onClose(() => {
        if (this.streams.get(payload.stream_id)?.bridge === bridge) {
          this.streams.delete(payload.stream_id);
        }
      });
      this.management?.send(encodeManagementMessage({
        type: 'open_ws_result',
        payload: { stream_id: payload.stream_id, success: true },
      }));
    } catch (error) {
      local?.dispose();
      tunnel?.dispose();
      const errorCode = controller.signal.aborted && error instanceof Error && error.message === 'timeout'
        ? 'TIMEOUT'
        : stage;
      this.management?.send(encodeManagementMessage({
        type: 'open_ws_result',
        payload: {
          stream_id: payload.stream_id,
          success: false,
          error_code: errorCode,
          error_message: streamErrorMessage(errorCode),
        },
      }));
    } finally {
      clearTimeout(timeout);
      root.signal.removeEventListener('abort', abort);
    }
  }

  private closeStream(streamId: string, code = 1000, reason = ''): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    stream.closeListener?.dispose();
    stream.bridge.close(code, reason);
    this.log.debug('remote control stream closed', { stream_id: streamId, close_code: code, reason });
  }

  private protocolError(socket: RemoteSocket, generation: number): void {
    socket.close(1002, 'protocol error');
    this.handleConnectionLoss(generation);
  }

  private handleConnectionLoss(generation: number, immediate = false): void {
    if (generation !== this.generation || this.stopping) return;
    this.generation++;
    this.resetConnections();
    this.setState('offline');
    this.scheduleReconnect(immediate);
  }

  private scheduleReconnect(immediate: boolean): void {
    if (this.stopping || this.options === undefined || this.reconnectTimer !== undefined) return;
    const base = immediate ? 0 : Math.min(1000 * 2 ** this.reconnectAttempts++, MAX_RECONNECT_DELAY_MS);
    const delay = immediate ? 0 : Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => { this.scheduleReconnect(false); });
    }, delay);
  }

  private resetConnections(): void {
    this.rootController?.abort();
    this.rootController = undefined;
    for (const controller of this.requestControllers.values()) controller.abort();
    this.requestControllers.clear();
    for (const stream of this.streams.values()) {
      stream.closeListener?.dispose();
      stream.bridge.dispose();
    }
    this.streams.clear();
    this.assembler.clear();
    this.connectionResources.clear();
    this.management?.dispose();
    this.httpTunnel?.dispose();
    this.management = undefined;
    this.httpTunnel = undefined;
    this.httpTunnelOpening = false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private setState(state: RemoteControlState): void {
    if (state === this._state) return;
    this._state = state;
    this._onDidChangeState.fire(state);
  }
}

function validateStartOptions(options: RemoteControlStartOptions): void {
  const relay = new URL(options.relayBaseUrl);
  if (relay.protocol !== 'http:' && relay.protocol !== 'https:') {
    throw new Error('relay base URL must use HTTP or HTTPS');
  }
  if (relay.username.length > 0 || relay.password.length > 0) {
    throw new Error('relay base URL must not contain credentials');
  }
  resolveLocalUrl(options.localBaseUrl, '/');
  if (options.alias.length === 0) throw new Error('remote control alias must not be empty');
  if (
    options.streamOpenTimeoutMs !== undefined &&
    (!Number.isFinite(options.streamOpenTimeoutMs) || options.streamOpenTimeoutMs <= 0)
  ) {
    throw new Error('stream open timeout must be a positive finite number');
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function streamErrorMessage(code: RemoteStreamErrorCode): string {
  switch (code) {
    case 'LOCAL_WS_FAILED': return 'failed to connect to local Kimi Code';
    case 'TUNNEL_STREAM_FAILED': return 'failed to connect relay stream';
    case 'TIMEOUT': return 'stream setup timed out';
    case 'UNKNOWN': return 'stream setup failed';
  }
}

registerScopedService(
  LifecycleScope.App,
  IRemoteControlService,
  RemoteControlService,
  ScopeActivation.OnDemand,
  'remoteControl',
);
