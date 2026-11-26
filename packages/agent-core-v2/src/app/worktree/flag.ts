import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { WORKTREE_FLAG_ID } from './worktree';

export const WORKTREE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_WORKTREE';

export const worktreeFlag: FlagDefinitionInput = {
  id: WORKTREE_FLAG_ID,
  title: 'Git worktrees',
  description:
    'Start sessions in new git worktrees with kimi -w, and list, enter and remove them from the /worktree panel.',
  env: WORKTREE_FLAG_ENV,
  stages: {
    tui: 'beta',
  },
  effectTiming: 'immediate',
};

registerFlagDefinition(worktreeFlag);
