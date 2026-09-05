import { createActor, type ActorLogic, type AnyActorRef, type Snapshot } from 'xstate';

import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { DurableAgentRuntimeParticipant } from '#/state/eventDispatcher';
import type { StateFold } from '#/state/state';

export interface AgentActorContext<State> {
  readonly agent: AgentContext;
  get<T>(id: ServiceIdentifier<T>): T;
  getState(): State;
  getLogicState<T>(): T;
  dispatch(event: Event2<any>): Promise<void>;
  send(event: unknown): void;
  readonly onDidChange: Event<State>;
}

export interface AgentActorRestoreEvent {
  readonly type: 'runtime.restore';
  waitUntil(work: Promise<unknown>): void;
}

export interface AgentActorDurable<State> {
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
  readonly transition: StateFold<State>;
  read(snapshot: Snapshot<unknown>): State;
  commit(actor: AnyActorRef, state: State): void;
}

export interface AgentActorOptions<State> {
  readonly id: string;
  readonly input?: unknown;
  readonly durable?: AgentActorDurable<State>;
}

export abstract class AgentActorService<State> extends Disposable {
  constructor(
    private readonly dispatcher: IEventDispatcher,
    private readonly scopeContext: IAgentScopeContext,
    private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  protected attachActor(
    logic: ActorLogic<any, any, any>,
    options: AgentActorOptions<State>,
  ): AgentActorContext<State> {
    const durable = options.durable;
    const listeners = new Set<(state: State) => void>();
    let actor!: AnyActorRef;
    const context: AgentActorContext<State> = {
      agent: this.scopeContext.agentContext,
      get: (id) => this.instantiation.invokeFunction((accessor) => accessor.get(id)),
      getState: () => {
        if (durable === undefined) {
          throw new BugIndicatingError(`Agent actor '${options.id}' has no durable state`);
        }
        return durable.read(actor.getSnapshot());
      },
      getLogicState: <T>() => actor.getSnapshot().context as T,
      dispatch: (event) => this.dispatcher.dispatch(event),
      send: (event) => { actor.send(event); },
      onDidChange: (listener) => {
        listeners.add(listener);
        return toDisposable(() => { listeners.delete(listener); });
      },
    };
    actor = createActor(logic, { input: options.input ?? context });
    let previous: State | undefined;
    const subscription = actor.subscribe({
      next: (snapshot) => {
        if (durable === undefined) return;
        const next = durable.read(snapshot);
        if (Object.is(previous, next)) return;
        if (previous !== undefined) {
          for (const listener of listeners) listener(next);
        }
        previous = next;
      },
    });
    actor.start();
    previous = durable?.read(actor.getSnapshot());
    let attachment: IDisposable | undefined;
    const participant: DurableAgentRuntimeParticipant<State> | undefined =
      durable === undefined
        ? undefined
        : {
            id: options.id,
            events: durable.events,
            undoable: durable.undoable,
            transition: durable.transition,
            getState: () => durable.read(actor.getSnapshot()),
            commit: (state) => { durable.commit(actor, state); },
          };
    let disposed = false;
    const sendRestore = async (): Promise<void> => {
      const readiness: Promise<unknown>[] = [];
      const event: AgentActorRestoreEvent = {
        type: 'runtime.restore',
        waitUntil: (work) => { readiness.push(work); },
      };
      actor.send(event);
      await Promise.all(readiness);
    };
    let restoreHook: IDisposable | undefined;
    if (this.dispatcher.restorePhase === 'ready') {
      queueMicrotask(() => {
        void (async () => {
          try {
            if (participant !== undefined) {
              const late = await this.dispatcher.attachLate(participant);
              if (disposed) {
                late.dispose();
                return;
              }
              attachment = late;
            }
            if (!disposed) await sendRestore();
          } catch (error) {
            onUnexpectedError(error);
          }
        })();
      });
    } else {
      if (participant !== undefined) {
        attachment = this.dispatcher.attach(participant);
      }
      restoreHook = this.dispatcher.hooks.onDidRestore.register(
        options.id,
        async (_ctx, next) => {
          await sendRestore();
          await next();
        },
      );
    }
    this._register(toDisposable(() => {
      disposed = true;
      attachment?.dispose();
      restoreHook?.dispose();
      subscription.unsubscribe();
      actor.stop();
    }));
    return context;
  }
}
