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
