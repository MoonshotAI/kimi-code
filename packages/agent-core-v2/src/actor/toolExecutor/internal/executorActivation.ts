import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentTools, type AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';

export function activateToolExecutorWhenReady(
  lifecycle: IAgentLifecycleService,
  scope: IAgentScopeContext,
  activate: (runtime: AgentToolsRuntime) => IDisposable,
  options?: { readonly deferToScopeCreated?: boolean },
): IDisposable {
  let active: IDisposable | undefined;
  let agentCreated = options?.deferToScopeCreated !== true;
  const tryActivate = (): void => {
    if (active !== undefined || !agentCreated) return;
    if (lifecycle.get(scope.agentId) === undefined) return;
    active = activate(lifecycle.resolve(scope.agentContext, AgentTools));
  };
  const created = lifecycle.onDidCreate((context) => {
    if (context !== scope.agentContext) return;
    agentCreated = true;
    tryActivate();
  });
  tryActivate();
  return toDisposable(() => {
    created.dispose();
    active?.dispose();
  });
}
