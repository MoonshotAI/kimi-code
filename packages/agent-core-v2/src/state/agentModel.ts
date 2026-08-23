import type { z } from 'zod';
import type { Draft } from 'immer';

import { collection } from '#/_base/di/collection';
import { BugIndicatingError } from '#/_base/errors/errors';
import type { StateKey } from '#/_base/state/stateRegistry';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { registerEvent2Class, type Event2, type Event2Class } from '#/app/event/event2';

import type { FoldContext } from './state';

export interface DomainResourceRuntime {
  dispose(): void | Promise<void>;
  abort?(reason?: unknown): void;
}

export interface AgentModelBridge {
  dispatch(event: Event2<any>): Promise<void>;
  readLegacy(key: StateKey<any>): unknown;
  initialState(): unknown;
}

export interface AgentModelContext {
  readonly agent: AgentContext;
  readonly bridge: AgentModelBridge;
}

interface ModelWindow {
  readonly draft: unknown;
  readonly ctx: FoldContext;
  replaced: boolean;
  replacement: unknown;
}

/**
 * Base class of an agent-granular domain Model — the container of one
 * domain's replayable state. Subclasses register appliers in the constructor
 * via `this.on(EventClass, applier)`; the host runs each applier inside an
 * infra-controlled immer window where `this.state` is the mutable draft.
 * Outside the window `this.state` is the last committed frozen snapshot.
 */
export abstract class AgentModel<S> implements DomainResourceRuntime {
  private committedState: S;
  private window: ModelWindow | undefined;
  private readonly appliers = new Map<Event2Class<any, any>, (event: any) => void>();
  private sealed = false;

  readonly agent: AgentContext;
  private readonly bridge: AgentModelBridge;

  constructor(context: AgentModelContext) {
    this.agent = context.agent;
    this.bridge = context.bridge;
    this.committedState = context.bridge.initialState() as S;
  }

  protected get state(): Draft<S> {
    const window = this.window;
    return (window !== undefined ? window.draft : this.committedState) as Draft<S>;
  }

  protected set state(value: S) {
    if (this.window === undefined) {
      throw new BugIndicatingError(
        `Model '${this.constructor.name}' can only replace state inside an applier`,
      );
    }
    this.window.replaced = true;
    this.window.replacement = value;
  }

  protected on<P, E extends Event2<P>>(cls: Event2Class<P, E>, applier: (event: E) => void): void {
    if (this.sealed) {
      throw new BugIndicatingError(
        `Model '${this.constructor.name}' cannot register appliers after construction`,
      );
    }
    if (this.appliers.has(cls)) {
      throw new BugIndicatingError(
        `Model '${this.constructor.name}' already applies event '${cls.type}'`,
      );
    }
    this.appliers.set(cls, applier as (event: any) => void);
  }

  protected emit(event: Event2<any>): Promise<void> {
    const window = this.window;
    if (window !== undefined) {
      window.ctx.emit(event);
      return Promise.resolve();
    }
    return this.bridge.dispatch(event);
  }

  protected readLegacy<T>(key: StateKey<T>): T {
    return this.bridge.readLegacy(key) as T;
  }

  onUndo?(count: number): void;

  dispose(): void | Promise<void> {}

  _seal(): void {
    this.sealed = true;
  }

  _appliersTable(): ReadonlyMap<Event2Class<any, any>, (event: any) => void> {
    return this.appliers;
  }

  _state(): S {
    return this.committedState;
  }

  _commitState(next: S): void {
    this.committedState = next;
  }

  _enterWindow(draft: S, ctx: FoldContext): void {
    this.window = { draft, ctx, replaced: false, replacement: undefined };
  }

  _exitWindow(): { readonly replaced: boolean; readonly replacement: unknown } {
    const window = this.window;
    this.window = undefined;
    return { replaced: window?.replaced ?? false, replacement: window?.replacement };
  }
}

export interface AgentModelStateSpec<S> {
  readonly initial: () => S;
  readonly schema: z.ZodType<S>;
}

export interface AgentModelDefinition<S = any, M extends AgentModel<S> = AgentModel<S>> {
  readonly id: string;
  readonly model: new (context: AgentModelContext) => M;
  readonly state: AgentModelStateSpec<S>;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
}

export interface AgentModelDefinitionInput<S, M extends AgentModel<S>> {
  readonly id: string;
  readonly model: new (context: AgentModelContext) => M;
  readonly state: AgentModelStateSpec<S>;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable?: boolean;
}

const AGENT_MODEL_DEFINITIONS = new Map<string, AgentModelDefinition<any, any>>();

/**
 * Declares one domain's agent-granular Model: the Model class, its state
 * spec, and the static durable-event vocabulary its appliers cover. The
 * returned definition is the token used with `AgentContext.space.use(...)`
 * and `Feature.contributeAgentModel(...)`.
 */
export function defineAgentModel<S, M extends AgentModel<S>>(
  input: AgentModelDefinitionInput<S, M>,
): AgentModelDefinition<S, M> {
  if (AGENT_MODEL_DEFINITIONS.has(input.id)) {
    throw new BugIndicatingError(`Agent model '${input.id}' is already defined`);
  }
  for (const cls of input.events) {
    if (!cls.durable) {
      throw new BugIndicatingError(
        `Agent model '${input.id}' cannot apply non-durable event '${cls.type}'`,
      );
    }
    registerEvent2Class(cls);
  }
  const definition: AgentModelDefinition<S, M> = Object.freeze({
    id: input.id,
    model: input.model,
    state: input.state,
    events: Object.freeze([...input.events]),
    undoable: input.undoable ?? false,
  });
  AGENT_MODEL_DEFINITIONS.set(definition.id, definition);
  return definition;
}

export function agentModelDefinitions(): readonly AgentModelDefinition<any, any>[] {
  return [...AGENT_MODEL_DEFINITIONS.values()];
}

export const AgentModelContribution = collection<AgentModelDefinition<any, any>>('agent-model', {
  validate: (value, existing) => {
    if (existing.some((definition) => definition.id === value.id)) {
      throw new Error(`Agent model '${value.id}' already has an active provider`);
    }
  },
});

export interface SessionModelDefinition<State = unknown> {
  readonly id: string;
  readonly state: AgentModelStateSpec<State>;
  readonly events: readonly Event2Class<any, any>[];
  readonly undoable: boolean;
}

export const SessionModelContribution = collection<SessionModelDefinition>('session-model', {
  validate: (value, existing) => {
    if (existing.some((definition) => definition.id === value.id)) {
      throw new Error(`Session model '${value.id}' already has an active provider`);
    }
  },
});
