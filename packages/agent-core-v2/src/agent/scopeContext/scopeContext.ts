/**
 * `scopeContext` domain (L1) — agent-scope identity token.
 *
 * Exposes `IAgentScopeContext`, the identity of the current agent scope (its
 * `agentId`) plus a `scope(subKey?)` helper that returns the agent's
 * persistence scope (or a child under it, e.g. `scope('cron')`). Seeded into
 * every agent scope at creation by `agentLifecycle` so Agent-scoped consumers
 * can refer to themselves and address their per-agent storage without any
 * path arithmetic. Bound at Agent scope via a per-agent seed, not the scoped
 * registry.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;

  readonly agentId: string;
  /**
   * Persistence scope rooted at this agent. `scope()` returns the agent
   * scope itself; `scope(subKey)` returns `${agentScope}/${subKey}` (e.g.
   * `scope('cron')` → `sessions/<wsId>/<sId>/agents/<aId>/cron`). Business
   * code passes the returned string straight to `IFileSystemStorageService` /
   * `IAtomicDocumentStore` / `IAppendLogStore`.
   */
  scope(subKey?: string): string;
}

export const IAgentScopeContext: ServiceIdentifier<IAgentScopeContext> =
  createDecorator<IAgentScopeContext>('agentScopeContext');

/**
 * Build an `IAgentScopeContext` from an agent's persistence root, wiring the
 * `scope(subKey?)` helper automatically. `agentScope` is typically
 * `sessions/<workspaceId>/<sessionId>/agents/<agentId>`; a call like
 * `scope('cron')` returns `${agentScope}/cron`.
 */
export function makeAgentScopeContext(input: {
  readonly agentId: string;
  readonly agentScope: string;
}): IAgentScopeContext {
  const { agentScope } = input;
  return {
    _serviceBrand: undefined,
    agentId: input.agentId,
    scope: (subKey?: string): string => {
      if (subKey === undefined || subKey === '') return agentScope;
      if (agentScope === '') return subKey;
      return `${agentScope}/${subKey}`;
    },
  };
}
