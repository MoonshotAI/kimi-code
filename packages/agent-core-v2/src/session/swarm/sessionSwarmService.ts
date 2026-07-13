/**
 * `sessionSwarm` domain (L4) — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks each caller's live batches plus each active member's
 * owning batch so cancellation can target one member or all work owned by the
 * caller. The caller ↔ child association
 * is this domain's own business data: requester-side display facts
 * (`subagent.spawned` wire signals carrying the swarm's tool-call context,
 * `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted here / via the
 * `agentLifecycle` wrapper helper `mirrorAgentRun`; the lifecycle registry
 * itself stays flat. Repeated member stops remain idempotent without retaining
 * every completed member for the whole session. Bound at Session scope.
 */

import type { TokenUsage } from '#/app/llmProtocol/usage';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  isUserCancellation,
  linkAbortSignal,
  userCancellationReason,
} from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { SubagentSuspendedEvent } from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/agentLifecycle/mirrorAgentRun';
import {
  isSubagentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmStopResult,
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

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': SubagentSuspendedEvent;
  }
}

/**
 * Requester-facing label for a resumed agent whose profile binding is unknown.
 * Kept as the legacy wire display value.
 */
const RESUMED_PROFILE_FALLBACK = 'subagent';
const RECENT_SWARM_TERMINAL_LIMIT = 128;

