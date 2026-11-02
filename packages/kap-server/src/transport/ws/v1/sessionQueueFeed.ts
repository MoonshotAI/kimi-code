import {
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentLoopService,
  MAIN_AGENT_ID,
  type IDisposable,
} from '@moonshot-ai/agent-core-v2';

import type { QueueStateWire } from '../../../protocol/rest-prompt';
import { projectQueueState } from '../../../routes/prompts';

const EMPTY_QUEUE: QueueStateWire = { paused: false, inputs: [] };

export class SessionQueueFeed implements IDisposable {
  private mainWatches: readonly IDisposable[] = [];
  private readonly lifecycleWatches: readonly IDisposable[];
  private lastPublished: string | undefined;

  constructor(
    private readonly agents: IAgentLifecycleService,
    private readonly onChange: (state: QueueStateWire) => void,
  ) {
    this.watchMain();
    this.lifecycleWatches = [
      agents.onDidCreate((agent) => {
        if (agent.agentId === MAIN_AGENT_ID) this.watchMain();
      }),
      agents.onDidClose((agent) => {
        if (agent.agentId === MAIN_AGENT_ID) this.unwatchMain();
      }),
    ];
  }

  current(): QueueStateWire {
    const accessor = this.agents.handleOf(MAIN_AGENT_ID)?.accessor;
    if (accessor === undefined) return EMPTY_QUEUE;
    return projectQueueState(accessor.get(IAgentLoopService), accessor.get(IAgentFullCompactionService));
  }

  dispose(): void {
    for (const watch of this.lifecycleWatches) watch.dispose();
    this.unwatchMain();
  }

  private watchMain(): void {
    if (this.mainWatches.length > 0) return;
    const accessor = this.agents.handleOf(MAIN_AGENT_ID)?.accessor;
    if (accessor === undefined) return;
    const publish = (): void => this.publish();
    this.mainWatches = [
      accessor.get(IAgentLoopService).onDidChangeQueue(publish),
      accessor.get(IAgentFullCompactionService).onDidChangeQueued(publish),
    ];
  }

  private unwatchMain(): void {
    for (const watch of this.mainWatches) watch.dispose();
    this.mainWatches = [];
  }

  private publish(): void {
    const state = this.current();
    const key = JSON.stringify(state);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.onChange(state);
  }
}
