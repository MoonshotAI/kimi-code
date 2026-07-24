/**
 * `interaction` domain (L6) — `ISessionInteractionService` implementation.
 *
 * Owns the pending interaction set and resolves requests when a response
 * arrives; announces add/remove through a typed `onDidChangePending`. Every
 * request/resolution is also journaled as a persisted `interaction.request` /
 * `interaction.resolved` Op on the ORIGIN agent's wire (`origin.agentId ??
 * 'main'`), so the journal can rebuild interaction entities on a cold
 * transcript fold. `IAgentLifecycleService` is resolved lazily at dispatch
 * time (via `IInstantiationService.invokeFunction`) because the lifecycle
 * service already depends on this kernel for turn-end cancellation — a
 * constructor edge would close a DI cycle. Direct construction without a
 * container (tests, embeddings) simply skips the journaling. The kernel's
 * pending semantics stay memory-only: pending promises are never restored
 * from the journal. Bound at Session scope.
 */

import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IWireService } from '#/wire/wire';

import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
  ISessionInteractionService,
} from './interaction';
import { interactionRequest, interactionResolved } from './interactionOps';

interface Pending {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;
const MAIN_AGENT_ID = 'main';

export class SessionInteractionService extends Disposable implements ISessionInteractionService {
  declare readonly _serviceBrand: undefined;

  private readonly pending = new Map<string, Pending>();
  private readonly recentlyResolved = new Map<string, number>();
  private readonly _onDidChangePending = this._register(new Emitter<InteractionPendingChangedEvent>());
  readonly onDidChangePending: Event<InteractionPendingChangedEvent> = this._onDidChangePending.event;
  private readonly _onDidResolve = this._register(new Emitter<InteractionResolution>());
  readonly onDidResolve: Event<InteractionResolution> = this._onDidResolve.event;
  private nextId = 0;

  constructor(
    @IInstantiationService private readonly instantiation?: IInstantiationService,
  ) {
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
      this.recordResolved(id, response, entry.interaction.origin);
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
    this.recordResolved(id, response, entry.interaction.origin);
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
    this.recordRequest(interaction);
    this._onDidChangePending.fire({ pending: [...this.pending.keys()] });
    return interaction;
  }

  private recordRequest(interaction: Interaction): void {
    const wire = this.originWire(interaction.origin);
    if (wire === undefined) return;
    wire.dispatch(
      interactionRequest({
        id: interaction.id,
        kind: interaction.kind,
        toolCallId: readPayloadToolCallId(interaction.payload),
        agentId: interaction.origin.agentId,
        request: interaction.payload,
      }),
    );
  }

  private recordResolved(id: string, response: unknown, origin: InteractionOrigin): void {
    const wire = this.originWire(origin);
    if (wire === undefined) return;
    wire.dispatch(interactionResolved({ id, response }));
  }

  private originWire(origin: InteractionOrigin): IWireService | undefined {
    if (this.instantiation === undefined) return undefined;
    const agentId = origin.agentId ?? MAIN_AGENT_ID;
    try {
      return this.instantiation.invokeFunction(
        (accessor) => accessor.get(IAgentLifecycleService).get(agentId)?.accessor.get(IWireService),
      );
    } catch {
      // Journaling is best-effort: a partial scope without the agent
      // lifecycle (test hosts, embeddings) must not break the kernel.
      return undefined;
    }
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

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionInteractionService,
  SessionInteractionService,
  InstantiationType.Eager,
  'interaction',
);
