export interface IDisposable {
  dispose(): void;
}

export interface CallOptions {
  readonly timeoutMs?: number;
}

export interface ScopeRef {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export type EventSourceRef =
  | { readonly kind: 'stream'; readonly name: string }
  | { readonly kind: 'emitter'; readonly service: string; readonly event: string };

export interface KlientChannel {
  call(
    scope: ScopeRef,
    service: string,
    method: string,
    args: unknown[],
    options?: CallOptions,
  ): Promise<unknown>;
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable;
  close(): Promise<void>;
}
