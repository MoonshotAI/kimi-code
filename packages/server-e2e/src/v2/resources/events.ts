/**
 * Typed `/api/v2/ws` event subscriptions.
 *
 * Wraps a {@link V2Socket} with one method per event the server exposes
 * (see `server-v2/src/transport/ws/eventMap.ts`):
 *   core    `events`                  — process-wide domain event bus
 *   session `interactions`            — pending human-in-the-loop requests
 *   session `interactions:resolved`   — request resolutions
 *   agent   `events`                  — per-agent event stream
 *
 * Payloads are typed as `unknown` by default (the concrete unions live in
 * `agent-core-v2`, which this wire client does not depend on); pass a type
 * parameter to narrow.
 */
import type { RpcError } from '../errors.js';
import type { ScopeKind, ScopeParams } from '../transport/http.js';
import type { V2Socket } from '../transport/ws.js';

/** An `unlisten` handle — call it to stop receiving events. */
export type Unlisten = () => void;

export class EventsClient {
  constructor(private readonly socket: V2Socket) {}

  /** Generic listen — prefer the typed helpers below. */
  listen<T = unknown>(
    scope: ScopeKind,
    params: ScopeParams,
    event: string,
    handler: (data: T) => void,
    onError?: (err: RpcError) => void,
  ): Unlisten {
    return this.socket.listen(
      scope,
      params,
      event,
      (data) => handler(data as T),
      onError,
    );
  }

  /** Subscribe to the core (process-wide) domain event bus. */
  onCoreEvents<T = unknown>(handler: (data: T) => void): Unlisten {
    return this.listen('core', {}, 'events', handler);
  }

  /** Subscribe to a session's pending human-in-the-loop interactions. */
  onSessionInteractions<T = unknown>(sessionId: string, handler: (data: T) => void): Unlisten {
    return this.listen('session', { sessionId }, 'interactions', handler);
  }

  /** Subscribe to a session's interaction resolutions. */
  onSessionInteractionsResolved<T = unknown>(
    sessionId: string,
    handler: (data: T) => void,
  ): Unlisten {
    return this.listen('session', { sessionId }, 'interactions:resolved', handler);
  }

  /** Subscribe to an agent's event stream. */
  onAgentEvents<T = unknown>(
    sessionId: string,
    agentId: string,
    handler: (data: T) => void,
  ): Unlisten {
    return this.listen('agent', { sessionId, agentId }, 'events', handler);
  }
}
