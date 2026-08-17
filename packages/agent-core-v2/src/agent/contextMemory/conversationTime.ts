/**
 * `contextMemory` domain — shared conversation clock and the undoable
 * protocol registration.
 *
 * Defines the undo anchor vocabulary and registers the undoable protocol
 * consumed by the state domain's `.undoable()` expansion: the four protocol
 * events (`context.append_message` / `context.apply_compaction` /
 * `context.clear` / `context.undo`), the single `isUndoAnchor` tick
 * predicate, and the undo-count guard. A state key whose value must follow
 * conversation undo chains `.undoable()` — never hand-rolling the
 * checkpoint/clear/rollback folds — so undo anchors push a checkpoint,
 * compaction/clear drop the markers, and `context.undo` rolls back through
 * inverse patches (or through the key's custom `onUndo`). Scope-agnostic.
 */

import { registerUndoableProtocol } from '#/state/state';

import {
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from './contextEvents';
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

registerUndoableProtocol({
  events: {
    appendMessage: ContextAppendMessage,
    applyCompaction: ContextApplyCompaction,
    clear: ContextClear,
    undo: ContextUndo,
  },
  isUndoAnchor: (message) => isUndoAnchor(message as ContextMessage),
  isValidUndoCount,
});
