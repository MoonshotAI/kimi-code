import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MULTI_ENVIRONMENT_FLAG_ID = 'multi_environment';
export const MULTI_ENVIRONMENT_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MULTI_ENVIRONMENT';

export const multiEnvironmentFlag: FlagDefinitionInput = {
  id: MULTI_ENVIRONMENT_FLAG_ID,
  title: 'Multi-environment sessions',
  description:
    'Let file and shell tools target any registered environment per call through an environment argument; remote environments connect on first use.',
  env: MULTI_ENVIRONMENT_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(multiEnvironmentFlag);
