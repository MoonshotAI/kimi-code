import { TERMINAL_STATUSES, type AgentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';

import type { TaskEventMessage, TaskState } from '../../../protocol/ws-task';

type TaskOutcome = NonNullable<TaskState['outcome']>;

export function toTaskState(info: AgentTaskInfo): TaskState {
  const ended = TERMINAL_STATUSES.has(info.status);
  const subagent = info.kind === 'agent' ? info : undefined;
  const shell = info.kind === 'process' ? info : undefined;
  const stateReason = ended ? undefined : subagent?.stateReason;
  return {
    task_id: info.taskId,
    kind: shell !== undefined ? 'shell' : subagent !== undefined ? 'subagent' : 'other',
    status: ended ? 'ended' : 'running',
    outcome: ended ? (info.status as TaskOutcome) : undefined,
    phase: subagent === undefined || ended ? undefined : stateReason === undefined ? 'working' : 'suspended',
    detached: info.detached !== false,
    description: text(info.description),
    child_agent_id: text(subagent?.agentId),
    parent_tool_call_id: text(subagent?.parentToolCallId ?? shell?.parentToolCallId),
    swarm_index: subagent?.swarmIndex,
    command: text(shell?.command),
    started_at: new Date(info.startedAt).toISOString(),
    ended_at: info.endedAt === null ? undefined : new Date(info.endedAt).toISOString(),
    result_summary: text(subagent?.resultSummary),
    error: info.status === 'failed' ? text(info.stopReason) : undefined,
    state_reason: text(stateReason),
    model: text(subagent?.model),
    thinking: text(subagent?.thinkingEffort),
  };
}

export function toTaskMessage(sessionId: string, agentId: string, info: AgentTaskInfo): TaskEventMessage {
  return {
    type: 'task',
    session_id: sessionId,
    agent_id: agentId,
    event_created_at: new Date().toISOString(),
    ...toTaskState(info),
  };
}

function text(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
