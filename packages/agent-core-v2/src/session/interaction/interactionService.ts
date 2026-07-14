/**
 * `interaction` domain (L6) — `ISessionInteractionService` implementation.
 *
 * Owns the pending interaction set and resolves requests when a response
 * arrives; announces add/remove through a typed `onDidChangePending`. Bound at
 * Session scope.
 */

import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
  ISessionInteractionService,
} from './interaction';

interface Pending {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;

export class SessionInteractionService extends Disposable implements ISessionInteractionService {
  declare readonly _serviceBrand: undefined;

  private readonly pending = new Map<string, Pending>();
  private readonly recentlyResolved = new Map<string, number>();
  private readonly _onDidChangePending = this._register(new Emitter<InteractionPendingChangedEvent>());
  readonly onDidChangePending: Event<InteractionPendingChangedEvent> = this._onDidChangePending.event;
  private readonly _onDidResolve = this._register(new Emitter<InteractionResolution>());
  readonly onDidResolve: Event<InteractionResolution> = this._onDidResolve.event;
  private nextId = 0;

  constructor() {
    super();
  }

  cancelPendingForTurn(turnId: number): void {
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (entry.interaction.origin?.turnId !== turnId) continue;
      this.pending.delete(id);
      this.rememberResolved(id);
      const response = { cancelled: true, reason: 'turn_ended' };
      entry.resolve(response);
      this._onDidResolve.fire({ id, response });
      changed = true;
    }
    if (changed) {
      this._onDidChangePending.fire({ pending: [...this.pending.keys()] });
    }
  }

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      this.park(req, resolve as (response: unknown) => void);
    });
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return this.park(req, () => {});
  }

  respond(id: string, response: unknown): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    this.rememberResolved(id);
    entry.resolve(response);
    this._onDidChangePending.fire({ pending: [...this.pending.keys()] });
    this._onDidResolve.fire({ id, response });
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const all = [...this.pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
  }

  isRecentlyResolved(id: string): boolean {
    const resolvedAt = this.recentlyResolved.get(id);
    if (resolvedAt === undefined) return false;
    if (Date.now() - resolvedAt > RECENTLY_RESOLVED_TTL_MS) {
      this.recentlyResolved.delete(id);
      return false;
    }
    return true;
  }

  private park<TPayload>(
    req: InteractionRequest<TPayload>,
    resolve: (response: unknown) => void,
  ): Interaction {
    const id = req.id ?? this.generateId();
    const origin: InteractionOrigin = req.origin ?? {};
    const interaction: Interaction<TPayload> = {
      id,
      kind: req.kind,
      payload: req.payload,
      origin,
      createdAt: Date.now(),
    };
    this.pending.set(id, { interaction, resolve });
    this._onDidChangePending.fire({ pending: [...this.pending.keys()] });
    return interaction;
  }

  private rememberResolved(id: string): void {
    const now = Date.now();
    for (const [key, resolvedAt] of this.recentlyResolved) {
      if (now - resolvedAt > RECENTLY_RESOLVED_TTL_MS) this.recentlyResolved.delete(key);
    }
    while (this.recentlyResolved.size >= RECENTLY_RESOLVED_MAX) {
      const oldest = this.recentlyResolved.keys().next().value;
      if (oldest === undefined) break;
      this.recentlyResolved.delete(oldest);
    }
    this.recentlyResolved.set(id, now);
  }

  private generateId(): string {
    return `interaction-${this.nextId++}`;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionInteractionService,
  SessionInteractionService,
  InstantiationType.Delayed,
  'interaction',
);
