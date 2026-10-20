import { BUILTIN_PROFILE_SOURCE_ID } from './catalog/catalog';
import { DEFAULT_AGENT_PROFILE_NAME, normalizeAgentProfile, type AgentProfile } from './definition/types';
import type { ProfileFinder } from './discovery/finder';
import EXPLORE_ROLE from './explore-overlay.md?raw';
import { collectGitContext } from './render/git-context';
import { renderSystemPromptResult } from './render/render';
import { skillActiveFor, TASK_AGENT_ROLE_PREFIX } from './shared';

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
  'WaitFor',
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
  'NotifyUser',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'TowerInit',
  'TowerStatus',
  'TowerTeardown',
  'mcp__*',
] as const;

const CODER_TOOLS = [
  'NotifyUser',
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
  'WaitFor',
  'WebSearch',
  'FetchURL',
  'Write',
  'mcp__*',
] as const;

const EXPLORE_TOOLS = [
  'NotifyUser',
  'Bash',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const PLAN_TOOLS = [
  'NotifyUser',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const CODER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Your final message is the entire handoff — the parent sees nothing else from your run. ' +
  'Make it technically complete: what you changed and why, the path of every file you touched, ' +
  'how you verified the change (tests or commands run, with results), and anything left undone ' +
  'or worth follow-up. If you are stopped before finishing, the parent receives only what ' +
  'you have written so far, so keep the handoff current.';

const PLAN_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Before designing your implementation plan, consider whether you fully understand the codebase areas ' +
  'relevant to the task. If not, recommend the parent agent to use the explore agent ' +
  '(subagent_type="explore") to investigate key questions first. In your response, clearly state:\n' +
  '1. What you already know from the information provided\n' +
  '2. What questions remain unanswered that would benefit from explore agent investigation\n' +
  '3. Your implementation plan (either preliminary if questions remain, or final if sufficient context exists)\n\n' +
  'You are a read-only planning agent: you can read and search files ' +
  'and consult the web, but you have no shell and no file-editing tools. ' +
  'Where the general instructions tell you to make changes with tools, that does not apply to you — ' +
  'do not attempt to run commands or modify files. Your deliverable is the plan itself, returned as ' +
  'your final message.';

export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  normalizeAgentProfile({
    name: 'agent',
    description: 'Default agent',
    tools: AGENT_TOOLS,
    subagents: ['coder', 'explore', 'plan'],
    renderSystemPrompt: (context) =>
      renderSystemPromptResult('', context, { skillActive: skillActiveFor(AGENT_TOOLS) }),
  }),
  normalizeAgentProfile({
    name: 'coder',
    description:
      'General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code.',
    whenToUse:
      'Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.',
    tools: CODER_TOOLS,
    renderSystemPrompt: (context) =>
      renderSystemPromptResult(CODER_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  }),
  normalizeAgentProfile({
    name: 'explore',
    description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
    whenToUse:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. "src/**/*.yaml"), search code for keywords (e.g. "database connection"), or answer questions about the codebase (e.g. "how does the auth module work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
    tools: EXPLORE_TOOLS,
    renderSystemPrompt: (context) =>
      renderSystemPromptResult(EXPLORE_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
    promptPrefix: async ({ cwd, process, log }) => {
      try {
        return process === undefined ? '' : await collectGitContext(process, cwd, log);
      } catch {
        return '';
      }
    },
  }),
  normalizeAgentProfile({
    name: 'plan',
    description: 'Read-only implementation planning and architecture design.',
    whenToUse:
      'Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.',
    tools: PLAN_TOOLS,
    renderSystemPrompt: (context) =>
      renderSystemPromptResult(PLAN_ROLE, context, { skillActive: skillActiveFor(PLAN_TOOLS) }),
  }),
];

export function createBuiltinFinder(): ProfileFinder {
  return {
    sourceId: BUILTIN_PROFILE_SOURCE_ID,
    load: () => ({ profiles: BUILTIN_PROFILES }),
  };
}

export function getBuiltinDefaultProfile(): AgentProfile {
  const profile = BUILTIN_PROFILES.find((entry) => entry.name === DEFAULT_AGENT_PROFILE_NAME);
  if (profile === undefined) {
    throw new Error(`Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`);
  }
  return profile;
}
