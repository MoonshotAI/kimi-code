/**
 * Multi-agent event merging for the v2 facade (`#/core`).
 *
 * `attachSessionEvents` fans in every agent's `IEventBus` (Agent scope) plus
 * the App-scope `IEventService` projection of `session.meta.updated` into a
 * single ordered `SessionEvent` stream, tracking agent creation/disposal via
 * the Session-scope `IAgentLifecycleService`.
 */

import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  MAIN_AGENT_ID,
  type DomainEvent,
  type GlobalEvent,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { SessionEvent } from './types';

/** Stamp routing context; payload stays verbatim (event types are not rewritten, D5). */
export function toSessionEvent(event: DomainEvent, sessionId: string, agentId: string): SessionEvent {
  // Controlled boundary cast: a stamped DomainEvent is the DomainEvent arm of SessionEvent.
  return { ...event, agentId, sessionId } as SessionEvent;
}

/** `session.meta.updated` on the app bus → this session's SessionEvent; anything else → undefined. */
export function projectSessionMetaEvent(event: GlobalEvent, sessionId: string): SessionEvent | undefined {
  if (event.type !== 'session.meta.updated') return undefined;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; agentId?: unknown; title?: unknown; patch?: unknown };
  if (candidate.sessionId !== sessionId) return undefined;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const patch = typeof candidate.patch === 'object' && candidate.patch !== null && !Array.isArray(candidate.patch)
    ? (candidate.patch as Record<string, unknown>) : undefined;
  if (title === undefined && patch === undefined) return undefined;
  const agentId = typeof candidate.agentId === 'string' ? candidate.agentId : MAIN_AGENT_ID;
  // Controlled boundary cast: the narrowed literal is the meta arm of SessionEvent.
  return { type: 'session.meta.updated', title, patch, agentId, sessionId } as SessionEvent;
}

export function attachSessionEvents(args: {
  session: ISessionScopeHandle;
  sessionId: string;
  app: Scope;
  emit: (event: SessionEvent) => void;
}): () => void {
  const { session, sessionId, app, emit } = args;
  const queue: SessionEvent[] = [];
  let flushing = false;
  let detached = false;
  const deliver = (event: SessionEvent): void => {
    if (detached) return;
    queue.push(event);
    if (flushing) return;
    flushing = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        try { emit(next); } catch { /* a listener error must not break the stream */ }
      }
    } finally { flushing = false; }
  };

  const agents = session.accessor.get(IAgentLifecycleService);
  const agentSubscriptions = new Map<string, IDisposable>();
  const subscribeAgent = (handle: IAgentScopeHandle): void => {
    if (agentSubscriptions.has(handle.id)) return;
    const bus = handle.accessor.get(IEventBus);
    agentSubscriptions.set(handle.id, bus.subscribe((event: DomainEvent) => {
      deliver(toSessionEvent(event, sessionId, handle.id));
    }));
  };
  for (const handle of agents.list()) subscribeAgent(handle);
  const lifecycleSubscriptions: IDisposable[] = [
    agents.onDidCreate((handle) => { subscribeAgent(handle); }),
    agents.onDidDispose((agentId) => {
      agentSubscriptions.get(agentId)?.dispose();
      agentSubscriptions.delete(agentId);
    }),
  ];
  const globalSubscription = app.accessor.get(IEventService).subscribe((event) => {
    const adapted = projectSessionMetaEvent(event, sessionId);
    if (adapted !== undefined) deliver(adapted);
  });

  return () => {
    if (detached) return;
    detached = true;
    globalSubscription.dispose();
    for (const d of lifecycleSubscriptions) d.dispose();
    for (const d of agentSubscriptions.values()) d.dispose();
    agentSubscriptions.clear();
    queue.length = 0;
  };
}
