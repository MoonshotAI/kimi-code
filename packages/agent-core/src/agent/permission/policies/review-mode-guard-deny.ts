import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export const REVIEW_MODE_ALLOWED_TOOLS = new Set([
  'GetAssignment',
  'GetChangedFiles',
  'ReadDiff',
  'ReadFileVersion',
  'UpdateProgress',
  'AddComment',
  'GetComments',
  'GetCommentEvidence',
  'MergeComments',
  'DismissComment',
  'Grep',
  'Glob',
]);

export class ReviewModeGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'review-mode-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.review === undefined) return;
    const toolName = context.toolCall.name;
    if (REVIEW_MODE_ALLOWED_TOOLS.has(toolName)) return;
    return {
      kind: 'deny',
      reason: { review_mode: true },
      message:
        `${toolName} is not available to review workers. ` +
        'Use the review read/comment/progress tools for this assignment.',
    };
  }
}
