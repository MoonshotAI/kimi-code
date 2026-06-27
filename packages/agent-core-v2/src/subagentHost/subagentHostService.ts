import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
  SpawnSubagentOptions,
  RunSubagentOptions,
  SubagentHandle,
} from './subagentHost';
import {
  ISubagentHost,
} from './subagentHost';
import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBackgroundService } from '#/background';
import { ILogService } from '#/log';
import { IProfileService } from '#/profile';
import { IToolRegistry } from '#/toolRegistry';
import { AgentTool } from './agentTool';

export class SubagentHostService extends Disposable implements ISubagentHost {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    @IToolRegistry toolRegistry: IToolRegistry,
    @IBackgroundService background: IBackgroundService,
    @IProfileService profile: IProfileService,
    @ILogService log?: ILogService,
  ) {
    super();

    const allowBackground =
      profile.isToolActive('TaskList') &&
      profile.isToolActive('TaskOutput') &&
      profile.isToolActive('TaskStop');

    this._register(
      toolRegistry.register(
        new AgentTool(this, background, undefined, {
          log,
          allowBackground,
        }),
      ),
    );
  }

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
      prompt: 'Initialize AGENTS.md for this workspace.',
      description: 'Initialize AGENTS.md',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;
  }

  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    return this.subagentHost.spawn(options);
  }

  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    return this.subagentHost.resume(agentId, options);
  }

  getProfileName(agentId: string): Promise<string | undefined> {
    return this.subagentHost.getProfileName(agentId);
  }

  markActiveChildDetached(agentId: string): void {
    this.subagentHost.markActiveChildDetached(agentId);
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

registerScopedService(
  LifecycleScope.Session,
  ISubagentHost,
  SubagentHostService,
  InstantiationType.Delayed,
  'subagentHost',
);
