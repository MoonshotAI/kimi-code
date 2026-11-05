import type {
  IAgentPermissionPolicyService,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';

export function stubPermissionPolicyService(
  next: () => PermissionPolicyEvaluation | undefined,
  withoutModeApproval: () => PermissionPolicyEvaluation | undefined = () => undefined,
): IAgentPermissionPolicyService {
  return {
    _serviceBrand: undefined,
    evaluate: () => Promise.resolve(next()),
    evaluateWithoutModeApproval: () => Promise.resolve(withoutModeApproval()),
  };
}
