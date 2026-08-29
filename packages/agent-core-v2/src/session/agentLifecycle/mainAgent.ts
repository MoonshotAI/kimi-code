import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { type CreateAgentOptions, IAgentLifecycleService, MAIN_AGENT_ID } from './agentLifecycle';

export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: Omit<CreateAgentOptions, 'agentId'>,
): Promise<AgentContext> {
  return session.accessor.get(IAgentLifecycleService).create({
    ...opts,
    agentId: MAIN_AGENT_ID,
  });
}
