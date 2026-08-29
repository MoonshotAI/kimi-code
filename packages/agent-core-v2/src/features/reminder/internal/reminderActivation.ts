import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentReminder, type ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export function activateReminderWhenReady(
  lifecycle: IAgentLifecycleService,
  scope: IAgentScopeContext,
  activate: (runtime: ReminderRuntime) => IDisposable,
): IDisposable {
  let active: IDisposable | undefined;
  const tryActivate = (): void => {
    if (active !== undefined || lifecycle.handleOf(scope.agentId) === undefined) return;
    active = activate(lifecycle.resolve(scope.agentContext, AgentReminder));
  };
  const created = lifecycle.onDidCreateScope(({ context }) => {
    if (context === scope.agentContext) tryActivate();
  });
  tryActivate();
  return toDisposable(() => {
    created.dispose();
    active?.dispose();
  });
}
