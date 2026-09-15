import type {
  AgentRuntimeBindingSnapshot,
  SessionWorkspaceAssociationSnapshot,
  WorkspaceInstanceSnapshot,
  WorkspaceInstancesSnapshot,
} from '@moonshot-ai/agent-core-v2';

import { DEBUG_RPC_BASE, type InspectClient } from '../channel';
import { RPCError } from '../channel/errors';

export function fetchWorkspaceSnapshots(client: InspectClient): Promise<WorkspaceInstancesSnapshot> {
  return fetchSnapshot(client, '/workspaces');
}

export function fetchWorkspaceSnapshot(
  client: InspectClient,
  workspaceId: string,
): Promise<WorkspaceInstanceSnapshot> {
  return fetchSnapshot(client, `/workspace/${encodeURIComponent(workspaceId)}/snapshot`);
}

export function fetchSessionWorkspaceAssociation(
  client: InspectClient,
  sessionId: string,
): Promise<SessionWorkspaceAssociationSnapshot> {
  return fetchSnapshot(client, `/session/${encodeURIComponent(sessionId)}/association`);
}

export function fetchAgentRuntimeBinding(
  client: InspectClient,
  sessionId: string,
  agentId: string,
): Promise<AgentRuntimeBindingSnapshot> {
  return fetchSnapshot(
    client,
    `/session/${encodeURIComponent(sessionId)}/agent/${encodeURIComponent(agentId)}/runtime-binding`,
  );
}

async function fetchSnapshot<T>(client: InspectClient, path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (client.token !== undefined && client.token !== '') {
    headers['authorization'] = `Bearer ${client.token}`;
  }
  const response = await fetch(`${client.baseUrl}${DEBUG_RPC_BASE}${path}`, { headers });
  const envelope = (await response.json()) as {
    code: number;
    msg: string;
    data: T;
  };
  if (envelope.code !== 0) throw new RPCError(envelope.code, envelope.msg);
  return envelope.data;
}
