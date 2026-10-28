import {
  IAgentLifecycleService,
  IAgentTaskService,
  getLiveSessionById,
  type AgentTaskInfo,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { TranscriptTask } from '@moonshot-ai/transcript';

import type { TaskEventMessage } from '../../../protocol/ws-task';

export function taskEventMessages(
  core: Scope,
  sessionId: string,
  agentId: string,
  tasks: Iterable<TranscriptTask>,
): TaskEventMessage[] {
  const engineTasks = getLiveSessionById(core.accessor, sessionId)
    ?.accessor.get(IAgentLifecycleService)
    .handleOf(agentId)
    ?.accessor.get(IAgentTaskService);
  const createdAt = new Date().toISOString();
  return Array.from(tasks, (task) =>
    toTaskEventMessage(sessionId, agentId, createdAt, task, engineTasks?.getTask(task.taskId)),
  );
}

function toTaskEventMessage(
  sessionId: string,
  agentId: string,
  createdAt: string,
  task: TranscriptTask,
  info: AgentTaskInfo | undefined,
): TaskEventMessage {
  const running = task.state === 'running';
  return {
    type: 'task',
    session_id: sessionId,
    agent_id: agentId,
    event_created_at: createdAt,
    task_id: task.taskId,
    kind: task.kind,
    status: running ? 'running' : 'ended',
    outcome: running ? undefined : task.state,
    phase:
      running && task.kind === 'subagent'
        ? task.stateReason === undefined
          ? 'working'
          : 'suspended'
        : undefined,
    detached: task.detached,
    description: task.description,
    child_agent_id: task.agentId,
    parent_tool_call_id:
      info?.kind === 'process' || info?.kind === 'agent' ? info.parentToolCallId : undefined,
    command: info?.kind === 'process' ? info.command : undefined,
    started_at: task.startedAt,
    ended_at: running ? undefined : task.endedAt,
    result_summary: task.resultSummary,
    error: task.error,
    state_reason: task.stateReason,
    usage:
      task.usage === undefined
        ? undefined
        : {
            input_other: task.usage.inputOther,
            output: task.usage.output,
            input_cache_read: task.usage.inputCacheRead,
            input_cache_creation: task.usage.inputCacheCreation,
          },
    model: task.model ?? (info?.kind === 'agent' ? info.model : undefined),
    thinking: task.thinkingEffort ?? (info?.kind === 'agent' ? info.thinkingEffort : undefined),
  };
}
