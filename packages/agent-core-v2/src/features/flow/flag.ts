import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const flowFlag: FlagDefinitionInput = {
  id: 'flow',
  title: 'Flow runs',
  description:
    'Multi-stage flow runs: the main agent supervises user-defined stages from .kimi-code/flows definitions, dispatching workers and passing gated stage transitions.',
  env: 'KIMI_CODE_EXPERIMENTAL_FLOW',
  default: true,
  surface: 'both',
};

registerFlagDefinition(flowFlag);
