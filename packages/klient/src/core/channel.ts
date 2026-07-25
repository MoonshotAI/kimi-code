/**
 * Transport SPI — the single abstraction every klient transport implements.
 *
 * A `KlientChannel` carries service calls and event subscriptions for one
 * scope triple. The facade above it never knows which transport is underneath
 * (http, ipc, or in-memory); transports never know which facade method
 * triggered a frame. `ScopeRef` already carries session/agent coordinates so
 * future session/agent facades plug in without changing this interface.
 */

export interface IDisposable {
  dispose(): void;
}

/** Scope coordinates of a call/subscription. Empty object = core (app) scope. */
export interface ScopeRef {
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * Where an event subscription reads from:
 * - `stream` — a scope's named event stream, mirroring kap-server's WS
 *   `eventMap`: core `events` (the global `IEventService` bus), session
 *   `interactions` / `interactions:resolved`, agent `events` (the per-agent
 *   `IEventBus`). The scope coordinates disambiguate which scope's stream.
 * - `emitter` — one service's `onDid*` `Event<T>` property, addressed by the
 *   service's wire name and the property name (e.g. `onDidChangeModels`).
 */
export type EventSourceRef =
  | { readonly kind: 'stream'; readonly name: string }
  | { readonly kind: 'emitter'; readonly service: string; readonly event: string };

export interface KlientChannel {
  /** Invoke `service.method(...args)` in the given scope; resolves with the raw wire result. */
  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown>;
  /**
   * Invoke `service.method(...args)` in the given scope and return a streaming
   * result. The callee must return an `AsyncIterable`; each yielded chunk is
   * surfaced as-is (after the transport's serialization round-trip).
   */
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  /**
   * Subscribe to an event source; `handler` receives raw wire payloads.
   * `onError` reports asynchronous subscription failures (bad source, dropped
   * remote subscription) — synchronous validation may also throw.
   */
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable;
  /** Tear the transport down (sockets, lazy bridges). Rejects in-flight calls. */
  close(): Promise<void>;
}
