import {
  Error2,
  ErrorCodes,
  ISessionContext,
  IWorkspaceInstanceManager,
  getLiveSessionById,
  snapshotSessionWorkspaceAssociation,
  type Scope,
  type SessionWorkspaceAssociationSnapshot,
  type WorkspaceInstanceSnapshot,
  type WorkspaceInstancesSnapshot,
} from '@moonshot-ai/agent-core-v2';

export function workspaceSnapshots(core: Scope): WorkspaceInstancesSnapshot {
  return core.accessor.get(IWorkspaceInstanceManager).snapshot();
}

export async function workspaceSnapshot(
  core: Scope,
  workspaceId: string,
): Promise<WorkspaceInstanceSnapshot> {
  const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId });
  try {
    return lease.instance.snapshot();
  } finally {
    lease.dispose();
  }
}

export function sessionWorkspaceAssociation(
  core: Scope,
  sessionId: string,
): SessionWorkspaceAssociationSnapshot {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
  }
  return snapshotSessionWorkspaceAssociation(session.accessor.get(ISessionContext));
}
