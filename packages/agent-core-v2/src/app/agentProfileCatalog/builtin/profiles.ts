/**
 * `agentProfileCatalog` domain (L3) — builtin profile contributions.
 *
 * The `coder` and `explore` profiles ported from the old
 * `DEFAULT_AGENT_SUBAGENT_PROFILES` map. `explore` carries its own system-
 * prompt overlay (formerly `EXPLORE_ROLE_ADDITIONAL`), the `<git-context>`
 * prompt prefix (formerly `withGitContext`), and the 200-char summary
 * distillation policy (formerly `SUMMARY_MIN_LENGTH` /
 * `SUMMARY_CONTINUATION_ATTEMPTS` in `runChildAgent.ts`).
 *
 * Import-triggered registration: this module is side-effect-imported by
 * `#/app/agentProfileCatalog/builtin` so a top-level barrel load populates the
 * contribution list before `AgentProfileCatalogService` constructs.
 */

import { collectGitContext } from '#/session/agentFs';

import { registerAgentProfile } from '../contribution';

import EXPLORE_ROLE_ADDITIONAL from './explore-overlay.md?raw';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

const CODER_TOOLS = [
  'Agent',
  'AgentSwarm',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'ReadMediaFile',
  'Skill',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WebSearch',
  'FetchURL',
  'Write',
] as const;

const EXPLORE_TOOLS = [
  'Bash',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

registerAgentProfile({
  name: 'coder',
  description: 'General software engineering agent.',
  whenToUse:
    'Use for implementation, bug fixes, refactors, tests, and multi-step coding tasks that may edit files or run commands.',
  activeToolNames: CODER_TOOLS,
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'explore',
  description: 'Read-only codebase exploration specialist.',
  whenToUse:
    'Use for fast read-only exploration that needs more than a few searches: finding files, searching code, and answering codebase questions. Specify quick, medium, or thorough.',
  systemPromptOverlay: EXPLORE_ROLE_ADDITIONAL,
  activeToolNames: EXPLORE_TOOLS,
  promptPrefix: async ({ cwd, runner, log }) => {
    try {
      return await collectGitContext(runner, cwd, log);
    } catch {
      return '';
    }
  },
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});
