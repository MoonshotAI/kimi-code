import { createActor } from 'xstate';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import { ISessionEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { TurnEnded } from '#/agent/loop/turnOps';
import { Error2, ErrorCodes } from '#/errors';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  type Interaction,
  type InteractionCancellation,
  type InteractionPendingChangedEvent,
  type InteractionQuery,
  type InteractionRequest,
  type InteractionResolution,
  type InteractionTags,
} from '#/human/interaction/interaction';
import {
  createInteractionFacade,
  type InteractionActor,
  type InteractionFacade,
} from '#/human/interaction/facade';
import { createInteractionMachine } from '#/human/interaction/machine';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { InteractionRequestEvent, InteractionResolvedEvent } from './interactionOps';

export interface ISessionInteractionService {
  readonly _serviceBrand: undefined;
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): boolean;
  findAll(query?: InteractionQuery): readonly Interaction[];
  findOne(query: InteractionQuery): Interaction | undefined;
  wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse>;
  isRecentlyResolved(id: string): boolean;
  cancelForTurn(agentId: string, turnId: number): void;
}

export const ISessionInteractionService: ServiceIdentifier<ISessionInteractionService> =
  createDecorator<ISessionInteractionService>('sessionInteractionService');

function readStringTag(tags: InteractionTags, key: string): string | undefined {
  const value = tags[key];
  return typeof value === 'string' ? value : undefined;
}

function readPayloadToolCallId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)['toolCallId'];
  return typeof value === 'string' ? value : undefined;
}

export class SessionInteractionService extends Service implements ISessionInteractionService {
  declare readonly _serviceBrand: undefined;

  readonly onDidChangePending: ISessionInteractionService['onDidChangePending'];
  readonly onDidResolve: ISessionInteractionService['onDidResolve'];

  private readonly actor: InteractionActor;
  private readonly facade: InteractionFacade;

  constructor(
    @ISessionEventBus bus: ISessionEventBus,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {
    super();
    this.actor = createActor(createInteractionMachine());
    this.actor.start();
    this.facade = createInteractionFacade(this.actor);

    const changeEmitter = this._register(new Emitter<InteractionPendingChangedEvent>());
    const resolveEmitter = this._register(new Emitter<InteractionResolution>());
    this.onDidChangePending = changeEmitter.event;
    this.onDidResolve = resolveEmitter.event;
    const detachFacade = [
      this.facade.onDidChangePending((event) => changeEmitter.fire(event)),
      this.facade.onDidResolve((event) => resolveEmitter.fire(event)),
    ];
    this._register({ dispose: () => detachFacade.forEach((detach) => detach()) });

    const detachRequested = this.actor.on('interaction.requested', (event) => {
      const record = event.record;
      const agentId = readStringTag(record.tags, INTERACTION_TAG_AGENT_ID);
      if (agentId === undefined) return;
      const dispatcher = this.agents.handleOf(agentId)?.accessor.get(IEventDispatcher);
      void dispatcher?.dispatch(
        new InteractionRequestEvent({
          agentId,
          id: record.id,
          kind: record.kind,
          toolCallId:
            readStringTag(record.tags, INTERACTION_TAG_TOOL_CALL_ID) ??
            readPayloadToolCallId(record.payload),
          request: record.payload,
        }),
      );
    });
    const detachResolved = this.actor.on('interaction.resolved', (event) => {
      const agentId = readStringTag(event.record.tags, INTERACTION_TAG_AGENT_ID);
      if (agentId === undefined) return;
      const dispatcher = this.agents.handleOf(agentId)?.accessor.get(IEventDispatcher);
      void dispatcher?.dispatch(
        new InteractionResolvedEvent({ agentId, id: event.id, response: event.response }),
      );
    });
    this._register({
      dispose: () => {
        detachRequested.unsubscribe();
        detachResolved.unsubscribe();
      },
    });

    this._register(
      bus.subscribe(TurnEnded, (event) => {
        this.cancelForTurn(event.agentId, event.turnId);
      }),
    );
    this._register(
      this.agents.onDidClose((context) => {
        for (const interaction of this.facade.findAll({
          resolved: false,
          tags: { [INTERACTION_TAG_AGENT_ID]: context.agentId },
        })) {
          const response: InteractionCancellation = { cancelled: true, reason: 'agent_closed' };
          this.facade.respond(interaction.id, response);
        }
      }),
    );
    this._register({
      dispose: () => {
        this.facade.stop();
        this.actor.stop();
      },
    });
  }

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    const interaction = this.enqueue(req);
    return this.facade.wait<TResponse>(interaction.id);
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return this.facade.enqueue({ ...req, tags: this.resolveTags(req.tags) });
  }

  respond(id: string, response: unknown): boolean {
    return this.facade.respond(id, response);
  }

  findAll(query?: InteractionQuery): readonly Interaction[] {
    return this.facade.findAll(query);
  }

  findOne(query: InteractionQuery): Interaction | undefined {
    return this.facade.findOne(query);
  }

  wait<TResponse>(id: string, opts?: { timeoutMs?: number }): Promise<TResponse> {
    return this.facade.wait<TResponse>(id, opts);
  }

  isRecentlyResolved(id: string): boolean {
    return this.facade.isRecentlyResolved(id);
  }

  cancelForTurn(agentId: string, turnId: number): void {
    for (const interaction of this.facade.findAll({
      resolved: false,
      tags: { [INTERACTION_TAG_AGENT_ID]: agentId, turnId },
    })) {
      const response: InteractionCancellation = { cancelled: true, reason: 'turn_ended' };
      this.facade.respond(interaction.id, response);
    }
  }

  private resolveTags(tags: InteractionTags | undefined): InteractionTags {
    const agentId = tags?.[INTERACTION_TAG_AGENT_ID] ?? MAIN_AGENT_ID;
    if (this.agents.handleOf(String(agentId)) === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${String(agentId)}" does not exist`, {
        details: { agentId },
      });
    }
    return { ...tags, [INTERACTION_TAG_AGENT_ID]: agentId };
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionInteractionService,
  SessionInteractionService,
  ScopeActivation.OnScopeCreated,
  'interaction',
);
