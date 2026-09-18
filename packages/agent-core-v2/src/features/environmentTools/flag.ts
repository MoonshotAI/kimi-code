import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENT_ENVIRONMENT_TOOLS_FLAG_ID = 'agent_environment_tools';
export const AGENT_ENVIRONMENT_TOOLS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_ENVIRONMENT_TOOLS';

export const agentEnvironmentToolsFlag: FlagDefinitionInput = {
  id: AGENT_ENVIRONMENT_TOOLS_FLAG_ID,
  title: 'Agent environment tools',
  description:
    'Give the main agent the change_environment and connect tools so it can switch the session environment and create temporary environments itself.',
  env: AGENT_ENVIRONMENT_TOOLS_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentEnvironmentToolsFlag);
