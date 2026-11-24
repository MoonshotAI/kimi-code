export type QuitBlockReason = 'busy' | 'remote-control';

export type QuitConfirmPurpose = 'quit' | 'update';

export interface QuitConfirmDetails {
  readonly purpose: QuitConfirmPurpose;
  readonly sessionTitles: readonly string[];
}

export interface UpdateRestartMessageCopy {
  readonly busy: string;
  readonly sessions: string;
  readonly moreSessions: (count: number) => string;
  readonly remoteControl: string;
}

const SESSION_PREVIEW_LIMIT = 3;

export function asQuitConfirmDetails(value: unknown): QuitConfirmDetails {
  if (value === null || typeof value !== 'object') return { purpose: 'quit', sessionTitles: [] };
  const { purpose, sessionTitles } = value as { purpose?: unknown; sessionTitles?: unknown };
  return {
    purpose: purpose === 'update' ? 'update' : 'quit',
    sessionTitles: Array.isArray(sessionTitles)
      ? sessionTitles.filter((title): title is string => typeof title === 'string')
      : [],
  };
}

export function updateRestartMessage(
  copy: UpdateRestartMessageCopy,
  reasons: readonly QuitBlockReason[],
  sessionTitles: readonly string[],
): string {
  const parts: string[] = [];
  if (sessionTitles.length > 0) {
    const preview = sessionTitles.slice(0, SESSION_PREVIEW_LIMIT).map((title) => `• ${title}`);
    const hidden = sessionTitles.length - SESSION_PREVIEW_LIMIT;
    if (hidden > 0) preview.push(copy.moreSessions(hidden));
    parts.push([copy.sessions, ...preview].join('\n'));
  } else if (reasons.includes('busy')) {
    parts.push(copy.busy);
  }
  if (reasons.includes('remote-control')) parts.push(copy.remoteControl);
  return parts.join('\n\n');
}
