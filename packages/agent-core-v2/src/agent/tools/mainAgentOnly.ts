import type { ToolExecution } from '#/tool/toolContract';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

export const CRON_MAIN_AGENT_ONLY = 'Cron tools are only supported by the main agent.';

export const GOAL_MAIN_AGENT_ONLY = 'Goal tools are only supported by the main agent.';

export function mainAgentOnlyExecution(
  scopeContext: IAgentScopeContext,
  output: string,
): ToolExecution | undefined {
  if (scopeContext.agentId === MAIN_AGENT_ID) return undefined;
  return { isError: true, output };
}
