export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: never) => void,
  ): void;
}

export interface WsLikeCtor {
  new (url: string, protocols?: string | string[]): WsLike;
  readonly OPEN: number;
}
