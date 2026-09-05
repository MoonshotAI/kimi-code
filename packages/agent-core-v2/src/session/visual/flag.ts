
import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const VISUAL_MODEL_FLAG_ID = 'visual-model';
export const VISUAL_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_VISUAL_MODEL';

export const visualModelFlag: FlagDefinitionInput = {
  id: VISUAL_MODEL_FLAG_ID,
  title: 'Visual model for image/screenshot inspection',
  description:
    'Let image / screenshot / video inspection tasks use a separately configured visual model by default, so a text-only coding model can still drive visual work via a vision-capable companion model.',
  env: VISUAL_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(visualModelFlag);
