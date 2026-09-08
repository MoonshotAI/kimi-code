export type ScopeKind = 'core' | 'session' | 'agent';

export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>;
  listen(event: string, arg?: unknown): unknown;
}
