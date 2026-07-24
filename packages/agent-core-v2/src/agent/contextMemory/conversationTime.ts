/**
 * `contextMemory` domain (L4) — shared conversation clock and checkpointed
 * wire-Model factory.
 *
 * Defines the undo anchor vocabulary and registers conversation-time Models
 * for undo validation. Scope-agnostic.
 */

import { defineModel, type ModelDef } from '#/wire/model';

import type { ContextMessage } from './types';

export function isUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isPromptOwnedInjection(
  message: ContextMessage,
  prompt: ContextMessage,
): boolean {
  const origin = message.origin;
  return (
    origin?.kind === 'injection' &&
    origin.ownerPromptId !== undefined &&
    origin.ownerPromptId === prompt.id
  );
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

export interface Checkpointed<T> {
  readonly current: T;
  readonly checkpoints: readonly T[];
}

export const CHECKPOINTED_MODELS: ModelDef<Checkpointed<unknown>>[] = [];

export interface CheckpointModelOptions<T> {
  readonly onAppendMessage?: (current: T, message: ContextMessage) => T;
}

export function defineCheckpointedModel<T>(
  name: string,
  initial: () => T,
  opts?: CheckpointModelOptions<T>,
): ModelDef<Checkpointed<T>> {
  const def = defineModel<Checkpointed<T>>(
    name,
    () => ({ current: initial(), checkpoints: [] }),
    {
      reducers: {
        'context.append_message': (state, { message }) => {
          if (isUndoAnchor(message)) {
            return { ...state, checkpoints: [...state.checkpoints, state.current] };
          }
          if (opts?.onAppendMessage === undefined) return state;
          const current = opts.onAppendMessage(state.current, message);
          return current === state.current ? state : { ...state, current };
        },
        'context.apply_compaction': (state) =>
          state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
        'context.clear': (state) =>
          state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
        'context.undo': (state, { count }) => {
          if (!isValidUndoCount(count) || state.checkpoints.length < count) return state;
          const checkpointIndex = state.checkpoints.length - count;
          return {
            current: state.checkpoints[checkpointIndex]!,
            checkpoints: state.checkpoints.slice(0, checkpointIndex),
          };
        },
      },
    },
  );
  CHECKPOINTED_MODELS.push(def as ModelDef<Checkpointed<unknown>>);
  return def;
}
