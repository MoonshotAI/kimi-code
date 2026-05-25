import type { Agent } from '../..';
import type { PermissionPolicy } from '../policy';
import { AskUserQuestionAutoPermissionPolicy } from './ask-user-question';
import { CwdOutsideAskPermissionPolicy } from './cwd-outside-ask';
import { DefaultAutoAllowPermissionPolicy } from './default-auto-allow';
import { DefaultGitCwdWritePermissionPolicy } from './default-git-cwd-write';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import { PermissionModeApprovePolicy } from './permission-mode-approve';
import {
  EnterPlanModePermissionPolicy,
  ExitPlanModePermissionPolicy,
  PlanModeGuardPermissionPolicy,
} from './plan';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SystemSafetyPathAskPermissionPolicy } from './system-safety-path-ask';
import { UserConfiguredPermissionRulesPolicy } from './user-configured-rules';

export function createPermissionDecisionPolicies(agent: Agent): readonly PermissionPolicy[] {
  return [
    new UserConfiguredPermissionRulesPolicy(agent),
    new AskUserQuestionAutoPermissionPolicy(agent),
    new PlanModeGuardPermissionPolicy(agent),
    new SystemSafetyPathAskPermissionPolicy(agent),
    new SessionApprovalHistoryPermissionPolicy(agent),
    new CwdOutsideAskPermissionPolicy(agent),
    new ExitPlanModePermissionPolicy(agent),
    new PermissionModeApprovePolicy(agent),
    new EnterPlanModePermissionPolicy(),
    new DefaultAutoAllowPermissionPolicy(),
    new DefaultGitCwdWritePermissionPolicy(agent),
    new FallbackAskPermissionPolicy(),
  ];
}
