/**
 * server-v2 — on-demand main-agent resolution.
 *
 * Sessions are created without a main agent; the first request that targets
 * `main` materializes it here. Both the `/api/v1` routes and the `/api/v2`
 * dispatcher resolve the main agent through {@link ensureMainAgent} so a
 * missing main agent is created instead of reported as `agent.not_found`.
 */

import {
  IAgentLifecycleService,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

export const MAIN_AGENT_ID = 'main';

/**
 * Return the session's main agent, creating it on demand when it does not
 * exist yet.
 */
export async function ensureMainAgent(session: ISessionScopeHandle): Promise<IAgentScopeHandle> {
  const agents = session.accessor.get(IAgentLifecycleService);
  const existing = agents.getHandle(MAIN_AGENT_ID);
  if (existing !== undefined) return existing;
  return agents.createMain();
}
