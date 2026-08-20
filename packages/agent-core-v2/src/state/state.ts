import { enableMapSet, enablePatches, type Draft, type Patch } from 'immer';
import type { z } from 'zod';

import { BugIndicatingError } from '#/_base/errors/errors';
import type { StateKey } from '#/_base/state/stateRegistry';
import { Event2, registerEvent2Class, type Event2Class } from '#/app/event/event2';
import type { PartsTransformer, RecordDehydrator } from '#/wire/record';

import { StateError, StateErrors } from './errors';

enableMapSet();
enablePatches();

export type { StateKey } from '#/_base/state/stateRegistry';
export type { PartsTransformer } from '#/wire/record';

export interface StateBlobCodec<S> {
  dehydrate: RecordDehydrator;
  rehydrate(state: S, transform: PartsTransformer): S | Promise<S>;
}

export interface FoldContext {
  readonly silent: boolean;
  checkpoint(): void;
  clearCheckpoints(): void;
  undoToCheckpoint(count: number): void;
  emit(event: Event2): void;
}

export type StateFold<S, E extends Event2<any> = Event2<any>> = (
  state: Draft<S>,
  event: E,
  ctx: FoldContext,
) => S | void;

export interface PatchEntry {
  readonly id: number;
  readonly eventType: string;
  readonly patches: readonly Patch[];
  readonly inversePatches: readonly Patch[];
}

export interface ReplayableOptions<S> {
  readonly schema: z.ZodType<S>;
  readonly durable?: boolean;
  readonly blobs?: StateBlobCodec<S>;
}

export interface UndoableOptions<S> {
  readonly onUndo?: (state: Draft<S>, count: number) => S | void;
}

export interface ReplayableStateMeta<S> {
  readonly schema: z.ZodType<S>;
  readonly durable: boolean;
  readonly blobs?: StateBlobCodec<S>;
  readonly undoable?: UndoableOptions<S>;
  readonly folds: ReadonlyMap<Event2Class<any, any>, StateFold<S, any>>;
}

export interface ReplayableStateKey<S> extends StateKey<DeepReadonly<S>> {
  readonly replayable: ReplayableStateMeta<S>;
  undoable(opts?: UndoableOptions<S>): ReplayableStateKey<S>;
  on<P, E extends Event2<P>>(cls: Event2Class<P, E>, fold: StateFold<S, E>): ReplayableStateKey<S>;
}

export interface StateKeyBuilder<T> extends StateKey<T> {
  replayable(opts: ReplayableOptions<T>): ReplayableStateKey<T>;
}

class ReplayableStateKeyImpl<S> implements ReplayableStateKey<S> {
  readonly snapshotExcluded = true;
  readonly initial: () => DeepReadonly<S>;

  private readonly meta: {
    readonly schema: z.ZodType<S>;
    readonly durable: boolean;
    readonly blobs?: StateBlobCodec<S>;
    undoable?: UndoableOptions<S>;
    readonly folds: Map<Event2Class<any, any>, StateFold<S, any>>;
  };

  constructor(
    readonly name: string,
    initial: () => S,
    opts: ReplayableOptions<S>,
  ) {
    this.initial = () => Object.freeze(initial()) as DeepReadonly<S>;
    this.meta = {
      schema: opts.schema,
      durable: opts.durable ?? true,
      blobs: opts.blobs,
      folds: new Map(),
    };
  }

  get replayable(): ReplayableStateMeta<S> {
    return this.meta;
  }

  undoable(opts?: UndoableOptions<S>): ReplayableStateKey<S> {
    if (this.meta.undoable !== undefined) {
      throw new BugIndicatingError(`State key '${this.name}' is already undoable`);
    }
    if (!this.meta.durable) {
      throw new BugIndicatingError(`Transient state key '${this.name}' cannot be undoable`);
    }
    this.meta.undoable = opts ?? {};
    return this;
  }

  on<P, E extends Event2<P>>(cls: Event2Class<P, E>, fold: StateFold<S, E>): ReplayableStateKey<S> {
    if (this.meta.folds.has(cls)) {
      throw new StateError(
        StateErrors.codes.STATE_DUPLICATE_FOLD,
        `State '${this.name}' already folds event '${cls.type}'`,
        { details: { state: this.name, type: cls.type } },
      );
    }
    if (!this.meta.durable && cls.durable) {
      throw new StateError(
        StateErrors.codes.STATE_DURABILITY_MISMATCH,
        `Transient state '${this.name}' cannot fold durable event '${cls.type}'`,
        { details: { state: this.name, type: cls.type } },
      );
    }
    registerEvent2Class(cls);
    this.meta.folds.set(cls, fold as StateFold<S, any>);
    return this;
  }
}

class StateKeyBuilderImpl<T> implements StateKeyBuilder<T> {
  constructor(
    readonly name: string,
    readonly initial: () => T,
  ) {}

  replayable(opts: ReplayableOptions<T>): ReplayableStateKey<T> {
    return new ReplayableStateKeyImpl(this.name, this.initial, opts);
  }
}

