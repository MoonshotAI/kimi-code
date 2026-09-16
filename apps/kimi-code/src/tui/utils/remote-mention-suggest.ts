import type { AutocompleteItem } from '@moonshot-ai/pi-tui';
import type { Session, SuggestFilesItem } from '@moonshot-ai/kimi-code-sdk';

import type { MentionSuggester } from '../components/editor/file-mention-provider';
import type { RuntimeSlotState } from '../types';

const MENTION_SUGGEST_LIMIT = 50;

/**
 * Build the `@` mention suggester for a remote-bound session (experimental
 * remote runtime): suggestions come from the session-scoped fs suggest, which
 * lists files on the target host through the session's bound runtime — the
 * local fd scan would list files the runtime cannot see. Returns undefined
 * for local or unsynced sessions so the caller keeps the local fd-backed
 * path. The suggester degrades to `null` (the mention list stays closed) when
 * the endpoint reports `undefined` or the call fails — never to local files.
 */
export function remoteMentionSuggester(
  session: Session | undefined,
  runtime: RuntimeSlotState | undefined,
): MentionSuggester | undefined {
  if (session === undefined || runtime === undefined || runtime.runtimeId === 'local') {
    return undefined;
  }
  return async (query, signal) => {
    try {
      const result = await session.suggestFiles({ query, limit: MENTION_SUGGEST_LIMIT });
      if (result === undefined || signal.aborted) return null;
      return result.items.map(toMentionAutocompleteItem);
    } catch {
      return null;
    }
  };
}

function toMentionAutocompleteItem(item: SuggestFilesItem): AutocompleteItem {
  const isDirectory = item.kind === 'directory';
  const valuePath = isDirectory ? `${item.path}/` : item.path;
  const value = valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`;
  return {
    value,
    label: `${item.name}${isDirectory ? '/' : ''}`,
    description: item.path,
  };
}
