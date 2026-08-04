/**
 * `remoteControl` domain — App-scope relay and localhost transport contract.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { LocalHttpRequest } from './protocol';

export interface RemoteSocket extends IDisposable {
  send(data: string | Buffer, binary?: boolean): void;
  close(code?: number, reason?: string): void;
  ping(data?: Buffer): void;
  pong(data?: Buffer): void;
  onMessage(listener: (data: Buffer, binary: boolean) => void): IDisposable;
  onClose(listener: (code: number, reason: string) => void): IDisposable;
  onError(listener: (error: Error) => void): IDisposable;
  onPing(listener: (data: Buffer) => void): IDisposable;
  onPong(listener: (data: Buffer) => void): IDisposable;
}

export interface LocalHttpResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly streaming: boolean;
  readonly body: AsyncIterable<Buffer>;
}

export interface RemoteSocketBridge extends IDisposable {
  close(code?: number, reason?: string): void;
  onClose(listener: () => void): IDisposable;
}

export interface IRemoteControlTransport {
  readonly _serviceBrand: undefined;
  connectManagement(relayBaseUrl: string, token: string, signal: AbortSignal): Promise<RemoteSocket>;
  connectHttpTunnel(
    relayBaseUrl: string,
    token: string,
    deviceId: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket>;
  connectTunnelStream(
    relayBaseUrl: string,
    streamId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket>;
  connectLocalWebSocket(
    localBaseUrl: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    localToken: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket>;
  forwardLocalHttp(
    localBaseUrl: string,
    request: LocalHttpRequest,
    localToken: string,
    signal: AbortSignal,
  ): Promise<LocalHttpResponse>;
  bridgeWebSockets(local: RemoteSocket, tunnel: RemoteSocket): RemoteSocketBridge;
}

export const IRemoteControlTransport: ServiceIdentifier<IRemoteControlTransport> =
  createDecorator<IRemoteControlTransport>('remoteControlTransport');
