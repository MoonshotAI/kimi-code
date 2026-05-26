import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  CwdOutsideFileAccessAskPermissionPolicy,
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';

/** Permission policies run in order; the first non-undefined result wins. */
export function createPermissionDecisionPolicies(agent: Agent): readonly PermissionPolicy[] {
  return [
    // PreToolUse hook returned a block → deny.
    new PreToolCallHookPermissionPolicy(agent),
    // auto mode + AskUserQuestion → deny.
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // plan mode: Write/Edit outside the plan file, or TaskStop → deny.
    new PlanModeGuardDenyPermissionPolicy(agent),
    // User-configured deny rule matches → deny.
    new UserConfiguredDenyPermissionPolicy(agent),
    // auto mode → approve (any auto-mode block must be a deny rule above this).
    new AutoModeApprovePermissionPolicy(agent),
    // User-configured ask rule matches → ask.
    new UserConfiguredAskPermissionPolicy(agent),
    // ExitPlanMode with active plan_review + non-empty plan + non-auto → ask (tracks plan_submitted/plan_resolved itself).
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    // User-configured allow rule matches → approve.
    new UserConfiguredAllowPermissionPolicy(agent),
    // Approve-for-session memorized rule matches → approve.
    new SessionApprovalHistoryPermissionPolicy(agent),
    // EnterPlanMode, Write/Edit on the plan file, or ExitPlanMode with no actionable plan_review → approve.
    new PlanModeToolApprovePermissionPolicy(agent),
    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    new SensitiveFileAccessAskPermissionPolicy(agent),
    // Access touches .git or a git control-dir path → ask.
    new GitControlPathAccessAskPermissionPolicy(agent),
    // File access target is outside cwd → ask.
    new CwdOutsideFileAccessAskPermissionPolicy(agent),
    // yolo mode → approve.
    new YoloModeApprovePermissionPolicy(agent),
    // Tool is in the default-approve list (read-only / UI helpers) → approve.
    new DefaultToolApprovePermissionPolicy(),
    // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
    new GitCwdWriteApprovePermissionPolicy(agent),
    // Nothing matched → ask.
    new FallbackAskPermissionPolicy(),
  ];
}
