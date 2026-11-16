import plannerPrompt from './planner.md?raw';
import workerPrompt from './worker.md?raw';
import retesterPrompt from './retester.md?raw';
import untrustedContentRules from './untrusted-content.md?raw';
import untrustedDataRules from './untrusted-data.md?raw';
import compactorDataRule from './untrusted-compactor.md?raw';
import workerWrapup from './worker-wrapup.md?raw';
import plannerWrapup from './planner-wrapup.md?raw';
import mainAgentWrapup from './mainagent-wrapup.md?raw';
import genericWrapup from './generic-wrapup.md?raw';
import workerTaskTimeoutWrapup from './worker-task-timeout-wrapup.md?raw';
import plannerTaskTimeoutWrapup from './planner-task-timeout-wrapup.md?raw';
import workerBudgetWrapup from './worker-budget-wrapup.md?raw';
import plannerBudgetWrapup from './planner-budget-wrapup.md?raw';

export const ARTEX_PLANNER_PROMPT = plannerPrompt;
export const ARTEX_WORKER_PROMPT = workerPrompt;
export const ARTEX_RETESTER_PROMPT = retesterPrompt;

export const ARTEX_UNTRUSTED_CONTENT_RULES = untrustedContentRules;
export const ARTEX_UNTRUSTED_DATA_RULES = untrustedDataRules;
export const ARTEX_COMPACTOR_DATA_RULE = compactorDataRule;

export const ARTEX_WORKER_WRAPUP = workerWrapup;
export const ARTEX_PLANNER_WRAPUP = plannerWrapup;
export const ARTEX_MAIN_AGENT_WRAPUP = mainAgentWrapup;
export const ARTEX_GENERIC_WRAPUP = genericWrapup;
export const ARTEX_WORKER_TASK_TIMEOUT_WRAPUP = workerTaskTimeoutWrapup;
export const ARTEX_PLANNER_TASK_TIMEOUT_WRAPUP = plannerTaskTimeoutWrapup;
export const ARTEX_WORKER_BUDGET_WRAPUP = workerBudgetWrapup;
export const ARTEX_PLANNER_BUDGET_WRAPUP = plannerBudgetWrapup;

export * from './noiseProfile';
export * from './goal';
export * from './dataEnvelope';
export * from './platformControl';
export * from './constraintBlock';
