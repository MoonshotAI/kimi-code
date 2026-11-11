import { IAgentLifecycleService, IAgentTaskHistoryService, IEventBus, type IDisposable } from '@moonshot-ai/agent-core-v2';
import { TaskStarted, TaskTerminatedNotice } from '@moonshot-ai/agent-core-v2/agent/task/taskOps';
import type { AgentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';

import type { TaskState } from '../../../protocol/ws-task';
import { toTaskState } from './taskState';

export class SessionTaskFeed implements IDisposable {
  private readonly agentWatches = new Map<string, IDisposable>();
  private readonly lifecycleWatches: readonly IDisposable[];

  constructor(
    private readonly agents: IAgentLifecycleService,
    private readonly onChange: (agentId: string, info: AgentTaskInfo) => void,
  ) {
    for (const agent of agents.list()) this.watch(agent.agentId);
    this.lifecycleWatches = [
      agents.onDidCreate((agent) => this.watch(agent.agentId)),
      agents.onDidClose((agent) => this.unwatch(agent.agentId)),
    ];
  }

  agentIds(): readonly string[] {
    return this.agents.list().map((agent) => agent.agentId);
  }

  running(agentId: string): TaskState[] {
    const history = this.agents.handleOf(agentId)?.accessor.get(IAgentTaskHistoryService);
    return (history?.list(true) ?? []).map(toTaskState);
  }

  dispose(): void {
    for (const watch of this.lifecycleWatches) watch.dispose();
    for (const watch of this.agentWatches.values()) watch.dispose();
    this.agentWatches.clear();
  }

  private watch(agentId: string): void {
    if (this.agentWatches.has(agentId)) return;
    const handle = this.agents.handleOf(agentId);
    if (handle === undefined) return;
    handle.accessor.get(IAgentTaskHistoryService);
    const bus = handle.accessor.get(IEventBus);
    const subscriptions = [
      bus.subscribe(TaskStarted, (event) => {
        if (event.agentId === agentId) this.onChange(agentId, event.info);
      }),
      bus.subscribe(TaskTerminatedNotice, (event) => {
        if (event.agentId === agentId) this.onChange(agentId, event.info);
      }),
    ];
    this.agentWatches.set(agentId, {
      dispose: () => {
        for (const subscription of subscriptions) subscription.dispose();
      },
    });
  }

  private unwatch(agentId: string): void {
    this.agentWatches.get(agentId)?.dispose();
    this.agentWatches.delete(agentId);
  }
}
