import {
  Error2,
  ErrorCodes,
  IAgentLifecycleService,
  IAgentRuntimeBindingService,
  IAgentRuntimeService,
  ISessionContext,
  IWorkspaceInstanceManager,
  getLiveSessionById,
  snapshotAgentRuntimeBinding,
  snapshotSessionWorkspaceAssociation,
  type AgentRuntimeBindingSnapshot,
  type Scope,
  type SessionWorkspaceAssociationSnapshot,
  type WorkspaceInstanceSnapshot,
  type WorkspaceInstancesSnapshot,
} from '@moonshot-ai/agent-core-v2';

import { MAIN_AGENT_ID, ensureMainAgent } from './mainAgent';

export function workspaceSnapshots(core: Scope): WorkspaceInstancesSnapshot {
  return core.accessor.get(IWorkspaceInstanceManager).snapshot();
}

export async function workspaceSnapshot(
  core: Scope,
  workspaceId: string,
): Promise<WorkspaceInstanceSnapshot> {
  return (await core.accessor.get(IWorkspaceInstanceManager).getOrCreate({ workspaceId })).snapshot();
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

export async function agentRuntimeBindingSnapshot(
  core: Scope,
  sessionId: string,
  agentId: string,
): Promise<AgentRuntimeBindingSnapshot> {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
  }
  const agent = agentId === MAIN_AGENT_ID
    ? await ensureMainAgent(session)
    : session.accessor.get(IAgentLifecycleService).findAgentHandle(agentId);
  if (agent === undefined) {
    throw new Error2(
      ErrorCodes.AGENT_NOT_FOUND,
      `agent ${agentId} not found in session ${sessionId}`,
    );
  }
  return snapshotAgentRuntimeBinding(
    agent.accessor.get(IAgentRuntimeBindingService),
    agent.accessor.get(IAgentRuntimeService),
  );
}
