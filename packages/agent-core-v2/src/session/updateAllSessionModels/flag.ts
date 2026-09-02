import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const UPDATE_ALL_SESSION_MODELS_FLAG_ID = 'update-all-session-models';
export const UPDATE_ALL_SESSION_MODELS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_UPDATE_ALL_SESSION_MODELS';

export const updateAllSessionModelsFlag: FlagDefinitionInput = {
  id: UPDATE_ALL_SESSION_MODELS_FLAG_ID,
  title: 'Bulk model switch for all sessions',
  description:
    'Expose the /update-all-session-models command: switch the working model of every active session at once (with confirmation) and update the new-session default.',
  env: UPDATE_ALL_SESSION_MODELS_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(updateAllSessionModelsFlag);
