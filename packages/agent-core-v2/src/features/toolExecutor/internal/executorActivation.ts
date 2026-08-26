import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentToolExecutor, type ToolExecutorRuntime } from '#/features/toolExecutor/toolExecutorAgentRuntime';

export function activateToolExecutorWhenReady(
  lifecycle: IAgentLifecycleService,
  scope: IAgentScopeContext,
  activate: (runtime: ToolExecutorRuntime) => IDisposable,
  options?: { readonly deferToScopeCreated?: boolean },
): IDisposable {
  let active: IDisposable | undefined;
  let scopeCreated = options?.deferToScopeCreated !== true;
  const tryActivate = (): void => {
    if (active !== undefined || !scopeCreated) return;
    if (lifecycle.handleOf(scope.agentId) === undefined) return;
    active = activate(lifecycle.resolve(scope.agentContext, AgentToolExecutor));
  };
  const created = lifecycle.onDidCreateScope(({ context }) => {
    if (context !== scope.agentContext) return;
    scopeCreated = true;
    tryActivate();
  });
  tryActivate();
  return toDisposable(() => {
    created.dispose();
    active?.dispose();
  });
}
