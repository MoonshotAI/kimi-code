import type { ContextMessage } from '@moonshot-ai/kimi-code-sdk';

import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { isInternalMessage } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

/** Last assistant text in the history, newest first; empty string when none. */
export function findLastAssistantText(history: readonly ContextMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined) continue;
    if (msg.role !== 'assistant' || msg.isError === true || isInternalMessage(msg)) continue;
    const text = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n');
    if (text.trim().length > 0) return text;
  }
  return '';
}

export async function handleCopyCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const { history } = await session.getContext();
    const text = findLastAssistantText(history);
    if (text.length === 0) {
      host.showStatus('No assistant message to copy.', 'warning');
      return;
    }

    await copyTextToClipboard(text);
    host.showStatus(`Copied to clipboard (${String(text.length)} characters).`);
  } catch (error) {
    host.showError(`Failed to copy to clipboard: ${formatErrorMessage(error)}`);
  }
}
