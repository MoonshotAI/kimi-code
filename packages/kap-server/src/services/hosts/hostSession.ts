import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

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

export type HostRequestFailure = 'cancelled' | 'timeout' | 'body_too_large' | 'unavailable';

export class HostRequestError extends Error {
  constructor(readonly failure: HostRequestFailure, message: string) {
    super(message);
    this.name = 'HostRequestError';
  }
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
