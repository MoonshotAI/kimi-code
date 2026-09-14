import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBAGENT_FORK_FLAG_ID = 'subagent_fork';
export const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';

export const subagentForkFlag: FlagDefinitionInput = {
  id: SUBAGENT_FORK_FLAG_ID,
  title: 'Fork context for subagents',
  description:
    'Let the Agent and AgentSwarm tools start a subagent with a snapshot of the calling agent\'s conversation history via the fork parameter.',
  env: SUBAGENT_FORK_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentForkFlag);
