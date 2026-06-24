import {
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from '../../../session/subagent-host';
import {
  ISubagentHost,
} from './subagentHost';

export class SubagentHostService implements ISubagentHost {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  getSwarmItem(agentId: string): string | undefined {
    return this.subagentHost?.getSwarmItem(agentId);
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
