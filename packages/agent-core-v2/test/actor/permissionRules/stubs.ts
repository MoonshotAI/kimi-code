import { Event } from '#/_base/event';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { Event2 } from '#/app/event/event2';
import { IConfigService } from '#/app/config/config';
import { PermissionRulesRuntime } from '#/actor/permissionRules/permissionRulesAgentRuntime';
import type { PermissionRulesState } from '#/actor/permissionRules/permissionRulesOps';
import type { PermissionRule } from '#/actor/permissionRules/types';

export function stubPermissionRulesRuntime(input: {
  readonly rules?: () => readonly PermissionRule[];
  readonly approvalPatterns?: () => readonly string[];
  readonly dispatched?: Event2[];
}): PermissionRulesRuntime {
  const context = {
    agent: { agentId: 'main', generation: 0 },
    get: (id: unknown) => {
      if (id === IConfigService) {
        return { get: () => undefined };
      }
      throw new Error('unexpected service access');
    },
    getState: (): PermissionRulesState => ({
      rules: input.rules?.() ?? [],
      sessionApprovalRulePatterns: input.approvalPatterns?.() ?? [],
    }),
    getLogicState: () => {
      throw new Error('unexpected logic state access');
    },
    dispatch: (event: Event2) => {
      input.dispatched?.push(event);
      return Promise.resolve();
    },
    send: () => {},
    onDidChange: Event.None,
  } as unknown as AgentRuntimeContext<PermissionRulesState>;
  return new PermissionRulesRuntime(context);
}
