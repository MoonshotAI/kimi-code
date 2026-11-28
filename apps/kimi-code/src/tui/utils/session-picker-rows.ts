import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';
import type { SessionLocationTag } from '#/tui/utils/session-location';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
  locations?: ReadonlyMap<string, SessionLocationTag>,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      project_work_dir: session.projectWorkDir,
      worktree: locations?.get(session.workDir)?.worktree,
      missing: locations?.get(session.workDir)?.missing,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}
