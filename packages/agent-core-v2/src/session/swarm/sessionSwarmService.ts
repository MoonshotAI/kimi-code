/**
 * `sessionSwarm` domain (L4) — `ISessionSwarmService` implementation.
 *
 * Runs a batch of subagents on behalf of a caller agent: builds a
 * `SubagentBatchLauncher` on top of the `agentLifecycle` primitives
 * (`spawn`, `applyProfileToAgent`, `observeChildAgentTurn`), drives the
 * internal `SubagentBatch` scheduler, and tracks one `AbortController` per
 * caller so `cancel` can abort every in-flight run. `subagent.spawned` facts
 * carrying the swarm's tool-call context, and `subagent.suspended` facts
 * emitted when a task is requeued after a provider rate limit, are recorded
 * on the caller agent's event sink; the child's own turn lifecycle
 * (`subagent.started/completed/failed`) is mirrored inside
 * `observeChildAgentTurn`. Bound at Session scope.
 */

import type { TokenUsage } from '#/app/llmProtocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentRecordService } from '#/agent/record';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog';
import {
  IAgentLifecycleService,
  applyProfileToAgent,
  observeChildAgentTurn,
} from '#/session/agentLifecycle';
import { IExecContext } from '#/session/execContext';
import { ISessionProcessRunner } from '#/session/process';
import { ILogService } from '#/app/log';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  SubagentBatch,
  type RunSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentBatchLauncher,
  type SubagentHandle,
} from './subagentBatch';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @IExecContext private readonly execContext: IExecContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ILogService private readonly log: ILogService,
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
    const launcher: SubagentBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.getHandle(callerAgentId);
        caller?.accessor.get(IAgentRecordService)?.signal({
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

  private async spawnAttempt(
    callerAgentId: string,
    options: SpawnSubagentOptions,
  ): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error(`Unknown agent type: "${options.profileName}"`);
    }
    const child = await this.lifecycle.spawn(callerAgentId, { swarmItem: options.swarmItem });
    applyProfileToAgent(child, profile);
    this.emitSpawned(caller, child.id, options.profileName, options);
    const promptText = profile.promptPrefix !== undefined
      ? await this.withProfilePrefix(profile.promptPrefix, options.prompt)
      : options.prompt;
    const observed = observeChildAgentTurn(
      caller,
      child,
      { kind: 'prompt', prompt: promptText },
      {
        profileName: options.profileName,
        summaryPolicy: profile.summaryPolicy,
        suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
        signal: options.signal,
        onReady: options.onReady,
      },
    );
    if (observed === undefined) throw new Error('Subagent turn could not be started');
    return {
      agentId: child.id,
      profileName: options.profileName,
      completion: observed.completion.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: RunSubagentOptions,
    retryTurn: boolean,
  ): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = this.requireHandle(agentId, 'Agent instance');
    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
    const profile = this.catalog.get(profileName);
    this.emitSpawned(caller, agentId, profileName, options);
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    const observed = observeChildAgentTurn(caller, child, request, {
      profileName,
      summaryPolicy: profile?.summaryPolicy,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
      onReady: options.onReady,
    });
    if (observed === undefined) throw new Error('Subagent turn could not be started');
    return {
      agentId,
      profileName,
      completion: observed.completion.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private emitSpawned(
    caller: IAgentScopeHandle,
    subagentId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    caller.accessor.get(IAgentRecordService)?.signal({
      type: 'subagent.spawned',
      subagentId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      callerAgentId: caller.id,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    caller.accessor.get(ITelemetryService)?.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private async withProfilePrefix(
    promptPrefix: (ctx: {
      cwd: string;
      runner: ISessionProcessRunner;
      log?: ILogService;
    }) => Promise<string>,
    prompt: string,
  ): Promise<string> {
    try {
      const prefix = await promptPrefix({
        cwd: this.execContext.cwd,
        runner: this.processRunner,
        log: this.log,
      });
      return prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt;
    } catch {
      return prompt;
    }
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.getHandle(agentId);
    if (handle === undefined) throw new Error(`${label} "${agentId}" does not exist`);
    return handle;
  }
}

// Kept as a type-anchor so future maintenance imports the usage shape from here.
export type _SubagentUsage = TokenUsage;

registerScopedService(
  LifecycleScope.Session,
  ISessionSwarmService,
  SessionSwarmService,
  InstantiationType.Delayed,
  'sessionSwarm',
);
