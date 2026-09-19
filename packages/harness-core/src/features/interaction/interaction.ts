import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

export type InteractionKind = 'approval' | 'question' | 'user_tool';

export type InteractionTagValue = string | number;

export type InteractionTags = Record<string, InteractionTagValue>;

export const INTERACTION_TAG_AGENT_ID = 'agentId';
export const INTERACTION_TAG_SESSION_ID = 'sessionId';
export const INTERACTION_TAG_TURN_ID = 'turnId';
export const INTERACTION_TAG_TOOL_CALL_ID = 'toolCallId';

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly tags?: InteractionTags;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly tags: InteractionTags;
  readonly createdAt: number;
}

export interface InteractionRecord extends Interaction {
  readonly resolved: boolean;
  readonly response?: unknown;
}

export type InteractionCancellationReason = 'turn_ended' | 'agent_closed';

export interface InteractionCancellation {
  readonly cancelled: true;
  readonly reason: InteractionCancellationReason;
}

export function isInteractionCancellation(response: unknown): response is InteractionCancellation {
  if (typeof response !== 'object' || response === null) return false;
  const value = response as { readonly cancelled?: unknown; readonly reason?: unknown };
  return value.cancelled === true && (value.reason === 'turn_ended' || value.reason === 'agent_closed');
}

export interface InteractionRequestedEvent extends RuntimeEvent {
  readonly type: 'interaction.requested';
  readonly interaction: Interaction;
}

export interface InteractionResolvedEvent extends RuntimeEvent {
  readonly type: 'interaction.resolved';
  readonly id: string;
  readonly response: unknown;
  readonly interaction: Interaction;
}

export type InteractionEvent = InteractionRequestedEvent | InteractionResolvedEvent;

export interface InteractionQuery {
  readonly id?: string;
  readonly kind?: InteractionKind;
  readonly resolved?: boolean;
  readonly tags?: InteractionTags;
}

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

interface Waiter {
  readonly resolve: (response: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

export interface Interactions {
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): boolean;
  findAll(query?: InteractionQuery): readonly Interaction[];
  findOne(query: InteractionQuery): Interaction | undefined;
  wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse>;
  cancelAgent(agentId: string, reason: InteractionCancellation['reason']): void;
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

function toInteraction(record: InteractionRecord): Interaction {
  return {
    id: record.id,
    kind: record.kind,
    payload: record.payload,
    tags: record.tags,
    createdAt: record.createdAt,
  };
}

export function openInteractions(input?: {
  now?: () => number;
  fire?: (event: InteractionEvent) => void;
}): Interactions {
  const now = input?.now ?? Date.now;
  const fire = input?.fire;
  const records = new Map<string, InteractionRecord>();
  const waiters = new Map<string, Waiter[]>();
  const recentlyResolved = new Map<string, number>();
  let nextId = 0;

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
    const record = records.get(id);
    if (record?.resolved === true) records.delete(id);
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

  const resolve = (id: string, response: unknown): boolean => {
    const record = records.get(id);
    if (record === undefined || record.resolved) return false;
    const next: InteractionRecord = { ...record, resolved: true, response };
    records.set(id, next);
    settleWaiters(id, response);
    rememberResolved(id);
    fire?.({
      type: 'interaction.resolved',
      id,
      response,
      interaction: toInteraction(next),
    });
    return true;
  };

  const interactions: Interactions = {
    request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
      const item = interactions.enqueue(req);
      return interactions.wait<TResponse>(item.id);
    },

    enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
      const agentId = req.tags?.[INTERACTION_TAG_AGENT_ID];
      const id =
        req.id ??
        (agentId === undefined ? `interaction-${nextId++}` : `${String(agentId)}:interaction-${nextId++}`);
      const existing = records.get(id);
      if (existing !== undefined && !existing.resolved) {
        throw new Error(`Interaction "${id}" is already pending`);
      }
      const item: Interaction<TPayload> = {
        id,
        kind: req.kind,
        payload: req.payload,
        tags: req.tags ?? {},
        createdAt: now(),
      };
      records.set(id, { ...item, resolved: false });
      fire?.({ type: 'interaction.requested', interaction: item });
      return item;
    },

    respond(id: string, response: unknown): boolean {
      return resolve(id, response);
    },

    findAll(query: InteractionQuery = {}): readonly Interaction[] {
      return [...records.values()].filter((record) => matches(record, query));
    },

    findOne(query: InteractionQuery): Interaction | undefined {
      return [...records.values()].find((record) => matches(record, query));
    },

    wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse> {
      const record = records.get(id);
      if (record === undefined) {
        return Promise.reject(new Error(`Interaction "${id}" does not exist`));
      }
      if (record.resolved) return Promise.resolve(record.response as TResponse);
      return new Promise<TResponse>((resolveWaiter, reject) => {
        const waiter: Waiter = {
          resolve: resolveWaiter as (response: unknown) => void,
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

    cancelAgent(agentId: string, reason: InteractionCancellation['reason']): void {
      for (const record of [...records.values()]) {
        if (record.resolved) continue;
        if (record.tags[INTERACTION_TAG_AGENT_ID] !== agentId) continue;
        resolve(record.id, { cancelled: true, reason });
      }
    },

    stop(): void {
      const response: InteractionCancellation = { cancelled: true, reason: 'agent_closed' };
      for (const record of [...records.values()]) {
        if (record.resolved) continue;
        resolve(record.id, response);
      }
    },
  };
  return interactions;
}
