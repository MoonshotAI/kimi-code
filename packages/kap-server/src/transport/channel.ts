export type ScopeKind = 'core' | 'session' | 'agent';

/** The client-facing channel contract (request/response + future events). */
export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>;
  listen(event: string, arg?: unknown): unknown;
}
