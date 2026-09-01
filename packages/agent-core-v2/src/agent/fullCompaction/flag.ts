import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const COMPACTION_RECOVERY_POINTER_FLAG_ID = 'compaction_recovery_pointer';
export const COMPACTION_RECOVERY_POINTER_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_COMPACTION_RECOVERY_POINTER';

export const compactionRecoveryPointerFlag: FlagDefinitionInput = {
  id: COMPACTION_RECOVERY_POINTER_FLAG_ID,
  title: 'Compaction recovery pointer',
  description:
    'After compaction, append the agent event log location and per-window line ranges to the model-facing handoff note, let Read return wire.jsonl lines untruncated, and tell the summarizer that a recovery pointer follows the note.',
  env: COMPACTION_RECOVERY_POINTER_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(compactionRecoveryPointerFlag);
