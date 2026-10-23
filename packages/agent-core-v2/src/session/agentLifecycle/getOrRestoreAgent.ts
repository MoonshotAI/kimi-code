import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentLifecycleService } from './agentLifecycle';

export async function getOrRestoreAgent(
  session: ISessionScopeHandle,
  agentId: string,
): Promise<IAgentScopeHandle | undefined> {
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  const live = lifecycle.handleOf(agentId);
  if (live !== undefined) return live;
  const meta = (await session.accessor.get(ISessionMetadata).read()).agents?.[agentId];
  if (meta === undefined) return undefined;
  await lifecycle.create({
    agentId,
    forkedFrom: meta.forkedFrom,
    labels: meta.labels,
  });
  return lifecycle.handleOf(agentId);
}
