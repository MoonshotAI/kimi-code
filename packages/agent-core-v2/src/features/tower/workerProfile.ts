import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';
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
