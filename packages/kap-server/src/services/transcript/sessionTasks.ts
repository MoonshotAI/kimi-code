import { TERMINAL_STATUSES, type AgentTaskStatus } from '@moonshot-ai/agent-core-v2/agent/task/types';

import type { TaskEventMessage } from '../../protocol/ws-task';

type Task = Omit<TaskEventMessage, 'type' | 'session_id' | 'agent_id' | 'event_created_at' | 'phase'>;
type TaskOutcome = NonNullable<Task['outcome']>;
type Fields = Readonly<Record<string, unknown>>;

export interface TaskSourceEvent {
  readonly type: string;
}

export interface SessionTasksHost {
  readRecords(agentId: string): Promise<readonly TaskSourceEvent[]>;
  isRunning(agentId: string): boolean;
  onChange(message: TaskEventMessage): void;
}

interface AgentTasks {
  readonly tasks: Map<string, Task>;
  readonly subagentKeys: Map<string, string>;
  readonly shellKeys: Map<string, string>;
  pending: TaskSourceEvent[] | undefined;
}

const TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.started',
  'task.terminated',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'subagent.suspended',
  'shell.started',
  'shell.completed',
]);

export class SessionTasks {
  private readonly agents = new Map<string, { state: AgentTasks; loaded: Promise<void> }>();

  constructor(
    private readonly sessionId: string,
    private readonly host: SessionTasksHost,
  ) {}

  apply(agentId: string, event: TaskSourceEvent): void {
    if (!TASK_EVENT_TYPES.has(event.type)) return;
    const { state } = this.agentFor(agentId);
    if (state.pending !== undefined) {
      state.pending.push(event);
      return;
    }
    for (const task of foldTaskEvent(agentId, state, event)) {
      this.host.onChange(this.toMessage(agentId, task));
    }
  }

  whenLoaded(agentId: string): Promise<void> {
    return this.agentFor(agentId).loaded;
  }

  list(agentId: string): TaskEventMessage[] {
    const state = this.agents.get(agentId)?.state;
    if (state === undefined || state.pending !== undefined) return [];
    return Array.from(state.tasks.values(), (task) => this.toMessage(agentId, task));
  }

  private agentFor(agentId: string): { state: AgentTasks; loaded: Promise<void> } {
    const existing = this.agents.get(agentId);
    if (existing !== undefined) return existing;
    const state: AgentTasks = {
      tasks: new Map(),
      subagentKeys: new Map(),
      shellKeys: new Map(),
      pending: [],
    };
    const entry = { state, loaded: this.load(agentId, state) };
    this.agents.set(agentId, entry);
    return entry;
  }

  private async load(agentId: string, state: AgentTasks): Promise<void> {
    const records = await this.host.readRecords(agentId);
    const spawnedAt = new Map<string, number>();
    let lastTurnEnd = -1;
    records.forEach((record, index) => {
      if (record.type === 'turn.ended') lastTurnEnd = index;
      for (const task of foldTaskEvent(agentId, state, record)) {
        if (record.type === 'subagent.spawned') spawnedAt.set(task.task_id, index);
      }
    });
    const parentRunning = this.host.isRunning(agentId);
    for (const task of state.tasks.values()) {
      if (task.kind !== 'subagent' || task.detached || task.status !== 'running') continue;
      if (task.child_agent_id !== undefined && this.host.isRunning(task.child_agent_id)) continue;
      if (parentRunning && (spawnedAt.get(task.task_id) ?? -1) > lastTurnEnd) continue;
      state.tasks.set(task.task_id, { ...task, status: 'ended', outcome: 'lost' });
    }
    const pending = state.pending ?? [];
    state.pending = undefined;
    for (const event of pending) foldTaskEvent(agentId, state, event);
    for (const task of state.tasks.values()) this.host.onChange(this.toMessage(agentId, task));
  }

  private toMessage(agentId: string, task: Task): TaskEventMessage {
    return {
      type: 'task',
      session_id: this.sessionId,
      agent_id: agentId,
      event_created_at: new Date().toISOString(),
      ...task,
      phase:
        task.kind === 'subagent' && task.status === 'running'
          ? task.state_reason === undefined
            ? 'working'
            : 'suspended'
          : undefined,
    };
  }
}

function foldTaskEvent(agentId: string, state: AgentTasks, event: TaskSourceEvent): Task[] {
  const fields = event as unknown as Fields;
  const at = isoTime(fields['time']) ?? new Date().toISOString();
  switch (event.type) {
    case 'task.started':
    case 'task.terminated':
      return foldTaskInfo(state, fields['info']);
    case 'subagent.spawned':
      return fields['parentAgentId'] === agentId ? foldSubagentSpawned(state, fields, at) : [];
    case 'subagent.started':
    case 'subagent.suspended':
      return foldSubagentRun(state, fields, at, undefined);
    case 'subagent.completed':
      return foldSubagentRun(state, fields, at, 'completed');
    case 'subagent.failed':
      return foldSubagentRun(state, fields, at, 'failed');
    case 'subagent.cancelled':
      return foldSubagentRun(state, fields, at, 'killed');
    case 'shell.started':
      return foldShell(state, fields, at, undefined);
    case 'shell.completed':
      return foldShell(state, fields, at, fields['isError'] === true ? 'failed' : 'completed');
    default:
      return [];
  }
}

