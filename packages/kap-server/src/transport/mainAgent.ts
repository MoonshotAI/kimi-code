import {
  ensureMainAgent as ensureMainAgentContext,
  MAIN_AGENT_ID as CORE_MAIN_AGENT_ID,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { syntheticAgentScope, type AgentScopeView } from './agentScopeView';

export const MAIN_AGENT_ID = CORE_MAIN_AGENT_ID;

export async function ensureMainAgent(session: ISessionScopeHandle): Promise<AgentScopeView> {
  const context = await ensureMainAgentContext(session);
  return syntheticAgentScope(session, context);
}
