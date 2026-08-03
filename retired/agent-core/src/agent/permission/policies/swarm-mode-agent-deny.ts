import { t } from '@moonshot-ai/kimi-i18n';
import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Denies the `Agent` tool when swarm mode is active.
 *
 * Swarm mode mandates that ALL subagent work goes through `AgentSwarm` —
 * calling the single-shot `Agent` tool is a protocol violation (see
 * enter-reminder.md "Non-Negotiable Rules"). The reminder alone is a soft
 * constraint; this policy enforces it in the permission pipeline so a
 * model that still emits an `Agent` call gets a hard deny before any
 * subagent is spawned.
 */
export class SwarmModeAgentDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.swarmMode.isActive) return;
    if (context.toolCall.name !== 'Agent') return;

    return {
      kind: 'deny',
      message: t('toolsV2.swarm.agentDeniedInSwarmMode'),
    };
  }
}
