import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';

export class AskUserQuestionAutoPermissionPolicy implements PermissionPolicy {
  readonly name = 'auto.ask-user-question';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return undefined;
    if (context.toolCall.function.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'result',
      block: true,
      reason:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }
}
