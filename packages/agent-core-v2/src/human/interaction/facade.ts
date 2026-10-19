import { createActor, type ActorRefFrom } from '#/xstate2';

import type {
  Interaction,
  InteractionCancellation,
  InteractionPendingChangedEvent,
  InteractionQuery,
  InteractionRequest,
  InteractionResolution,
  InteractionTags,
} from './interaction';
import { INTERACTION_TAG_AGENT_ID, INTERACTION_TAG_SESSION_ID } from './interaction';
import type { InteractionEmitted, InteractionRecord } from './machine';
import { createInteractionMachine } from './machine';

export type InteractionActor = ActorRefFrom<ReturnType<typeof createInteractionMachine>>;

export type InteractionAgentDispatch = (event: InteractionEmitted) => void;

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

interface Waiter {
  readonly resolve: (response: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

export interface InteractionFacade {
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): boolean;
  findAll(query?: InteractionQuery): readonly Interaction[];
  findOne(query: InteractionQuery): Interaction | undefined;
  wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse>;
  onDidChangePending(listener: (event: InteractionPendingChangedEvent) => void): () => void;
  onDidResolve(listener: (event: InteractionResolution) => void): () => void;
  attachAgent(agentId: string, sessionId: string, dispatch: InteractionAgentDispatch): void;
  detachAgent(agentId: string, sessionId: string): void;
  purgeSession(sessionId: string): void;
  stop(): void;
}

function matches(record: InteractionRecord, query: InteractionQuery): boolean {
  if (query.id !== undefined && record.id !== query.id) return false;
  if (query.kind !== undefined && record.kind !== query.kind) return false;
  if (query.resolved !== undefined && record.resolved !== query.resolved) return false;
  if (query.tags !== undefined) {
    for (const [key, value] of Object.entries(query.tags)) {
      if (record.tags[key] !== value) return false;
    }
  }
  return true;
}

export function createInteractionFacade(
  actor: InteractionActor,
  input?: { now?: () => number },
): InteractionFacade {
  const now = input?.now ?? Date.now;
  const waiters = new Map<string, Waiter[]>();
  const recentlyResolved = new Map<string, number>();
  const changeListeners = new Set<(event: InteractionPendingChangedEvent) => void>();
  const resolveListeners = new Set<(event: InteractionResolution) => void>();
  const agentDispatchers = new Map<string, InteractionAgentDispatch>();
  let nextId = 0;

  const records = (): Map<string, InteractionRecord> => actor.getSnapshot().context.records;

  const pendingIds = (): string[] =>
    [...records().values()].filter((record) => !record.resolved).map((record) => record.id);

  const firePendingChanged = (): void => {
    const event: InteractionPendingChangedEvent = { pending: pendingIds() };
    for (const listener of changeListeners) listener(event);
  };

  const settleWaiters = (id: string, response: unknown): void => {
    const entries = waiters.get(id);
    if (entries === undefined) return;
    waiters.delete(id);
    for (const waiter of entries) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  };

  const evictResolved = (id: string): void => {
    recentlyResolved.delete(id);
    actor.send({ type: 'interaction.evict', id });
  };

  const rememberResolved = (id: string): void => {
    const at = now();
    for (const [key, resolvedAt] of recentlyResolved) {
      if (at - resolvedAt > RECENTLY_RESOLVED_TTL_MS) evictResolved(key);
    }
    while (recentlyResolved.size >= RECENTLY_RESOLVED_MAX) {
      const oldest = recentlyResolved.keys().next().value;
      if (oldest === undefined) break;
      evictResolved(oldest);
    }
    recentlyResolved.set(id, at);
  };

  const dispatchToAgent = (tags: InteractionTags, event: InteractionEmitted): void => {
    const agentId = tags[INTERACTION_TAG_AGENT_ID];
    const sessionId = tags[INTERACTION_TAG_SESSION_ID];
    if (typeof agentId !== 'string' || typeof sessionId !== 'string') return;
    agentDispatchers.get(`${sessionId}:${agentId}`)?.(event);
  };

  const requestedSubscription = actor.on('interaction.requested', (event) => {
    dispatchToAgent(event.record.tags, event);
  });

  const subscription = actor.on('interaction.resolved', (event) => {
    settleWaiters(event.id, event.response);
    rememberResolved(event.id);
    dispatchToAgent(event.record.tags, event);
    const resolution: InteractionResolution = { id: event.id, response: event.response };
    for (const listener of resolveListeners) listener(resolution);
  });

  const facade: InteractionFacade = {
    request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
      const interaction = facade.enqueue(req);
      return facade.wait<TResponse>(interaction.id);
    },

    enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
      const agentId = req.tags?.[INTERACTION_TAG_AGENT_ID];
      const id = req.id ?? (agentId === undefined ? `interaction-${nextId++}` : `${String(agentId)}:interaction-${nextId++}`);
      const existing = records().get(id);
      if (existing !== undefined && !existing.resolved) {
        throw new Error(`Interaction "${id}" is already pending`);
      }
      const interaction: Interaction<TPayload> = {
        id,
        kind: req.kind,
        payload: req.payload,
        tags: req.tags ?? {},
        createdAt: now(),
      };
      actor.send({ type: 'interaction.request', record: { ...interaction, resolved: false } });
      firePendingChanged();
      return interaction;
    },

