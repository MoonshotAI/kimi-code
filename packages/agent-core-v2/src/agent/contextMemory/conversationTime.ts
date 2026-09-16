import { registerUndoableProtocol } from '#/state/state';
import { isUserEntry, type HistoryMessage } from '#human/agent/turn';
import type { PromptOrigin } from '#human/agent/origin';

import {
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from './contextEvents';
import { normalizeReplayedEntry } from './loopEventFold';

export function isUndoAnchorOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isUndoAnchor(entry: HistoryMessage): boolean {
  if (!isUserEntry(entry)) return false;
  return isUndoAnchorOrigin(entry.meta?.origin);
}

export function isPromptOwnedInjection(
  message: HistoryMessage,
  prompt: HistoryMessage,
): boolean {
  const origin = isUserEntry(message) ? message.meta?.origin : undefined;
  const promptId = isUserEntry(prompt) ? prompt.meta?.promptId : undefined;
  return (
    origin?.kind === 'injection' &&
    origin.ownerPromptId !== undefined &&
    origin.ownerPromptId === promptId
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
  isUndoAnchor: (message) => isUndoAnchor(normalizeReplayedEntry(message)),
  isValidUndoCount,
});
