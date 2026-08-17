/**
 * `contextMemory` domain — shared conversation clock and checkpointed
 * wire-Model factory.
 *
 * Owns the undo anchor vocabulary and the single undo-cut decision:
 * `computeUndoCutFrom` walks entries backwards counting `isUndoAnchor`
 * ticks — skipping injections, stopping at a compaction summary, extending
 * the cut over the anchor's prompt-owned injections — bounded by an optional
 * floor, and generic over the entry type so any read model whose entries
 * carry a `ContextMessage` can run the same walk. The returned `UndoCut`
 * separates `anchorIndex` (the counted anchor) from `cutIndex` (extended
 * over its prompt-owned injections). The wire-model Op
 * (`contextOps.contextUndo`) applies the cut to the append-only log (mapping
 * the visible-window cut back to a log position); the display
 * transcript (`contextTranscript`) applies the same decision as a
 * non-destructive splice — so a blocked undo (compaction boundary /
 * insufficient anchors / floor) reads identically on both sides.
 *
 * Also registers conversation-time Models for undo validation:
 * `CHECKPOINTED_MODELS` stays the undo domain's read path; the
 * `WireModelContribution` fold also drains it into the built-in layer so the
 * checkpointed list is part of the folded wire vocabulary. Scope-agnostic.
 */

import { defineModel, type ModelDef } from '#/wire/model';
import type { ModelReducers } from '#/wire/types';

import type { ContextMessage } from './types';

export function isUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined) return true;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash';
    case 'injection':
    case 'shell_command':
    case 'compaction_summary':
    case 'system_trigger':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'retry':
      return false;
    default: {
      const exhaustive: never = origin;
      void exhaustive;
      return false;
    }
  }
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

export interface UndoCut {
  readonly cutIndex: number;
  readonly anchorIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

export function computeUndoCut(
  messages: readonly ContextMessage[],
  count: number,
): UndoCut {
  return computeUndoCutFrom(messages, count, (message) => message);
}

export function computeUndoCutFrom<E>(
  entries: readonly E[],
  count: number,
  messageOf: (entry: E) => ContextMessage,
  floor: number = 0,
): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let anchorIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = entries.length - 1; i >= floor && remaining > 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const message = messageOf(entry);
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isUndoAnchor(message)) {
      remaining--;
      removedCount++;
      anchorIndex = i;
      cutIndex = i;
      while (
        cutIndex > floor &&
        isPromptOwnedInjection(messageOf(entries[cutIndex - 1]!), message)
      ) {
        cutIndex--;
      }
    }
  }
  return { cutIndex, anchorIndex, removedCount, stoppedAtCompaction };
}

export function isFullyUndoable(cut: UndoCut, count: number): boolean {
  return cut.cutIndex >= 0 && cut.removedCount >= count;
}

export interface Checkpointed<T> {
  readonly current: T;
  readonly checkpoints: readonly T[];
}

export const CHECKPOINTED_MODELS: ModelDef<Checkpointed<unknown>>[] = [];

export interface CheckpointModelOptions<T> {
  readonly onAppendMessage?: (current: T, message: ContextMessage) => T;
  readonly reducers?: ModelReducers<Checkpointed<T>>;
}

export function defineCheckpointedModel<T>(
  name: string,
  initial: () => T,
  opts?: CheckpointModelOptions<T>,
): ModelDef<Checkpointed<T>> {
  const customReducers = opts?.reducers ?? {};
  const def = defineModel<Checkpointed<T>>(
    name,
    () => ({ current: initial(), checkpoints: [] }),
    {
      reducers: {
        ...customReducers,
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
