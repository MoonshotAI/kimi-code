import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PERMISSION_DECISION_HOOK_FLAG_ID = 'permission-decision-hook';
export const PERMISSION_DECISION_HOOK_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_PERMISSION_DECISION_HOOK';

export const permissionDecisionHookFlag: FlagDefinitionInput = {
  id: PERMISSION_DECISION_HOOK_FLAG_ID,
  title: 'Permission decision hook',
  description:
    'Let a blocking PermissionDecisionRequest hook allow or deny an ordinary tool approval before falling back to the native approval surface.',
  env: PERMISSION_DECISION_HOOK_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(permissionDecisionHookFlag);
