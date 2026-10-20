import type { SessionRecord } from '@moonshot-ai/agent-core/session/index';

export const SESSION_WORKSPACE_ID = 'workspaceId';

export function sessionWorkspaceId(record: SessionRecord | undefined): string | undefined {
  const value = record?.metadata?.[SESSION_WORKSPACE_ID];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function withSessionWorkspace(
  metadata: Record<string, unknown> | undefined,
  workspaceId: string,
): Record<string, unknown> {
  return { ...metadata, [SESSION_WORKSPACE_ID]: workspaceId };
}
