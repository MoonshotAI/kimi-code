import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from '#/app/flag/flagRegistry';

export const EXEC_POLICY_FLAG_ID = 'exec-policy';
export const EXEC_POLICY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_EXEC_POLICY';

export const execPolicyFlag: FlagDefinitionInput = {
  id: EXEC_POLICY_FLAG_ID,
  title: 'Parsed exec-policy rules engine',
  description:
    'Evaluate agent shell commands against layered .rules files (prefix_rule/network_rule) on parsed argv segments instead of glob matching.',
  env: EXEC_POLICY_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(execPolicyFlag);
