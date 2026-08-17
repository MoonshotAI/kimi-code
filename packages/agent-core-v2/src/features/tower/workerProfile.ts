/**
 * `tower` domain — the `tower-worker` agent profile: the profile TowerSpawn
 * binds on every worker/reviewer agent. Self-contained like the builtin
 * profiles — its structured `renderSystemPrompt` merges the shared base
 * template with the worker role text at call time.
 *
 * The worker drops `AgentSwarm` from the coder tool set on purpose: the tower
 * is the sole orchestrator, and a worker-side swarm fan-out would run
 * unbudgeted (the tower rate limit only gates TowerSpawn) and outside the
 * worktree/roster discipline — swarm children inherit the session cwd, the
 * main checkout, bypassing the review-gated merge protocol. The same argument
 * caps the remaining `Agent` delegation at read-only profiles
 * (`subagents: ['explore', 'plan']`): a write-capable child would run on the
 * main checkout outside the roster and the write guard.
 *
 * Contributed into the catalog by `towerFeature.ts` (the Feature seam), not
 * by the builtin profile module.
 */

import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';
// Read-only borrow of the shared summary-continuation prompt owned by the
// builtin profile module — keeps one source for the text. Relative path:
// the `#/` imports map cannot resolve `.md?raw` specifiers.
import SUMMARY_CONTINUATION_PROMPT from '../../session/agentLifecycle/profile/summary-continuation.md?raw';

import { TOWER_WORKER_PROFILE } from './tower';
import TOWER_WORKER_ROLE_OVERLAY from './tower-worker-overlay.md?raw';

const TOWER_WORKER_TOOLS = [
  'Agent',
  'Bash',
  'TowerFinding',
  'TowerInbox',
  'TowerMission',
  'TowerReview',
  'TowerSend',
  'TowerStatus',
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
  'mcp__*',
] as const;

// Mirrors the coder role in `session/agentLifecycle/profile/profiles.ts` —
// the tower-worker role is that handoff contract plus the tower overlay.
const CODER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Your final message is the entire handoff — the parent sees nothing else from your run. ' +
  'Make it technically complete: what you changed and why, the path of every file you touched, ' +
  'how you verified the change (tests or commands run, with results), and anything left undone ' +
  'or worth follow-up. A final message of only a sentence or two is treated as too brief and ' +
  'sent back to you for expansion, costing an extra turn.';

const TOWER_WORKER_ROLE = `${CODER_ROLE}\n\n${TOWER_WORKER_ROLE_OVERLAY.trim()}`;

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

export const TOWER_WORKER_PROFILE_DEF: AgentProfile = normalizeAgentProfile({
  name: TOWER_WORKER_PROFILE,
  description:
    'Tower worker/reviewer agent — executes one tower mission in its own git worktree (or reviews one branch), coordinating only through Tower* tools. Spawned via the TowerSpawn tool.',
  whenToUse:
    'Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.',
  tools: TOWER_WORKER_TOOLS,
  subagents: ['explore', 'plan'],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(TOWER_WORKER_ROLE, context, {
      skillActive: skillActiveFor(TOWER_WORKER_TOOLS),
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});
