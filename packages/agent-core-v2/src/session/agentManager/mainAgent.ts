import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { type CreateAgentOptions, IAgentManager, MAIN_AGENT_ID } from './agentManager';

export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: Omit<CreateAgentOptions, 'agentId'>,
): Promise<AgentContext> {
  return session.accessor.get(IAgentManager).create({
    ...opts,
    agentId: MAIN_AGENT_ID,
  });
}