type InFlightBatch = {
  readonly callerAgentId: string;
  readonly controller: AbortController;
  readonly batch: Pick<AgentRunBatch<unknown>, 'stopAgent'>;
  readonly agentIds: Set<string>;
};

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlightByCaller = new Map<string, Set<InFlightBatch>>();
  private readonly inFlightByAgentId = new Map<string, InFlightBatch>();
  private readonly recentTerminalStatuses = new Map<
    string,
    SessionSwarmRunResult['status']
  >();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ILogService private readonly log: ILogService,
  ) {}

  async getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined> {
    const meta = await this.agentMeta(args.agentId);
    if (!isSubagentMeta(meta)) return undefined;
    if (subagentParentAgentId(meta) !== args.callerAgentId) return undefined;
    return subagentSwarmItem(meta);
  }

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    const { callerAgentId, tasks } = args;
    const controller = new AbortController();
    let inFlight: InFlightBatch;
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, inFlight, options),
      resume: (agentId, options) =>
        this.resumeAttempt(callerAgentId, inFlight, agentId, options, false),
      retry: (agentId, options) =>
        this.resumeAttempt(callerAgentId, inFlight, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.getHandle(callerAgentId);
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const batch = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency });
    inFlight = { callerAgentId, controller, batch, agentIds: new Set() };
    this.addInFlight(inFlight);
    const promise = batch.run();
    const cleanup = () => {
      for (const unlink of unlinks) unlink();
      this.removeInFlight(inFlight);
    };
    void promise.then(
      (results) => {
        for (const result of results) {
          if (result.agentId === undefined) continue;
          this.rememberTerminal(result.agentId, result.status);
        }
        cleanup();
      },
      () => {
        cleanup();
      },
    );
    return promise;
  }

  stopAgent(agentId: string): SessionSwarmStopResult {
    const inFlight = this.inFlightByAgentId.get(agentId);
    if (inFlight !== undefined) {
      const current = inFlight.batch.stopAgent(agentId);
      if (current.kind !== 'not_found') {
        if (current.kind === 'stopped') {
          const callerHandle = this.lifecycle.getHandle(inFlight.callerAgentId);
          if (callerHandle !== undefined) {
            this.publishCancellation(callerHandle, agentId);
          }
        }
        return current;
      }
    }

    const status = this.recentTerminalStatus(agentId);
    if (status !== undefined) {
      return {
        kind: 'already_terminal',
        agentId,
        status,
      };
    }
    return { kind: 'not_found', agentId };
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    const batches = this.inFlightByCaller.get(callerAgentId);
    if (batches === undefined) return;
    for (const inFlight of batches) {
      inFlight.controller.abort(userCancellationReason());
    }
  }

  private async spawnAttempt(
    callerAgentId: string,
    inFlight: InFlightBatch,
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
    // caller's own model / thinking level / cwd, and inherits the caller's
    // permission mode so it does not fall back to `manual`.
    const child = await this.lifecycle.create({
      binding: {
        profile: profile.name,
        model: callerData.modelAlias,
        thinking: callerData.thinkingLevel,
        cwd: callerData.cwd,
      },
      permissionMode: caller.accessor.get(IAgentPermissionModeService).mode,
      labels: subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
    });
    if (options.signal.aborted) {
      await this.lifecycle.remove(child.id);
      options.signal.throwIfAborted();
    }
    child.accessor
      .get(IAgentUserToolService)
      .inheritUserTools(caller.accessor.get(IAgentUserToolService));
    const promptText = await applyProfilePromptPrefix(profile, options.prompt, {
      cwd: this.sessionContext.cwd,
      runner: this.processRunner,
      log: this.log,
    });
    if (options.signal.aborted) {
      await this.lifecycle.remove(child.id);
      options.signal.throwIfAborted();
    }
    let announced = false;
    try {
      this.identifyAgent(callerAgentId, inFlight, child.id, options);
      emitAgentRunSpawned(caller, child.id, {
        profileName: options.profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
      });
      announced = true;
      return await this.observe(caller, child.id, options.profileName, {
        kind: 'prompt',
        prompt: promptText,
      }, options);
    } catch (error) {
      if (announced && isUserCancellation(options.signal.reason)) {
        this.publishCancellation(caller, child.id);
      }
      throw error;
    }
  }

  private async resumeAttempt(
    callerAgentId: string,
    inFlight: InFlightBatch,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    let announced = retryTurn;
    try {
      await this.requireOwnedSubagent(callerAgentId, agentId);
      options.signal.throwIfAborted();
      const child = this.requireHandle(agentId, 'Agent instance');
      this.requireIdleSubagent(agentId, child);
      this.realignChildModel(caller, child);
      const profileName =
        child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_PROFILE_FALLBACK;
      if (retryTurn) {
        this.requireAgentOwner(callerAgentId, inFlight, agentId, options.signal);
      } else {
        this.identifyAgent(callerAgentId, inFlight, agentId, options);
        emitAgentRunSpawned(caller, agentId, {
          profileName,
          parentToolCallId: options.parentToolCallId,
          parentToolCallUuid: options.parentToolCallUuid,
          description: options.description,
          swarmIndex: options.swarmIndex,
          runInBackground: options.runInBackground,
        });
        announced = true;
      }
      const request = retryTurn
        ? ({ kind: 'retry' } as const)
        : ({ kind: 'prompt', prompt: options.prompt } as const);
      return await this.observe(caller, child.id, profileName, request, options);
    } catch (error) {
      if (announced && isUserCancellation(options.signal.reason)) {
        this.publishCancellation(caller, agentId);
      }
      throw error;
    }
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
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

  private identifyAgent(
    callerAgentId: string,
    inFlight: InFlightBatch,
    agentId: string,
    options: AgentRunAttemptOptions,
  ): void {
    const batches = this.inFlightByCaller.get(callerAgentId);
    if (batches === undefined || !batches.has(inFlight)) {
      options.signal.throwIfAborted();
      throw new Error('Swarm batch is no longer running');
    }
    if (this.inFlightByAgentId.has(agentId)) {
      throw new Error(`Agent instance "${agentId}" is already owned by a running swarm batch`);
    }
    this.recentTerminalStatuses.delete(agentId);
    inFlight.agentIds.add(agentId);
    this.inFlightByAgentId.set(agentId, inFlight);
    options.onAgentIdentified?.(agentId);
  }

  private publishCancellation(
    caller: IAgentScopeHandle,
    agentId: string,
  ): void {
    caller.accessor.get(IEventBus)?.publish({
      type: 'subagent.failed',
      subagentId: agentId,
      error: 'Aborted by the user',
      cancelled: true,
    });
  }

  private requireAgentOwner(
    callerAgentId: string,
    inFlight: InFlightBatch,
    agentId: string,
    signal: AbortSignal,
  ): void {
    if (
      inFlight.callerAgentId === callerAgentId &&
      this.inFlightByAgentId.get(agentId) === inFlight
    ) {
      return;
    }
    signal.throwIfAborted();
    throw new Error(`Agent instance "${agentId}" is not owned by this swarm batch`);
  }

  private addInFlight(inFlight: InFlightBatch): void {
    let batches = this.inFlightByCaller.get(inFlight.callerAgentId);
    if (batches === undefined) {
      batches = new Set();
      this.inFlightByCaller.set(inFlight.callerAgentId, batches);
    }
    batches.add(inFlight);
  }

  private removeInFlight(inFlight: InFlightBatch): void {
    const batches = this.inFlightByCaller.get(inFlight.callerAgentId);
    batches?.delete(inFlight);
    for (const agentId of inFlight.agentIds) {
      if (this.inFlightByAgentId.get(agentId) === inFlight) {
        this.inFlightByAgentId.delete(agentId);
      }
    }
    if (batches?.size === 0) this.inFlightByCaller.delete(inFlight.callerAgentId);
  }

  private rememberTerminal(
    agentId: string,
    status: SessionSwarmRunResult['status'],
  ): void {
    this.recentTerminalStatuses.delete(agentId);
    this.recentTerminalStatuses.set(agentId, status);
    while (this.recentTerminalStatuses.size > RECENT_SWARM_TERMINAL_LIMIT) {
      const oldest = this.recentTerminalStatuses.keys().next().value;
      if (oldest === undefined) break;
      this.recentTerminalStatuses.delete(oldest);
    }
  }

  private recentTerminalStatus(
    key: string,
  ): SessionSwarmRunResult['status'] | undefined {
    const status = this.recentTerminalStatuses.get(key);
    if (status === undefined) return undefined;
    this.recentTerminalStatuses.delete(key);
    this.recentTerminalStatuses.set(key, status);
    return status;
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.getHandle(agentId);
    if (handle === undefined) throw new Error(`${label} "${agentId}" does not exist`);
    return handle;
  }

  private realignChildModel(caller: IAgentScopeHandle, child: IAgentScopeHandle): void {
    const modelAlias = caller.accessor.get(IAgentProfileService).data().modelAlias;
    if (modelAlias === undefined) {
      throw new Error('Caller agent has no model bound');
    }
    child.accessor.get(IAgentProfileService).update({ modelAlias });
  }

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<void> {
    const meta = await this.agentMeta(agentId);
    if (!isSubagentMeta(meta)) {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
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
