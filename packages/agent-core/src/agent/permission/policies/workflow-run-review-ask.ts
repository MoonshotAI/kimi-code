import type { Agent } from '../..';
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';

/**
 * Running a dynamic workflow starts an orchestrated, potentially long and
 * token-heavy batch of subagents, so a model-issued `Workflow` call asks for
 * explicit confirmation in **manual** mode. In `auto` mode the upstream
 * auto-approve policy handles it; in `yolo` mode the downstream yolo-approve
 * policy handles it — consistent with how other tools respect the permission
 * mode. Session-scoped "always approve" grants are honored on later calls
 * (this policy runs after the session-history policy).
 */
export class WorkflowRunReviewAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'workflow-run-review-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'Workflow') return;
    if (context.execution.display?.kind !== 'workflow_run') return;
    // Only ask in manual mode; auto and yolo are handled upstream/downstream.
    if (this.agent.permission.mode !== 'manual') return;
    return { kind: 'ask' };
  }
}
