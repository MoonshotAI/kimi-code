import {
  Error2,
  ErrorCodes,
  IAgentLifecycleService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  ISessionContext,
  IProjectInstanceManager,
  getLiveSessionById,
  snapshotAgentEnvironmentBinding,
  snapshotSessionProjectAssociation,
  type AgentEnvironmentBindingSnapshot,
  type Scope,
  type SessionProjectAssociationSnapshot,
  type ProjectInstanceSnapshot,
  type ProjectInstancesSnapshot,
} from '@moonshot-ai/agent-core-v2';

import { MAIN_AGENT_ID, ensureMainAgent } from './mainAgent';

export function workspaceSnapshots(core: Scope): ProjectInstancesSnapshot {
  return core.accessor.get(IProjectInstanceManager).snapshot();
}

export async function workspaceSnapshot(
  core: Scope,
  workspaceId: string,
): Promise<ProjectInstanceSnapshot> {
  const lease = await core.accessor.get(IProjectInstanceManager).acquire({ workspaceId });
  try {
    return lease.instance.snapshot();
  } finally {
    lease.dispose();
  }
}

export function sessionWorkspaceAssociation(
  core: Scope,
  sessionId: string,
): SessionProjectAssociationSnapshot {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
  }
  return snapshotSessionProjectAssociation(session.accessor.get(ISessionContext));
}

export async function agentEnvironmentBindingSnapshot(
  core: Scope,
  sessionId: string,
  agentId: string,
): Promise<AgentEnvironmentBindingSnapshot> {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} not found`);
  }
  const agent = agentId === MAIN_AGENT_ID
    ? await ensureMainAgent(session)
    : session.accessor.get(IAgentLifecycleService).handleOf(agentId);
  if (agent === undefined) {
    throw new Error2(
      ErrorCodes.AGENT_NOT_FOUND,
      `agent ${agentId} not found in session ${sessionId}`,
    );
  }
  return snapshotAgentEnvironmentBinding(
    agent.accessor.get(IAgentEnvironmentBindingService),
    agent.accessor.get(IAgentEnvironmentService),
  );
}
