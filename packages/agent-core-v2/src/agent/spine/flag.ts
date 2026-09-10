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
