import type { Message } from '@moonshot-ai/kosong';

export const TOOL_STALL_RECOVERY_NAME = 'tool_stall_recovery';

export const TOOL_STALL_RECOVERY_TEXT =
  '<system-reminder>\n' +
  'Your previous step ended without calling any tools even though more work remains on the user request. ' +
  'Call the appropriate tools now instead of only describing what you plan to do next.\n' +
  '</system-reminder>';

/** True when tool results appear after the latest user message in the turn history. */
export function hasToolResultsSinceLastUserMessage(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === 'user') return false;
    if (message.role === 'tool') return true;
  }
  return false;
}
