import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

/**
 * `session/updateAllSessionModels` — registers the `update-all-session-models`
 * experimental flag into `flag`.
 *
 * Gates the `/update-all-session-models` TUI command (bulk model switch across
 * every active session). Mirror of the sibling gated flags
 * (`compaction-model`, `substitute-model`): while the experiment is disabled
 * the command is hidden from the palette and unresolvable, so the bulk
 * operation is strictly opt-in. When enabled, the command lists the active
 * sessions, shows the shared model picker, requires confirmation, applies the
 * chosen model to every session, and persists the new-session default.
 */
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
