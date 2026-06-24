/**
 * `background` domain (L5) — `IBackgroundService` implementation.
 *
 * Tracks background tasks in-memory with an output ring buffer. Process /
 * agent / question task spawning is wired in a later step.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IAgentKaos } from '#/kaos/kaos';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { ITelemetryService } from '#/telemetry/telemetry';

import { type BackgroundTask, IBackgroundService } from './background';

interface RunningTask {
  readonly task: BackgroundTask;
  output: string;
  stopped: boolean;
}

let nextTaskId = 0;

export class BackgroundService extends Disposable implements IBackgroundService {
  declare readonly _serviceBrand: undefined;
  private readonly tasks = new Map<string, RunningTask>();

  constructor(
    @IAgentKaos _agentKaos: IAgentKaos,
    @IAgentRecords _records: IAgentRecords,
    @ILogService _log: ILogService,
    @ITelemetryService _telemetry: ITelemetryService,
    @IAgentLifecycleService _agentLifecycle: IAgentLifecycleService,
  ) {
    super();
  }

  start(task: BackgroundTask): Promise<string> {
    const id = `task-${nextTaskId++}`;
    this.tasks.set(id, { task, output: '', stopped: false });
    return Promise.resolve(id);
  }

  stop(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t !== undefined) t.stopped = true;
    return Promise.resolve();
  }

  list(): readonly BackgroundTask[] {
    return [...this.tasks.values()].map((t) => t.task);
  }

  getOutput(id: string): Promise<string> {
    return Promise.resolve(this.tasks.get(id)?.output ?? '');
  }
}

registerScopedService(LifecycleScope.Agent, IBackgroundService, BackgroundService, InstantiationType.Delayed, 'background');
