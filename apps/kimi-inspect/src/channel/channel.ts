/**
 * Transport-agnostic channel contract for the debug-RPC client — the
 * old-klient / VS Code `ProxyChannel` model: the channel is bound to one
 * Service (the URL carries the scope + the Service's decorator id) and
 * `command` is the method name, invoked by reflection on the server.
 *
 * `listen` is kept for contract completeness (Service `onXxx` emitters map to
 * it), but the `/api/v1/debug` surface is HTTP-only — the v2 event socket
 * (`/api/v2/ws`) that used to serve it was removed — so the HTTP channel's
 * `listen` throws and panels fetch on demand instead.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

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

/** A wire Service reference: a DI decorator (stringifies to the wire channel
 * name) or the raw channel name as a string. */
export type ServiceRef<T> = ServiceIdentifier<T> | string;

/**
 * Remote view of a Service contract: every method becomes an async wire call;
 * `onXxx` event members (`Event<T>` — callables returning `IDisposable`) stay
 * subscribable events; plain non-function members become zero-arg property
 * reads (the dispatcher returns non-function members as-is).
 */
export type ServiceProxy<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? R extends IDisposable
      ? T[K]
      : (...args: A) => Promise<Awaited<R>>
    : () => Promise<Awaited<T[K]>>;
};
