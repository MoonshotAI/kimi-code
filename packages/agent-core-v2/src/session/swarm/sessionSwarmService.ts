/**
 * `sessionSwarm` domain (L4) — `ISessionSwarmService` implementation.
 *
 * Runs a batch of subagents on behalf of a caller agent: builds a
 * `SubagentBatchLauncher` (backed by the `agentTool` run helpers), drives the
 * internal `SubagentBatch` scheduler, and tracks one `AbortController` per
 * caller so `cancel` can abort every in-flight run. `subagent.suspended` facts
 * are emitted on the caller agent's event sink. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import {
  resumeChildAgent,
  retryChildAgent,
  spawnChildAgent,
} from '#/agent/agentTool';
import { IAgentRecordService } from '#/agent/record';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  SubagentBatch,
  type SubagentBatchLauncher,
} from './subagentBatch';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
  ) {}

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    const { callerAgentId, tasks } = args;
    const controller = new AbortController();
    this.inFlight.set(callerAgentId, controller);
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const lifecycle = this.lifecycle;
    const launcher: SubagentBatchLauncher = {
      spawn: (options) => spawnChildAgent({ lifecycle, callerAgentId, ...options }),
      resume: (agentId, options) => resumeChildAgent({ lifecycle, callerAgentId, agentId, ...options }),
      retry: (agentId, options) => retryChildAgent({ lifecycle, callerAgentId, agentId, ...options }),
      suspended: (event) => {
        lifecycle.getHandle(callerAgentId)?.accessor.get(IAgentRecordService)?.signal({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new SubagentBatch(launcher, linkedTasks, { maxConcurrency }).run();
    void promise.finally(() => {
      for (const unlink of unlinks) unlink();
      if (this.inFlight.get(callerAgentId) === controller) this.inFlight.delete(callerAgentId);
    });
    return promise;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    this.inFlight.get(callerAgentId)?.abort();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSwarmService,
  SessionSwarmService,
  InstantiationType.Delayed,
  'sessionSwarm',
);
