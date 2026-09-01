import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const FILE_HISTORY_FLAG_ID = 'file_history';
export const FILE_HISTORY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_FILE_HISTORY';

export const fileHistoryFlag: FlagDefinitionInput = {
  id: FILE_HISTORY_FLAG_ID,
  title: 'Turn-level file history',
  description:
    'Record each turn\'s edited files — their content from before the first edit and after the turn ends, kept for the last five turns — so per-turn file diffs come from real whole-file snapshots instead of tool-argument reconstruction.',
  env: FILE_HISTORY_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(fileHistoryFlag);
