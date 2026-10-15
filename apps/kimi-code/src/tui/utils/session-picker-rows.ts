import { workspaceRootKey, type SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
  defaultWorkspacePath?: string,
): SessionRow[] {
  const rows = sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      in_default_workspace: false,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
  return markDefaultWorkspaceRows(rows, defaultWorkspacePath);
}

export function markDefaultWorkspaceRows(
  rows: readonly SessionRow[],
  defaultWorkspacePath: string | undefined,
): SessionRow[] {
  const defaultKey =
    defaultWorkspacePath === undefined ? undefined : workspaceRootKey(defaultWorkspacePath);
  return rows.map((row) => ({
    ...row,
    in_default_workspace: defaultKey !== undefined && workspaceRootKey(row.work_dir) === defaultKey,
  }));
}
