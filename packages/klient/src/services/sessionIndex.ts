/**
 * Explicit, fully-typed `ISessionIndex` implementation over the HTTP channel.
 *
 * The hand-written counterpart to `makeProxy`: useful when a single interface
 * wants a named class, bespoke argument shaping, or a place to hang client-side
 * behavior. The injected `IChannel` must be bound to the `sessionIndex` scope
 * URL (`<base>/api/v2/sessionIndex`); methods are forwarded by name (`list` /
 * `get` / `countActive`). `ISessionIndex` carries only data methods (no `Event`
 * / stream / handle members), so it can be implemented faithfully.
 */

import type {
  ISessionIndex,
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type { Page } from '@moonshot-ai/agent-core-v2/persistence/interface/queryStore';

import type { IChannel } from '../channel.js';

export class SessionIndexClient implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly channel: IChannel) {}

  list(query: SessionListQuery): Promise<Page<SessionSummary>> {
    return this.channel.call<Page<SessionSummary>>('list', [query]);
  }

  get(id: string): Promise<SessionSummary | undefined> {
    return this.channel.call<SessionSummary | undefined>('get', [id]);
  }

  countActive(workspaceId: string): Promise<number> {
    return this.channel.call<number>('countActive', [workspaceId]);
  }
}
