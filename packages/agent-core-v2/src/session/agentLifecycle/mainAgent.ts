import type { ISessionScopeHandle, IAgentScopeHandle } from '#/_base/di/scope';

import { type CreateAgentOptions, IAgentLifecycleService, MAIN_AGENT_ID } from './agentLifecycle';

export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: Omit<CreateAgentOptions, 'agentId'>,
): Promise<IAgentScopeHandle> {
  return session.accessor.get(IAgentLifecycleService).create({
    ...opts,
    agentId: MAIN_AGENT_ID,
  });
}
