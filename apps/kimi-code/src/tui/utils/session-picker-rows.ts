import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

const DEFAULT_SESSION_TITLE = 'New Session';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
): SessionRow[] {
  return sessions
    .filter((session) => !isEmptyCurrentSessionSummary(session, currentSessionId))
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}

function isEmptyCurrentSessionSummary(
  session: Pick<SessionSummary, 'id' | 'lastPrompt' | 'title'>,
  currentSessionId: string,
): boolean {
  if (currentSessionId.length === 0 || session.id !== currentSessionId) return false;
  const lastPrompt = session.lastPrompt?.trim();
  if (lastPrompt !== undefined && lastPrompt.length > 0) return false;
  const title = session.title?.trim();
  return title === undefined || title.length === 0 || title === DEFAULT_SESSION_TITLE;
}