    respond(id: string, response: unknown): boolean {
      const record = records().get(id);
      if (record === undefined || record.resolved) return false;
      actor.send({ type: 'interaction.resolve', id, response });
      firePendingChanged();
      return true;
    },

    findAll(query: InteractionQuery = {}): readonly Interaction[] {
      return [...records().values()].filter((record) => matches(record, query));
    },

    findOne(query: InteractionQuery): Interaction | undefined {
      return [...records().values()].find((record) => matches(record, query));
    },

    wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse> {
      const record = records().get(id);
      if (record === undefined) {
        return Promise.reject(new Error(`Interaction "${id}" does not exist`));
      }
      if (record.resolved) return Promise.resolve(record.response as TResponse);
      return new Promise<TResponse>((resolve, reject) => {
        const waiter: Waiter = {
          resolve: resolve as (response: unknown) => void,
          reject,
          timer:
            opts?.timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                  const entries = waiters.get(id);
                  if (entries !== undefined) {
                    const remaining = entries.filter((entry) => entry !== waiter);
                    if (remaining.length === 0) waiters.delete(id);
                    else waiters.set(id, remaining);
                  }
                  reject(new Error(`Timed out waiting for interaction "${id}"`));
                }, opts.timeoutMs),
        };
        const entries = waiters.get(id);
        if (entries === undefined) waiters.set(id, [waiter]);
        else entries.push(waiter);
      });
    },

    onDidChangePending(listener: (event: InteractionPendingChangedEvent) => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    onDidResolve(listener: (event: InteractionResolution) => void): () => void {
      resolveListeners.add(listener);
      return () => {
        resolveListeners.delete(listener);
      };
    },

    attachAgent(agentId: string, sessionId: string, dispatch: InteractionAgentDispatch): void {
      agentDispatchers.set(`${sessionId}:${agentId}`, dispatch);
    },

    detachAgent(agentId: string, sessionId: string): void {
      agentDispatchers.delete(`${sessionId}:${agentId}`);
    },

    purgeSession(sessionId: string): void {
      const purged = [...records().values()].filter(
        (record) => record.tags[INTERACTION_TAG_SESSION_ID] === sessionId,
      );
      for (const record of purged) {
        if (record.resolved) continue;
        const response: InteractionCancellation = { cancelled: true, reason: 'agent_closed' };
        facade.respond(record.id, response);
      }
      actor.send({ type: 'interaction.purge', sessionId });
      for (const record of purged) recentlyResolved.delete(record.id);
      for (const key of agentDispatchers.keys()) {
        if (key.startsWith(`${sessionId}:`)) agentDispatchers.delete(key);
      }
    },

    stop(): void {
      for (const record of records().values()) {
        if (record.resolved) continue;
        const response: InteractionCancellation = { cancelled: true, reason: 'agent_closed' };
        actor.send({ type: 'interaction.resolve', id: record.id, response });
      }
      requestedSubscription.unsubscribe();
      subscription.unsubscribe();
      changeListeners.clear();
      resolveListeners.clear();
      agentDispatchers.clear();
    },
  };
  return facade;
}

export const interactions: InteractionFacade = createDefaultInteractionFacade();

function createDefaultInteractionFacade(): InteractionFacade {
  const actor = createActor(createInteractionMachine());
  actor.start();
  return createInteractionFacade(actor);
}
