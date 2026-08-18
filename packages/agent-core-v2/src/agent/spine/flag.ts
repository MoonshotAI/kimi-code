import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SPINE_FLAG_ID = 'spine';
export const SPINE_FLAG_ENV = 'KIMI_CODE_SPINE';

export const spineFlag: FlagDefinitionInput = {
  id: SPINE_FLAG_ID,
  title: 'Spine (tree-of-work)',
  description:
    'Replace the flat todo list with a model-driven Spine tree of work nodes (spine_open / spine_close / spine_next); folds history around the tree and archives closed nodes under the session directory.',
  env: SPINE_FLAG_ENV,
  default: false,
  surface: 'core',
  ignoreMaster: true,
};

registerFlagDefinition(spineFlag);

export const SPINE_TRIM_FLAG_ID = 'spine_trim';
export const SPINE_TRIM_FLAG_ENV = 'KIMI_CODE_SPINE_TRIM';

/**
 * Gates the tool-response trim projection: oversized tool results carry a
 * stable `TRIM_ID` tag and the model can conservatively snip / slice them out
 * of the projected context via `spine_trim`. The stored history is never
 * rewritten. Runs STANDALONE (upstream `materialize_trim_only_context`): with
 * the spine flag off and this flag on, the trim projection applies over the
 * plain history without the tree fold; with both on, it integrates into the
 * spine fold's live ranges. Keeps `ignoreMaster: true` for the same reason.
 */
export const spineTrimFlag: FlagDefinitionInput = {
  id: SPINE_TRIM_FLAG_ID,
  title: 'Spine trim (tool-response trimming)',
  description:
    'Tag oversized tool results with a stable TRIM_ID and let the model conservatively trim them from the projected context (spine_trim); the stored history is never rewritten. Works standalone or inside the spine fold.',
  env: SPINE_TRIM_FLAG_ENV,
  default: false,
  surface: 'core',
  ignoreMaster: true,
};

registerFlagDefinition(spineTrimFlag);

export const SPINE_SPAWN_FLAG_ID = 'spine_spawn';
export const SPINE_SPAWN_FLAG_ENV = 'KIMI_CODE_SPINE_SPAWN';

/**
 * Gates the `spine_spawn` parallel branch fission experiment: the model can
 * split the current continuation into N independent child agents, each running
 * its own prompt and returning terminal memory. Requires the spine flag (the
 * spawn fold is integrated into the spine projector fold) and keeps
 * `ignoreMaster: true` for the same reason as the other spine flags.
 */
export const spineSpawnFlag: FlagDefinitionInput = {
  id: SPINE_SPAWN_FLAG_ID,
  title: 'Spine spawn (parallel branch fission)',
  description:
    'Experimental parallel branch fission via spine_spawn: split the current continuation into independent child agents, each returning terminal memory. Requires the spine flag.',
  env: SPINE_SPAWN_FLAG_ENV,
  default: false,
  surface: 'core',
  ignoreMaster: true,
};

registerFlagDefinition(spineSpawnFlag);
