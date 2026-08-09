import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * Visible text of the last assistant transcript entry, newest first; empty
 * string when none. Sourced from the rendered transcript rather than the
 * model context so it survives compaction and session resume: after
 * `/compact` the context keeps user messages plus a user-role summary only,
 * while the last reply is still on screen. Only entries tagged `modelText`
 * count — hook-result and goal-completion cards share kind 'assistant' but
 * are not replies.
 */
export function findLastAssistantText(entries: readonly TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || entry.kind !== 'assistant' || entry.modelText !== true) continue;
    if (entry.content.trim().length > 0) return entry.content;
  }
  return '';
}

export async function handleCopyCommand(host: SlashCommandHost): Promise<void> {
  const text = findLastAssistantText(host.state.transcriptEntries);
  if (text.length === 0) {
    host.showStatus('No assistant message to copy.', 'warning');
    return;
  }

  try {
    const method = await copyTextToClipboard(text);
    host.showStatus(
      method === 'native'
        ? `Copied to clipboard (${String(text.length)} characters).`
        : `Copied via terminal escape sequence (unverified, ${String(text.length)} characters).`,
    );
  } catch (error) {
    host.showError(`Failed to copy to clipboard: ${formatErrorMessage(error)}`);
  }
}
