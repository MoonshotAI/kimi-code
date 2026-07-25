import { t } from '@moonshot-ai/kimi-i18n';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class AgentSwarmExclusiveDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';

  private readonly solitaryTools = new Set(['AgentSwarm', 'SwarmDiscussion']);

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolCalls = context.toolCalls;
    const solitaryCount = toolCalls.filter(
      (toolCall) => this.solitaryTools.has(toolCall.name),
    ).length;

    if (solitaryCount === 0) return;
    if (solitaryCount === 1 && toolCalls.length === 1) return;

    return {
      kind: 'deny',
      message:
        solitaryCount > 1
          ? (toolCalls.length > solitaryCount
              ? t('toolsV2.swarm.solitaryMultipleDeniedMixed')
              : t('toolsV2.swarm.solitaryMultipleDenied'))
          : t('toolsV2.swarm.solitaryMixedDenied'),
      reason: {
        solitary_tool_calls: solitaryCount,
        tool_calls: toolCalls.length,
      },
    };
  }
}