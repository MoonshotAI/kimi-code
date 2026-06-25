import {
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from '../../../session/subagent-host';
import { DEFAULT_INIT_PROMPT } from '../../../profile';
import {
  ISubagentHost,
} from './subagentHost';

export class SubagentHostService implements ISubagentHost {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  getSwarmItem(agentId: string): string | undefined {
    return this.subagentHost?.getSwarmItem(agentId);
  }

  startBtw(): Promise<string> {
    return this.subagentHost.startBtw();
  }

  async generateAgentsMd(): Promise<void> {
    const handle = await this.subagentHost.spawn({
      profileName: 'coder',
      parentToolCallId: 'generate-agents-md',
      prompt: DEFAULT_INIT_PROMPT,
      description: 'Initialize AGENTS.md',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;
  }

  runQueued<T>(
    tasks: readonly QueuedSubagentTask<T>[],
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const subagentHost = this.subagentHost;
    if (subagentHost === undefined) {
      throw new Error('Subagent host is not configured.');
    }
    return subagentHost.runQueued(tasks);
  }
}

registerSingleton(
  ISubagentHost,
  new SyncDescriptor(SubagentHostService, [{}], true),
);
