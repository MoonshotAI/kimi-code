import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

import {
  ARTEX_COMPACTOR_DATA_RULE,
  ARTEX_PLANNER_PROMPT,
  ARTEX_UNTRUSTED_DATA_RULES,
  ARTEX_WORKER_PROMPT,
} from '#/features/artex/prompts/index';

export const ARTEX_PLANNER_PROFILE = 'artex-planner';
export const ARTEX_WORKER_PROFILE = 'artex-worker';
export const ARTEX_COMPACTOR_PROFILE = 'artex-compactor';

export const ARTEX_STANDARD_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'FetchURL',
  'WebSearch',
  'TodoList',
  'Skill',
  'mcp__*',
];

export const ARTEX_PLANNER_TOOL_NAMES: readonly string[] = [
  'graph_overview',
  'list_findings',
  'list_facts',
  'node_detail',
  'expand_digest',
  'get_worker_output',
  'get_worker_trace',
  'search_all_worker_traces',
  'list_worker_traces',
  'list_goals',
  'add_intent',
  'prove_goal',
  'goal_met',
  'kill_work',
  'steer_work',
  'report_finding',
  'list_companies',
  'list_assets',
  'add_company_scope',
  'add_task_scope',
  'list_untested_assets',
  'traffic_search',
  'traffic_get',
  'traffic_blob',
  'bind_finding_traffic',
];

export const ARTEX_WORKER_TOOL_NAMES: readonly string[] = [
  'list_findings',
  'report_finding',
  'record_fact',
  'record_coverage',
  'insert_assets',
  'list_assets',
  'save_task_credential',
  'list_task_credentials',
  'search_all_worker_traces',
  'get_worker_trace',
  'list_worker_traces',
  'node_detail',
  'traffic_search',
  'traffic_get',
  'traffic_blob',
  'bind_finding_traffic',
];

export const ARTEX_MAIN_AGENT_TOOL_NAMES: readonly string[] = [
  'start_artex_exploration',
  'graph_overview',
  'list_findings',
  'list_facts',
  'list_goals',
  'node_detail',
  'expand_digest',
  'get_worker_output',
  'get_worker_trace',
  'search_all_worker_traces',
  'list_worker_traces',
  'add_hint',
  'add_intent',
  'steer_work',
  'kill_work',
  'set_goals',
  'set_constraints',
  'insert_assets',
  'add_company_scope',
  'list_assets',
  'list_companies',
  'report_finding',
  'record_fact',
  'add_task_scope',
  'list_untested_assets',
  'traffic_search',
  'traffic_get',
  'traffic_blob',
  'bind_finding_traffic',
];

export const ARTEX_ALL_TOOL_NAMES: readonly string[] = [
  ...new Set([
    ...ARTEX_PLANNER_TOOL_NAMES,
    ...ARTEX_WORKER_TOOL_NAMES,
    ...ARTEX_MAIN_AGENT_TOOL_NAMES,
  ]),
];

export const artexPlannerProfile: AgentProfile = normalizeAgentProfile({
  name: ARTEX_PLANNER_PROFILE,
  description: 'ARTEX planner: reads the exploration graph and emits intents toward the goal.',
  tools: [...ARTEX_STANDARD_TOOLS, ...ARTEX_PLANNER_TOOL_NAMES],
  systemPrompt: () => ARTEX_PLANNER_PROMPT,
});

export const artexWorkerProfile: AgentProfile = normalizeAgentProfile({
  name: ARTEX_WORKER_PROFILE,
  description: 'ARTEX worker: executes a single intent and writes back facts, findings, and coverage.',
  tools: [...ARTEX_STANDARD_TOOLS, ...ARTEX_WORKER_TOOL_NAMES],
  systemPrompt: () => ARTEX_WORKER_PROMPT,
});

export const artexCompactorProfile: AgentProfile = normalizeAgentProfile({
  name: ARTEX_COMPACTOR_PROFILE,
  description: 'ARTEX compactor: summarizes cold exploration graph regions into durable digests.',
  tools: [],
  systemPrompt: () => `${ARTEX_UNTRUSTED_DATA_RULES}\n${ARTEX_COMPACTOR_DATA_RULE}`,
});

export const ARTEX_PROFILES: readonly AgentProfile[] = [
  artexPlannerProfile,
  artexWorkerProfile,
  artexCompactorProfile,
];
