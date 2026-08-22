import type {
  IAgentPermissionRulesService,
  PermissionRule,
} from '#/agent/permissionRules/permissionRules';

export function stubPermissionRulesService(
  rules: () => readonly PermissionRule[],
): IAgentPermissionRulesService {
  return {
    _serviceBrand: undefined,
    get rules() {
      return rules();
    },
    sessionApprovalRulePatterns: [],
    addRules: () => {},
    recordApprovalResult: () => {},
  };
}
