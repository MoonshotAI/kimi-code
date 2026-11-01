export interface ConnectionCloseInfo {
  readonly reason: string;
  readonly kind?: 'eof' | 'pipe_error' | 'protocol_error' | 'client_closed' | 'liveness' | 'other';
}

export interface ExecChannel {
  call(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onDidClose(listener: (info: ConnectionCloseInfo) => void): void;
}
