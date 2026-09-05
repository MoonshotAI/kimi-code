import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBSTITUTE_MODEL_FLAG_ID = 'substitute-model';
export const SUBSTITUTE_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBSTITUTE_MODEL';

export const substituteModelFlag: FlagDefinitionInput = {
  id: SUBSTITUTE_MODEL_FLAG_ID,
  title: 'Substitute model for rate-limit fallback',
  description:
    'When the primary model hits a provider rate limit (e.g. 429 from account quota), automatically switch to a configured substitute model and continue until the primary recovers.',
  env: SUBSTITUTE_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(substituteModelFlag);
