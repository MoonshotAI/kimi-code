import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

export interface DeviceHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body?: Buffer;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const DEVICE_HTTP_TIMEOUT_MS = 30_000;

export interface DeviceHttpResponse {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body: Buffer;
}

export type DeviceRequestFailure = 'cancelled' | 'timeout' | 'body_too_large' | 'unavailable';

export class DeviceRequestError extends Error {
  constructor(readonly failure: DeviceRequestFailure, message: string) {
    super(message);
    this.name = 'DeviceRequestError';
  }
}

export interface DeviceWsHandlers {
  onMessage(data: string): void;
  onClose(code?: number, reason?: string): void;
  onBackpressure(blocked: boolean): void;
}

export interface DeviceWsSession {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DeviceSession {
  request(req: DeviceHttpRequest): Promise<DeviceHttpResponse>;
  openWebSocket(path: string, handlers: DeviceWsHandlers): DeviceWsSession;
}
