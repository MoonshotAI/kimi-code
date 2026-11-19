import {
  IAgentLifecycleService,
  IAgentTaskService,
  IEventBus,
  type IDisposable,
} from '@moonshot-ai/agent-core-v2';
import { TaskStarted, TaskTerminatedNotice } from '@moonshot-ai/agent-core-v2/agent/task/taskOps';
import type { AgentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';

import type { TaskState } from '../../../protocol/ws-task';
import { optionalService } from './agentState';
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
    const handle = this.agents.handleOf(agentId);
    const tasks = handle === undefined ? undefined : optionalService(handle, IAgentTaskService);
    return (tasks?.list(true) ?? []).map(toTaskState);
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
    const tasks = optionalService(handle, IAgentTaskService);
    const bus = optionalService(handle, IEventBus);
    const subscriptions: IDisposable[] = [];
    if (tasks !== undefined) {
      subscriptions.push(
        tasks.onDidChangeTask((info) => {
          this.onChange(agentId, info);
        }),
      );
    }
    if (bus !== undefined) {
      const onSwarmTask = (event: TaskStarted | TaskTerminatedNotice): void => {
        if (event.agentId === agentId && isSwarmTask(event.info)) this.onChange(agentId, event.info);
      };
      subscriptions.push(
        bus.subscribe(TaskStarted, onSwarmTask),
        bus.subscribe(TaskTerminatedNotice, onSwarmTask),
      );
    }
    if (subscriptions.length === 0) return;
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

function isSwarmTask(info: AgentTaskInfo): boolean {
  return info.kind === 'agent' && info.swarmIndex !== undefined;
}
