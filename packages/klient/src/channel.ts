/**
 * Transport-agnostic channel contract for the `/api/v2` client.
 *
 * In the VS Code model the channel is bound to one Service (the URL carries the
 * scope + the Service's decorator id) and `command` is the method name, invoked
 * by reflection on the server. `listen` is for events over a persistent (WS)
 * transport; the HTTP channel only implements `call`.
 */

export interface IDisposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (event: T) => unknown, thisArg?: unknown, disposables?: IDisposable[]): IDisposable;
}

/** The client-facing channel contract. Calls always carry the complete argument array. */
export interface IChannel {
  call<T>(command: string, args?: unknown[]): Promise<T>;
  listen<T>(event: string, arg?: unknown): Event<T>;
}
