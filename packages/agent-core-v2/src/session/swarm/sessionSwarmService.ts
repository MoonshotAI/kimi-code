/**
 * `sessionSwarm` domain (L4) — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks one `AbortController` per caller so `cancel` can abort
 * every in-flight run. The caller ↔ child association is this domain's own
 * business data: requester-side display facts (`subagent.spawned` wire signals
 * carrying the swarm's tool-call context, `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted here / via the
 * `agentLifecycle` wrapper helper `mirrorAgentRun`; the lifecycle registry
 * itself stays flat. Bound at Session scope.
 */

import type { TokenUsage } from '#/app/llmProtocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile';
import type { SubagentSuspendedEvent } from '@moonshot-ai/protocol';
import { IAgentWireService } from '#/wire';
import { IEventBus } from '#/app/event';
import {
  applyProfilePromptPrefix,
  IAgentProfileCatalogService,
} from '#/app/agentProfileCatalog';
import {
  emitAgentRunSpawned,
  IAgentLifecycleService,
  mirrorAgentRun,
} from '#/session/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext';
import { ISessionProcessRunner } from '#/session/process';
import { ILogService } from '#/_base/log';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  AgentRunBatch,
  type AgentRunAttemptOptions,
  type AgentSpawnAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunAttemptHandle,
} from './agentRunBatch';

declare module '#/wire' {
  interface SignalMap {
    'subagent.suspended': Omit<SubagentSuspendedEvent, 'type'>;
  }
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': Omit<SubagentSuspendedEvent, 'type'>;
  }
}

/**
 * Requester-facing label for a resumed agent whose profile binding is unknown.
 * Kept as the legacy wire display value.
 */
const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @ISessionContext private readonly sessionContext: ISessionContext,
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
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.getHandle(callerAgentId);
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
        caller?.accessor.get(IAgentWireService)?.signal({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency }).run();
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
    options: AgentSpawnAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error(`Unknown agent type: "${options.profileName}"`);
    }
    const callerData = caller.accessor.get(IAgentProfileService).data();
    if (callerData.modelAlias === undefined) {
      throw new Error('Caller agent has no model bound');
    }
    // Explicit inheritance: the child runs the requested profile on the
    // caller's own model / thinking level / cwd (Profile + Model ⇒ Agent).
    const child = await this.lifecycle.create({
      binding: {
        profile: profile.name,
        model: callerData.modelAlias,
        thinking: callerData.thinkingLevel,
        cwd: callerData.cwd,
      },
      labels: options.swarmItem === undefined ? undefined : { swarmItem: options.swarmItem },
    });
    emitAgentRunSpawned(caller, child.id, {
      profileName: options.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    const promptText = await applyProfilePromptPrefix(profile, options.prompt, {
      cwd: this.sessionContext.cwd,
      runner: this.processRunner,
      log: this.log,
    });
    return this.observe(caller, child.id, options.profileName, {
      kind: 'prompt',
      prompt: promptText,
    }, options);
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = this.requireHandle(agentId, 'Agent instance');
    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_PROFILE_FALLBACK;
    emitAgentRunSpawned(caller, agentId, {
      profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child.id, profileName, request, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    const run = await this.lifecycle.run(agentId, request, {
      signal: options.signal,
      onReady: options.onReady,
    });
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.getHandle(agentId);
    if (handle === undefined) throw new Error(`${label} "${agentId}" does not exist`);
    return handle;
  }
}

// Kept as a type-anchor so future maintenance imports the usage shape from here.
export type _AgentRunUsage = TokenUsage;

registerScopedService(
  LifecycleScope.Session,
  ISessionSwarmService,
  SessionSwarmService,
  InstantiationType.Delayed,
  'sessionSwarm',
);
