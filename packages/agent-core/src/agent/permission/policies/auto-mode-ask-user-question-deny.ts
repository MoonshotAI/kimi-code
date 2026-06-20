import type { Agent } from '../..';
import type { ContextMessage, PromptOrigin } from '../../context';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class AutoModeAskUserQuestionDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    if (context.toolCall.name !== 'AskUserQuestion') return;
    if (currentRequestIsLoadedSkill(this.agent.context?.history ?? [])) return;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active outside a loaded skill. Make a reasonable decision and continue without asking the user.',
    };
  }
}

function currentRequestIsLoadedSkill(history: readonly ContextMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role !== 'user') continue;
    const origin = message.origin;
    if (isInternalContinuationOrigin(origin)) continue;
    return origin?.kind === 'skill_activation';
  }
  return false;
}

function isInternalContinuationOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'injection' ||
    origin?.kind === 'compaction_summary' ||
    origin?.kind === 'retry'
  );
}
