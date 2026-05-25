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

export function createPermissionDecisionPolicies(agent: Agent): readonly PermissionPolicy[] {
  return [
    new PreToolCallHookPermissionPolicy(agent),
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    new PlanModeGuardDenyPermissionPolicy(agent),
    new UserConfiguredDenyPermissionPolicy(agent),
    new AutoModeApprovePermissionPolicy(agent),
    new UserConfiguredAskPermissionPolicy(agent),
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    new UserConfiguredAllowPermissionPolicy(agent),
    new SessionApprovalHistoryPermissionPolicy(agent),
    new PlanModeToolApprovePermissionPolicy(agent),
    new SensitiveFileAccessAskPermissionPolicy(agent),
    new GitControlPathAccessAskPermissionPolicy(agent),
    new CwdOutsideFileAccessAskPermissionPolicy(agent),
    new YoloModeApprovePermissionPolicy(agent),
    new DefaultToolApprovePermissionPolicy(),
    new GitCwdWriteApprovePermissionPolicy(agent),
    new FallbackAskPermissionPolicy(),
  ];
}
