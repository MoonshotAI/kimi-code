import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
  SpawnSubagentOptions,
  RunSubagentOptions,
  SubagentHandle,
} from './subagentHost';
import {
  ISessionSubagentHost,
} from './subagentHost';
import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/background';
import { ILogService } from '#/log';
import { IAgentProfileService } from '#/profile';
import { IKaos } from '#/kaos';
import { ISessionProcessRunner } from '#/process';
import { IAgentToolRegistryService } from '#/toolRegistry';
import { AgentTool } from './agentTool';

export class SessionSubagentHostService extends Disposable implements ISessionSubagentHost {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @IAgentProfileService profile: IAgentProfileService,
    @IKaos kaos: IKaos,
    @ISessionProcessRunner runner: ISessionProcessRunner,
    @ILogService log?: ILogService,
  ) {
    super();

    this._register(
      toolRegistry.register(
        new AgentTool(this, background, undefined, {
          log,
          gitContext: { cwd: kaos.cwd, runner },
          canRunInBackground: () => {
            return profile.isToolActive('TaskList') &&
              profile.isToolActive('TaskOutput') &&
              profile.isToolActive('TaskStop');
          },
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
  ISessionSubagentHost,
  SessionSubagentHostService,
  InstantiationType.Delayed,
  'subagentHost',
);
