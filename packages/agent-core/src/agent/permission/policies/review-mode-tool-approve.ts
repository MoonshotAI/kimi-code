import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { REVIEW_MODE_ALLOWED_TOOLS } from './review-mode-guard-deny';

export class ReviewModeToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'review-mode-tool-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.review === undefined) return;
    if (!REVIEW_MODE_ALLOWED_TOOLS.has(context.toolCall.name)) return;
    return {
      kind: 'approve',
      reason: { review_mode: true },
    };
  }
}
