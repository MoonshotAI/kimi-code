import {
  foldWireRecords,
  fromPersistentWireRecord,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import type { GoalSnapshot } from '@moonshot-ai/agent-core-v2/features/goal/types';

import type {
  AgentState,
  GoalState,
  TodoItemState,
  UsageState,
} from '../../protocol/ws-agent';

export interface ColdAgentFeed {
  readonly agent: AgentState;
  readonly usage?: UsageState;
  readonly goal?: GoalState;
  readonly todos: readonly TodoItemState[];
}

export function projectColdAgentFeed(records: readonly WireRecord[]): ColdAgentFeed {
  const { replay, toolStore } = foldWireRecords(records, fromPersistentWireRecord);
  let model: string | undefined;
  let thinking: string | undefined;
  let permission: AgentState['permission_mode'];
  let planMode = false;
  let swarmMode = false;
  let towerMode = false;
  let contextTokens: number | undefined;
  let maxContextTokens: number | undefined;
  let goal: GoalSnapshot | undefined;
  let goalClearedAt = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (record.type === 'goal.clear' || record.type === 'forked') {
      goalClearedAt = Math.max(goalClearedAt, record.time ?? 0);
    }
  }

  for (const entry of replay) {
    switch (entry.type) {
      case 'config_updated':
        model = entry.config.modelAlias ?? model;
        thinking = entry.config.thinkingLevel ?? thinking;
        break;
      case 'permission_updated':
        permission = entry.mode;
        break;
      case 'plan_updated':
        planMode = entry.enabled;
        break;
      case 'goal_updated':
        if (entry.time >= goalClearedAt) goal = entry.snapshot;
        break;
      default:
        break;
    }
  }

  for (const record of records) {
    if (record.type === 'agent.status.updated') {
      const status = readStatus(record);
      model = status.model ?? model;
      thinking = status.thinking ?? thinking;
      permission = status.permission ?? permission;
      planMode = status.planMode ?? planMode;
      swarmMode = status.swarmMode ?? swarmMode;
      towerMode = status.towerMode ?? towerMode;
      contextTokens = status.contextTokens ?? contextTokens;
      maxContextTokens = status.maxContextTokens ?? maxContextTokens;
      continue;
    }
    if (record.type !== 'context.append_loop_event') continue;
    const event = record['event'];
    if (!isRecord(event) || event['type'] !== 'agent.status.updated') continue;
    const status = readStatus(event);
    model = status.model ?? model;
    thinking = status.thinking ?? thinking;
    permission = status.permission ?? permission;
    planMode = status.planMode ?? planMode;
    swarmMode = status.swarmMode ?? swarmMode;
    towerMode = status.towerMode ?? towerMode;
    contextTokens = status.contextTokens ?? contextTokens;
    maxContextTokens = status.maxContextTokens ?? maxContextTokens;
  }

  return {
    agent: {
      status: 'idle',
      model: text(model),
      thinking: model === undefined || model.length === 0 ? undefined : text(thinking),
      permission_mode: permission,
      plan_mode: planMode,
      swarm_mode: swarmMode,
      tower_mode: towerMode,
    },
    usage: contextTokens === undefined
      ? undefined
      : {
          context_tokens: Math.max(0, Math.round(contextTokens)),
          max_context_tokens:
            maxContextTokens !== undefined && maxContextTokens > 0
              ? Math.round(maxContextTokens)
              : undefined,
        },
    goal: goal === undefined
      ? undefined
      : {
          objective: goal.objective,
          status: goal.status,
          completion_criterion: text(goal.completionCriterion),
          turns_used: goal.turnsUsed,
          tokens_used: goal.tokensUsed,
          wall_clock_ms: Math.max(0, Math.round(goal.wallClockMs)),
        },
    todos: readTodos(toolStore['todo']),
  };
}

interface ColdStatus {
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: AgentState['permission_mode'];
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
}

function readStatus(record: Record<string, unknown>): ColdStatus {
  const permission = record['permission'];
  return {
    model: stringValue(record['model']),
    thinking: stringValue(record['thinkingEffort']),
    permission:
      permission === 'manual' || permission === 'yolo' || permission === 'auto'
        ? permission
        : undefined,
    planMode: booleanValue(record['planMode']),
    swarmMode: booleanValue(record['swarmMode']),
    towerMode: booleanValue(record['towerMode']),
    contextTokens: numberValue(record['contextTokens']),
    maxContextTokens: numberValue(record['maxContextTokens']),
  };
}

function readTodos(value: unknown): TodoItemState[] {
  if (!Array.isArray(value)) return [];
  const result: TodoItemState[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['title'] !== 'string') continue;
    const status = item['status'];
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') continue;
    result.push({ title: item['title'], status });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function text(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