export function defineState<T>(name: string, initial: () => T): StateKeyBuilder<T> {
  return new StateKeyBuilderImpl(name, initial);
}

export interface UndoableProtocol {
  readonly events: {
    readonly appendMessage: Event2Class<any, any>;
    readonly applyCompaction: Event2Class<any, any>;
    readonly clear: Event2Class<any, any>;
    readonly undo: Event2Class<any, any>;
  };
  readonly isUndoAnchor: (message: unknown) => boolean;
  readonly isValidUndoCount: (count: number) => boolean;
}

let undoableProtocol: UndoableProtocol | undefined;

export function registerUndoableProtocol(protocol: UndoableProtocol): void {
  if (undoableProtocol !== undefined) {
    throw new BugIndicatingError('The undoable protocol is already registered');
  }
  undoableProtocol = protocol;
  for (const cls of Object.values(protocol.events)) {
    registerEvent2Class(cls);
  }
}

export function keepsUndoCheckpoints(
  key: ReplayableStateKey<any>,
): boolean {
  const undoable = key.replayable.undoable;
  return undoable !== undefined && undoable.onUndo === undefined;
}

export function expandedStateFolds(
  key: ReplayableStateKey<any>,
): ReadonlyMap<Event2Class<any, any>, StateFold<any, any>> {
  const meta = key.replayable;
  if (meta.undoable === undefined) return meta.folds;
  if (undoableProtocol === undefined) {
    throw new BugIndicatingError(
      `State key '${key.name}' is undoable but no undoable protocol is registered ` +
        '(the contextMemory domain registers it at import time)',
    );
  }
  const protocol = undoableProtocol;
  if (meta.folds.has(protocol.events.undo)) {
    throw new BugIndicatingError(
      `Undoable state key '${key.name}' must not fold the undo event itself; ` +
        'use .undoable({ onUndo }) to customize the rollback',
    );
  }
  const custom = meta.undoable.onUndo !== undefined;
  const folds = new Map<Event2Class<any, any>, StateFold<any, any>>(meta.folds);
  const domainAppend = folds.get(protocol.events.appendMessage);
  folds.set(protocol.events.appendMessage, (state, event, ctx) => {
    if (!custom && protocol.isUndoAnchor(event.message)) {
      ctx.checkpoint();
      return;
    }
    return domainAppend?.(state, event, ctx);
  });
  for (const cls of [protocol.events.applyCompaction, protocol.events.clear]) {
    const domain = folds.get(cls);
    folds.set(cls, (state, event, ctx) => {
      ctx.clearCheckpoints();
      return domain?.(state, event, ctx);
    });
  }
  folds.set(protocol.events.undo, (state, event, ctx) => {
    if (!protocol.isValidUndoCount(event.count)) return;
    if (meta.undoable?.onUndo !== undefined) {
      return meta.undoable.onUndo(state, event.count);
    }
    ctx.undoToCheckpoint(event.count);
  });
  return folds;
}

export type EventApplier = (event: any, ctx: FoldContext) => void;

export function expandedModelAppliers(
  owner: string,
  undoable: boolean,
  appliers: ReadonlyMap<Event2Class<any, any>, EventApplier>,
  onUndo: ((count: number) => void) | undefined,
): ReadonlyMap<Event2Class<any, any>, EventApplier> {
  if (!undoable) return appliers;
  if (undoableProtocol === undefined) {
    throw new BugIndicatingError(
      `Agent model '${owner}' is undoable but no undoable protocol is registered ` +
        '(the contextMemory domain registers it at import time)',
    );
  }
  const protocol = undoableProtocol;
  if (appliers.has(protocol.events.undo)) {
    throw new BugIndicatingError(
      `Undoable agent model '${owner}' must not apply the undo event itself; ` +
        'override onUndo on the model to customize the rollback',
    );
  }
  const custom = onUndo !== undefined;
  const expanded = new Map<Event2Class<any, any>, EventApplier>(appliers);
  const domainAppend = expanded.get(protocol.events.appendMessage);
  expanded.set(protocol.events.appendMessage, (event, ctx) => {
    if (!custom && protocol.isUndoAnchor(event.message)) {
      ctx.checkpoint();
      return;
    }
    domainAppend?.(event, ctx);
  });
  for (const cls of [protocol.events.applyCompaction, protocol.events.clear]) {
    const domain = expanded.get(cls);
    expanded.set(cls, (event, ctx) => {
      ctx.clearCheckpoints();
      domain?.(event, ctx);
    });
  }
  expanded.set(protocol.events.undo, (event, ctx) => {
    if (!protocol.isValidUndoCount(event.count)) return;
    if (onUndo !== undefined) {
      onUndo(event.count);
      return;
    }
    ctx.undoToCheckpoint(event.count);
  });
  return expanded;
}

export type DeepReadonly<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly (infer E)[]
        ? ReadonlyArray<DeepReadonly<E>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;
