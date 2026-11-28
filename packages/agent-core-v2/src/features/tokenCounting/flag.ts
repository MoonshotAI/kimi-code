import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const CONTEXT_INSPECTOR_FLAG_ID = 'context_inspector';
export const CONTEXT_INSPECTOR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_CONTEXT_INSPECTOR';

export const contextInspectorFlag: FlagDefinitionInput = {
  id: CONTEXT_INSPECTOR_FLAG_ID,
  title: 'Context usage',
  description:
    'Show context usage and composition in the composer ring and session info, and inspect each item the model receives.',
  env: CONTEXT_INSPECTOR_FLAG_ENV,
  stages: {
    desktop: 'beta',
    web: 'beta',
  },
  effectTiming: 'immediate',
};

registerFlagDefinition(contextInspectorFlag);
