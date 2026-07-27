/**
 * Minimal DOM-compatible WebSocket surface shared by the app's socket
 * clients (today only the transcript `/api/v1/ws` client). Coding against
 * this structural type keeps the clients testable with an injected fake;
 * the default is the global `WebSocket` (browsers, Node ≥ 21).
 */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void;
}

export interface WsLikeCtor {
  new (url: string, protocols?: string | string[]): WsLike;
  readonly OPEN: number;
}