function foldTaskInfo(state: AgentTasks, raw: unknown): Task[] {
  if (raw === null || typeof raw !== 'object') return [];
  const info = raw as Fields;
  const taskId = text(info['taskId']);
  if (taskId === undefined) return [];
  const childAgentId = info['kind'] === 'agent' ? text(info['agentId']) : undefined;
  if (childAgentId !== undefined) state.subagentKeys.set(childAgentId, taskId);
  const prev = state.tasks.get(taskId);
  const outcome = TERMINAL_STATUSES.has(info['status'] as AgentTaskStatus)
    ? (info['status'] as TaskOutcome)
    : undefined;
  return [
    put(state, {
      ...prev,
      task_id: taskId,
      kind: info['kind'] === 'process' ? 'shell' : info['kind'] === 'agent' ? 'subagent' : 'other',
      status: outcome === undefined ? 'running' : 'ended',
      outcome,
      detached: typeof info['detached'] === 'boolean' ? info['detached'] : (prev?.detached ?? true),
      description: text(info['description']) ?? prev?.description,
      child_agent_id: childAgentId ?? prev?.child_agent_id,
      parent_tool_call_id: text(info['parentToolCallId']) ?? prev?.parent_tool_call_id,
      command: text(info['command']) ?? prev?.command,
      started_at: prev?.started_at ?? isoTime(info['startedAt']),
      ended_at: outcome === undefined ? undefined : (isoTime(info['endedAt']) ?? prev?.ended_at),
      model: text(info['model']) ?? prev?.model,
      thinking: text(info['thinkingEffort']) ?? prev?.thinking,
    }),
  ];
}

function foldSubagentSpawned(state: AgentTasks, event: Fields, at: string): Task[] {
  const childAgentId = text(event['subagentId']);
  if (childAgentId === undefined) return [];
  const taskId = text(event['taskId']);
  if (taskId === undefined) state.subagentKeys.delete(childAgentId);
  else state.subagentKeys.set(childAgentId, taskId);
  const key = taskId ?? childAgentId;
  const prev = state.tasks.get(key);
  const sameRun = prev?.status === 'running';
  return [
    put(state, {
      task_id: key,
      kind: 'subagent',
      status: 'running',
      detached: event['runInBackground'] === true,
      description: text(event['description']) ?? prev?.description,
      child_agent_id: childAgentId,
      parent_tool_call_id: text(event['parentToolCallId']) ?? prev?.parent_tool_call_id,
      started_at: sameRun ? (prev.started_at ?? at) : at,
      model: text(event['model']) ?? prev?.model,
      thinking: text(event['thinkingEffort']) ?? prev?.thinking,
    }),
  ];
}

function foldSubagentRun(
  state: AgentTasks,
  event: Fields,
  at: string,
  outcome: TaskOutcome | undefined,
): Task[] {
  const childAgentId = text(event['subagentId']);
  if (childAgentId === undefined) return [];
  const mapped = state.subagentKeys.get(childAgentId);
  const keys = mapped === undefined || mapped === childAgentId ? [childAgentId] : [mapped, childAgentId];
  const changed: Task[] = [];
  for (const key of keys) {
    const prev = state.tasks.get(key);
    if (prev === undefined) continue;
    const rerun = outcome === undefined && prev.status === 'ended';
    changed.push(
      put(state, {
        ...prev,
        status: outcome === undefined ? 'running' : 'ended',
        outcome,
        started_at: rerun ? at : (prev.started_at ?? at),
        ended_at: outcome === undefined ? undefined : at,
        result_summary: rerun ? undefined : (text(event['resultSummary']) ?? prev.result_summary),
        usage: rerun ? undefined : (usageOf(event['usage']) ?? prev.usage),
        error: rerun ? undefined : (text(event['error']) ?? prev.error),
        state_reason: text(event['reason']) ?? (rerun ? undefined : prev.state_reason),
      }),
    );
  }
  return changed;
}

function foldShell(
  state: AgentTasks,
  event: Fields,
  at: string,
  outcome: TaskOutcome | undefined,
): Task[] {
  const commandId = text(event['commandId']);
  if (commandId === undefined) return [];
  const taskId = state.shellKeys.get(commandId) ?? text(event['taskId']);
  if (taskId === undefined) return [];
  state.shellKeys.set(commandId, taskId);
  const prev = state.tasks.get(taskId);
  return [
    put(state, {
      ...prev,
      task_id: taskId,
      kind: prev?.kind ?? 'shell',
      status: outcome === undefined ? 'running' : 'ended',
      outcome,
      detached: prev?.detached ?? false,
      started_at: prev?.started_at ?? at,
      ended_at: outcome === undefined ? undefined : at,
    }),
  ];
}

function put(state: AgentTasks, task: Task): Task {
  state.tasks.set(task.task_id, task);
  return task;
}

function usageOf(raw: unknown): Task['usage'] {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { inputOther, output, inputCacheRead, inputCacheCreation } = raw as Fields;
  if (!isCount(inputOther) || !isCount(output) || !isCount(inputCacheRead) || !isCount(inputCacheCreation)) {
    return undefined;
  }
  return {
    input_other: inputOther,
    output,
    input_cache_read: inputCacheRead,
    input_cache_creation: inputCacheCreation,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
