import type { BranchRef } from '#/store/types';

import type { InternalEvent } from './events';

export interface Enqueue {
  raise(event: InternalEvent): void;
  effect(fn: () => void): void;
}

export interface FoldContext {
  readonly ref: BranchRef;
  readonly ts: number;
  readonly replaying: boolean;
  readonly enqueue: Enqueue;
}

export interface Slice<Name extends string = string, S = any> {
  readonly name: Name;
  readonly initialState: () => S;
  readonly reducers: Record<string, (draft: S, event: any, ctx: FoldContext) => void | S>;
}

export function createSlice<Name extends string, S>(def: Slice<Name, S>): Slice<Name, S> {
  return def;
}
