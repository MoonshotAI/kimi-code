import { Emitter, type Event } from '#/_base/event';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';

import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionStateService } from '#/session/state/sessionState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionPendingChangedEvent,
  type InteractionRequest,
  type InteractionResolution,
  ISessionInteractionService,
} from './interaction';
import {
  InteractionRequestEvent,
  InteractionResolvedEvent,
} from './interactionOps';

interface Pending {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;
const MAIN_AGENT_ID = 'main';

export const interactionPendingKey = defineState<Map<string, Pending>>(
  'interaction.pending',
  () => new Map(),
);
export const interactionRecentlyResolvedKey = defineState<Map<string, number>>(
  'interaction.recentlyResolved',
  () => new Map(),
);
export const interactionNextIdKey = defineState<number>('interaction.nextId', () => 0);

export class SessionInteractionService extends Service implements ISessionInteractionService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangePending = this._register(new Emitter<InteractionPendingChangedEvent>());
  readonly onDidChangePending: Event<InteractionPendingChangedEvent> = this._onDidChangePending.event;
  private readonly _onDidResolve = this._register(new Emitter<InteractionResolution>());
  readonly onDidResolve: Event<InteractionResolution> = this._onDidResolve.event;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
  ) {
    super();
    this.states.contributeState(interactionPendingKey);
    this.states.contributeState(interactionRecentlyResolvedKey);
    this.states.contributeState(interactionNextIdKey);
  }

  private get pending(): Map<string, Pending> {
    return this.states.get(interactionPendingKey);
  }

  private get recentlyResolved(): Map<string, number> {
    return this.states.get(interactionRecentlyResolvedKey);
  }

  private get nextId(): number {
    return this.states.get(interactionNextIdKey);
  }

  private set nextId(value: number) {
    this.states.set(interactionNextIdKey, value);
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
    const dispatcher = this.originDispatcher(interaction.origin);
    if (dispatcher === undefined) return;
    void dispatcher.dispatch(
      new InteractionRequestEvent({
        id: interaction.id,
        kind: interaction.kind,
        toolCallId: readPayloadToolCallId(interaction.payload),
        agentId: interaction.origin.agentId,
        request: interaction.payload,
      }),
    );
  }

  private recordResolved(id: string, response: unknown, origin: InteractionOrigin): void {
    const dispatcher = this.originDispatcher(origin);
    if (dispatcher === undefined) return;
    void dispatcher.dispatch(new InteractionResolvedEvent({ id, response }));
  }

  private originDispatcher(origin: InteractionOrigin): IEventDispatcher | undefined {
    if (this.instantiation === undefined) return undefined;
    const agentId = origin.agentId ?? MAIN_AGENT_ID;
    try {
      return this.instantiation.invokeFunction(
        (accessor) =>
          accessor.get(IAgentLifecycleService).get(agentId)?.accessor.get(IEventDispatcher),
      );
    } catch {
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
  ScopeActivation.OnScopeCreated,
  'interaction',
);
