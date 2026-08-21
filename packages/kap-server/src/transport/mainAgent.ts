import {
  ensureMainAgent as ensureMainAgentContext,
  IAgentManager,
  MAIN_AGENT_ID,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

export { MAIN_AGENT_ID };

export async function ensureMainAgent(session: ISessionScopeHandle): Promise<IAgentScopeHandle> {
  const context = await ensureMainAgentContext(session);
  const handle = session.accessor.get(IAgentManager).handleOf(context.agentId);
  if (handle === undefined) {
    throw new Error('Main agent was not found');
  }
  return handle;
}
