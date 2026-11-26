import type { Message } from '@moonshot-ai/core/llm/message';

import { historyEntryFromContext } from '#/agent/loop/history';

import { renderHookResult } from './userPrompt';

export const SESSION_START_HOOK_VARIANT = 'session_start_hook';

export function sessionStartHookEntry(additionalContext: string): Message {
  return historyEntryFromContext({
    role: 'user',
    content: [{ type: 'text', text: renderHookResult('SessionStart', additionalContext) }],
    origin: { kind: 'injection', variant: SESSION_START_HOOK_VARIANT },
  });
}
