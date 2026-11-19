import type { AppSubagentPhase, AppTask, AppTaskStatus, SessionTask } from '../api/types';

function toAppTaskStatus(state: SessionTask['state']): AppTaskStatus {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'killed':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function toSubagentPhase(task: SessionTask, status: AppTaskStatus): AppSubagentPhase {
  if (status === 'running') return task.phase === 'suspended' ? 'suspended' : 'working';
  return status;
}

function toAppTaskKind(kind: SessionTask['kind']): AppTask['kind'] {
  if (kind === 'subagent') return 'subagent';
  if (kind === 'shell') return 'bash';
  return 'tool';
}

export function sessionTasksToAppTasks(tasks: readonly SessionTask[], sessionId: string): AppTask[] {
  return tasks.map((task) => {
    const status = toAppTaskStatus(task.state);
    return {
      id: task.taskId,
      agentId: task.agentId,
      sessionId,
      kind: toAppTaskKind(task.kind),
      description: task.description ?? '',
      status,
      command: task.command,
      createdAt: task.startedAt ?? '',
      startedAt: task.startedAt,
      completedAt: task.endedAt,
      text: task.resultSummary,
      subagentPhase: task.kind === 'subagent' ? toSubagentPhase(task, status) : undefined,
      suspendedReason: status === 'running' ? task.stateReason : undefined,
      model: task.model,
      thinkingEffort: task.thinkingEffort,
      runInBackground: task.detached,
      parentToolCallId: task.parentToolCallId,
      swarmIndex: task.swarmIndex,
    };
  });
}

const SUBAGENT_NAME_MAX_LENGTH = 40;

export function subagentDisplayName(tasks: readonly SessionTask[], agentId: string): string {
  const own = tasks.filter((task) => task.kind === 'subagent' && task.agentId === agentId);
  const description = (own.find((task) => task.state === 'running') ?? own.at(-1))?.description?.trim();
  if (description === undefined || description === '') return agentId;
  const chars = Array.from(description);
  if (chars.length <= SUBAGENT_NAME_MAX_LENGTH) return description;
  return `${chars.slice(0, SUBAGENT_NAME_MAX_LENGTH - 1).join('').trimEnd()}…`;
}
