import type { MigrationScope } from './types.js';

export type Prompt1Choice = 'now' | 'later' | 'never';
export type Prompt2Choice = 'config-only' | 'all-sessions';
export type AnyChoice = Prompt1Choice | Prompt2Choice;

export interface MigrationPromptResult {
  readonly decision: 'now' | 'later' | 'never';
  readonly scope?: MigrationScope;
}

export function resolveMigrationScope(
  choices: readonly AnyChoice[],
): MigrationPromptResult {
  const [c1, c2] = choices;
  if (c1 === 'later') return { decision: 'later' };
  if (c1 === 'never') return { decision: 'never' };
  return {
    decision: 'now',
    scope: {
      config: true,
      mcp: true,
      userHistory: true,
      skills: true,
      sessions: c2 === 'all-sessions',
    },
  };
}
