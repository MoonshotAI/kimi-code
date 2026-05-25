/**
 * First-launch migration prompt: pure decision mapping + prompter contract.
 *
 * This module owns the *decision tree* a user walks through when kimi-code
 * detects a legacy `~/.kimi/` install on first launch. It is deliberately
 * decoupled from any rendering: the renderer (pi-tui modal / readline / etc.)
 * gathers the two logical choices and feeds them to `resolveMigrationScope`,
 * which maps them into a `MigrationScope` (or a short-circuit decision).
 *
 * Two-layer prompt:
 *   Prompt 1: now | later | never
 *   Prompt 2 (only if "now"): config-only | all-sessions
 *
 * The host renders the questions (pi-tui migration screen); the package only
 * owns the decision logic.
 */
import type { MigrationScope } from './types.js';

export type Prompt1Choice = 'now' | 'later' | 'never';
export type Prompt2Choice = 'config-only' | 'all-sessions';
export type AnyChoice = Prompt1Choice | Prompt2Choice;

export interface MigrationPromptResult {
  readonly decision: 'now' | 'later' | 'never';
  readonly scope?: MigrationScope;
}

/**
 * Map the user's prompt choices into a migration decision + scope. Pure;
 * production logic (not a simulation).
 */
export function resolveMigrationScope(
  choices: readonly AnyChoice[],
): MigrationPromptResult {
  const [c1, c2] = choices;
  if (c1 === 'later') return { decision: 'later' };
  if (c1 === 'never') return { decision: 'never' };
  // c1 === 'now'
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
