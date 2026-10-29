import type { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask, AgentTaskInfoBase, AgentTaskSettlement, AgentTaskSink } from '#/agent/task/types';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';

import type { SessionSwarmRunResult, SessionSwarmTask } from './sessionSwarm';

export class SwarmMemberTasks {
  private readonly members = new Map<SessionSwarmTask, { readonly task: SwarmMemberTask; readonly taskId: string }>();

  constructor(
    private readonly tasks: IAgentTaskService | undefined,
    members: readonly SessionSwarmTask[],
    cancelSwarm: (reason: unknown) => void,
  ) {
    if (tasks === undefined) return;
    for (const member of members) {
      const task = new SwarmMemberTask(member, cancelSwarm);
      try {
        this.members.set(member, { task, taskId: tasks.registerTask(task, { detached: member.runInBackground }) });
      } catch {
      }
    }
  }

  started(member: SessionSwarmTask, agentId: string): void {
    const entry = this.members.get(member);
    if (entry === undefined) return;
    entry.task.started(agentId);
    this.tasks?.refresh(entry.taskId);
  }

  suspended(member: SessionSwarmTask, reason: string): void {
    const entry = this.members.get(member);
    if (entry === undefined) return;
    entry.task.suspended(reason);
    this.tasks?.refresh(entry.taskId);
  }

  settled(result: SessionSwarmRunResult): void {
    this.members.get(result.task)?.task.settled(result);
  }

  failAll(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const [member, { task }] of this.members) {
      task.settled({ task: member, status: 'failed', error: message });
    }
  }
}

export class SwarmMemberTask implements AgentTask {
  readonly kind = 'agent' as const;
  readonly idPrefix = 'agent';
  readonly description: string;
  private agentId: string | undefined;
  private stateReason: string | undefined;
  private resultSummary: string | undefined;
  private sink: AgentTaskSink | undefined;
  private result: SessionSwarmRunResult | undefined;
  private finish: (() => void) | undefined;
  private readonly cancelOnAbort = (): void => {
    this.cancelSwarm(this.sink?.signal.reason);
  };

  constructor(
    private readonly member: SessionSwarmTask,
    private readonly cancelSwarm: (reason: unknown) => void,
  ) {
    this.description = member.description;
    this.agentId = member.kind === 'resume' ? member.resumeAgentId : undefined;
  }

  start(sink: AgentTaskSink): Promise<void> {
    this.sink = sink;
    if (sink.signal.aborted) this.cancelOnAbort();
    else sink.signal.addEventListener('abort', this.cancelOnAbort, { once: true });
    return new Promise((resolve) => {
      this.finish = resolve;
      if (this.result !== undefined) void this.settleWith(this.result);
    });
  }

  started(agentId: string): void {
    this.agentId = agentId;
    this.stateReason = undefined;
  }

  suspended(reason: string): void {
    this.stateReason = reason;
  }

  settled(result: SessionSwarmRunResult): void {
    if (this.result !== undefined) return;
    this.result = result;
    if (this.sink !== undefined) void this.settleWith(result);
  }

  toInfo(base: AgentTaskInfoBase): SubagentTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.member.profileName,
      parentToolCallId: this.member.parentToolCallId,
      model: this.member.kind === 'spawn' ? this.member.plan.model : undefined,
      swarmIndex: this.member.swarmIndex,
      stateReason: this.stateReason,
      resultSummary: this.resultSummary,
    };
  }

  private async settleWith(result: SessionSwarmRunResult): Promise<void> {
    const sink = this.sink!;
    sink.signal.removeEventListener('abort', this.cancelOnAbort);
    this.agentId = result.agentId ?? this.agentId;
    this.stateReason = undefined;
    this.resultSummary = result.result;
    await sink.settle(settlementOf(result));
    this.finish?.();
  }
}

function settlementOf(result: SessionSwarmRunResult): AgentTaskSettlement {
  switch (result.status) {
    case 'completed':
      return { status: 'completed' };
    case 'failed':
      return { status: 'failed', stopReason: result.error };
    case 'aborted':
      return { status: 'killed', stopReason: result.error };
  }
}
