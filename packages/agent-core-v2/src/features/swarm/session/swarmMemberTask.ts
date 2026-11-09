import type { IEventDispatcher } from '#/state/eventDispatcher';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import type { SubagentTaskInfo } from '#/agent/task/types';

import type { AgentRunAttemptHandle } from './agentRunBatch';
import type { SessionSwarmRunResult, SessionSwarmTask } from './sessionSwarm';

type MemberProjection = {
  info: SubagentTaskInfo;
  announced: boolean;
  settled: boolean;
};

export class SwarmMemberTasks {
  private readonly members = new Map<SessionSwarmTask, MemberProjection>();

  constructor(
    private readonly dispatcher: IEventDispatcher | undefined,
    private readonly agentId: string,
    members: readonly SessionSwarmTask[],
  ) {
    if (dispatcher === undefined) return;
    for (const member of members) {
      this.members.set(member, {
        announced: false,
        settled: false,
        info: {
          taskId: '',
          description: member.description,
          kind: 'agent',
          status: 'running',
          detached: member.runInBackground,
          startedAt: 0,
          endedAt: null,
          agentId: member.kind === 'resume' ? member.resumeAgentId : undefined,
          subagentType: member.profileName,
          parentToolCallId: member.parentToolCallId,
          model: member.kind === 'spawn' ? member.plan.model : undefined,
          thinkingEffort: member.kind === 'spawn' ? member.plan.thinking : undefined,
          swarmIndex: member.swarmIndex,
        },
      });
    }
  }

  started(member: SessionSwarmTask, handle: AgentRunAttemptHandle): void {
    const entry = this.members.get(member);
    if (entry === undefined || entry.settled) return;
    const firstStart = !entry.announced;
    entry.info = {
      ...entry.info,
      taskId: firstStart ? handle.agentId : entry.info.taskId,
      agentId: handle.agentId,
      subagentType: handle.profileName,
      model: handle.model ?? entry.info.model,
      thinkingEffort: handle.thinkingEffort ?? entry.info.thinkingEffort,
      stateReason: undefined,
      startedAt: firstStart ? Date.now() : entry.info.startedAt,
    };
    if (!firstStart) return;
    entry.announced = true;
    void this.dispatcher?.dispatch(new TaskStarted({ agentId: this.agentId, info: entry.info }));
  }

  suspended(member: SessionSwarmTask, reason: string): void {
    const entry = this.members.get(member);
    if (entry === undefined || entry.settled) return;
    entry.info = { ...entry.info, stateReason: reason };
  }

  settled(result: SessionSwarmRunResult): void {
    const entry = this.members.get(result.task);
    if (entry === undefined || !entry.announced || entry.settled) return;
    entry.settled = true;
    entry.info = {
      ...entry.info,
      agentId: result.agentId ?? entry.info.agentId,
      status: statusOf(result),
      endedAt: Date.now(),
      stopReason: result.error,
      stateReason: undefined,
      resultSummary: result.result,
    };
    void this.dispatcher?.dispatch(new TaskTerminated({ agentId: this.agentId, info: entry.info }));
  }

  failAll(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const member of this.members.keys()) {
      this.settled({ task: member, status: 'failed', error: message });
    }
  }
}

function statusOf(result: SessionSwarmRunResult): SubagentTaskInfo['status'] {
  switch (result.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'killed';
  }
}
