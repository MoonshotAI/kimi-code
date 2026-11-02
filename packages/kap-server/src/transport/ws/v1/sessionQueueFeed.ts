import {
  IAgentLifecycleService,
  IAgentLoopService,
  MAIN_AGENT_ID,
  type IDisposable,
} from '@moonshot-ai/agent-core-v2';

import type { QueueStateWire } from '../../../protocol/rest-prompt';
import { projectQueueState } from '../../../routes/prompts';

const EMPTY_QUEUE: QueueStateWire = { paused: false, inputs: [] };

export class SessionQueueFeed implements IDisposable {
  private mainWatch: IDisposable | undefined;
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
    const loop = this.agents.handleOf(MAIN_AGENT_ID)?.accessor.get(IAgentLoopService);
    return loop === undefined ? EMPTY_QUEUE : projectQueueState(loop);
  }

  dispose(): void {
    for (const watch of this.lifecycleWatches) watch.dispose();
    this.unwatchMain();
  }

  private watchMain(): void {
    if (this.mainWatch !== undefined) return;
    const loop = this.agents.handleOf(MAIN_AGENT_ID)?.accessor.get(IAgentLoopService);
    this.mainWatch = loop?.onDidChangeQueue(() => this.publish());
  }

  private unwatchMain(): void {
    this.mainWatch?.dispose();
    this.mainWatch = undefined;
  }

  private publish(): void {
    const state = this.current();
    const key = JSON.stringify(state);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.onChange(state);
  }
}
