/**
 * `/api/v1/debug` channel transport — shared, transport-agnostic primitives.
 *
 * A request carries a scope path + a `<service>/<method>` pair: the channel
 * registry resolves `service` (a decorator id) to a Service, and `method` is
 * invoked by reflection. This file holds only the small pieces shared by the
 * server dispatcher and clients.
 */

/** Which scope a route resolves before dispatching. */
export type ScopeKind = 'core' | 'session' | 'agent';

/** The client-facing channel contract (request/response + future events). */
export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>;
  listen(event: string, arg?: unknown): unknown;
}
