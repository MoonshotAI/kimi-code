/**
 * `agentLifecycle` domain — builtin agent profile contributions.
 *
 * Registers the default `agent` profile plus the `coder` / `explore` /
 * `tower-worker` task-agent profiles. Each profile is self-contained: its
 * structured `renderSystemPrompt` merges the shared base template with its own
 * role text at call time, so a child agent no longer inherits the parent's
 * prompt through a runtime overlay.
 *
 * The default profile deliberately carries no `subagents` allowlist: the
 * allowlist is enforced when present, and pinning one would block user-defined
 * file-based profiles. Leaving it `undefined` allows delegating to any
 * profile, `tower-worker` included.
 *
 * `tower-worker` drops `AgentSwarm` from the coder tool set on purpose: the
 * tower is the sole orchestrator, and a worker-side swarm fan-out would run
 * unbudgeted (the tower rate limit only gates TowerSpawn) and outside the
 * worktree/roster discipline — swarm children inherit the session cwd, the
 * main checkout, bypassing the review-gated merge protocol. The same argument
 * caps the remaining `Agent` delegation at read-only profiles
 * (`subagents: ['explore', 'plan']`): a write-capable child would run on the
 * main checkout outside the roster and the write guard. (v1 has no enforced
 * allowlist, so the v1 profile drops `Agent` entirely.)
 */

import { collectGitContext } from './gitContext';
import { TOWER_WORKER_PROFILE } from '#/agent/tower/tower';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

import EXPLORE_ROLE from './explore-overlay.md?raw';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';
import TOWER_WORKER_ROLE_OVERLAY from './tower-worker-overlay.md?raw';

const AGENT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronList',
  'CronDelete',
  'ReadMediaFile',
  'TodoList',
  'Skill',
  'WebSearch',
  'Agent',
  'AgentSwarm',
  'FetchURL',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'TowerInit',
  'mcp__*',
] as const;

const CODER_TOOLS = [
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
  'mcp__*',
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

registerAgentProfile({
  name: 'agent',
  description: 'Default agent',
  tools: AGENT_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult('', context, { skillActive: skillActiveFor(AGENT_TOOLS) }),
});

registerAgentProfile({
  name: 'coder',
  description:
    'General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code.',
  whenToUse:
    'Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(CODER_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'explore',
  description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
  whenToUse:
    'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. "src/**/*.yaml"), search code for keywords (e.g. "database connection"), or answer questions about the codebase (e.g. "how does the auth module work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
  tools: EXPLORE_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(EXPLORE_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
  promptPrefix: async ({ cwd, runner, log }) => {
    try {
      return await collectGitContext(runner, cwd, log);
    } catch {
      return '';
    }
  },
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
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
