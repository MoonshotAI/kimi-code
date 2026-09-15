/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { TokenUsage } from '#human/llm/usage';
import { Error2, ErrorCodes } from '#/errors';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { Event2 } from '#/app/event/event2';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { hasPinnedPermissionMode } from '#/features/tower/tower';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createAgentAwaitingClose } from '#/session/agentLifecycle/createAwaitingClose';
import {
  isSubagentMeta,
  labelsFromAgentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import {
  classifyRunTermination,
  emitAgentRunSpawned,
  mirrorAgentRun,
  SubagentCancelled,
  SubagentFailed,
} from '#/session/subagent/mirrorAgentRun';
import { type AgentRunHandle, ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

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

export interface SubagentSuspendedPayload {
  readonly subagentId: string;
  readonly reason: string;
}

export class SubagentSuspended extends Event2<SubagentSuspendedPayload> {
  static override readonly type = 'subagent.suspended';
  static override readonly observable = true;
}
export interface SubagentSuspended extends SubagentSuspendedPayload {}

export interface SubagentSuspendedEvent extends SubagentSuspendedPayload {
  readonly type: 'subagent.suspended';
}

const RESUMED_PROFILE_FALLBACK = 'subagent';

type TerminalizeSubagent = (agentId: string, event: Event2) => void;

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
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
    this.inFlight.set(callerAgentId, controller);
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const terminalized = new Set<string>();
    const terminalize: TerminalizeSubagent = (agentId, event) => {
      if (terminalized.has(agentId)) return;
      terminalized.add(agentId);
      this.dispatchSubagentEvent(callerAgentId, event);
    };
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options, terminalize),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false, terminalize),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true, terminalize),
      suspended: (event) => {
        this.dispatchSubagentEvent(
          callerAgentId,
          new SubagentSuspended({
            subagentId: event.agentId,
            reason: event.reason,
          }),
        );
      },
      abandoned: (event) => {
        terminalize(
          event.agentId,
          event.outcome === 'failed'
            ? new SubagentFailed({
                subagentId: event.agentId,
                error: event.error ?? 'Provider rate limit',
              })
            : new SubagentCancelled({ subagentId: event.agentId }),
        );
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency }).run();
    void promise
      .finally(() => {
        for (const unlink of unlinks) unlink();
        if (this.inFlight.get(callerAgentId) === controller) this.inFlight.delete(callerAgentId);
      })
      .catch(() => {});
    return promise;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    this.inFlight.get(callerAgentId)?.abort();
  }

  private dispatchSubagentEvent(callerAgentId: string, event: Event2): void {
    const caller = this.agentLifecycle.handleOf(callerAgentId);
    void caller?.accessor.get(IEventDispatcher)?.dispatch(event);
  }

  private async spawnAttempt(
    callerAgentId: string,
    options: AgentSpawnAttemptOptions,
    terminalize: TerminalizeSubagent,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const { plan } = options;
    const spawned = await this.subagents.spawn({
      callerAgentId,
      plan,
      labels: subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
      prompt: options.prompt,
    });
    emitAgentRunSpawned(caller, spawned.agentId, {
      profileName: plan.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      fork: plan.fork,
      model: plan.model,
      modelSource: plan.modelSource,
    });
    const child = this.requireHandle(spawned.agentId, 'Agent instance');
    return this.observe(
      caller,
      child,
      plan.profileName,
      {
        kind: 'prompt',
        prompt: spawned.promptText,
      },
      options,
      terminalize,
    );
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
    terminalize: TerminalizeSubagent,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const meta = await this.requireOwnedSubagent(callerAgentId, agentId);
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child =
      this.agentLifecycle.handleOf(agentId) ??
      (await this.rebuildSubagent(agentId, meta, caller, options.signal));
    this.requireIdleSubagent(agentId, child);
    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_PROFILE_FALLBACK;
    if (!retryTurn) {
      const resumedModel = child.accessor.get(IAgentProfileService).data().modelAlias;
      emitAgentRunSpawned(caller, agentId, {
        profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
        model: resumedModel,
      });
    }
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child, profileName, request, options, terminalize);
  }

  private async observe(
    caller: IAgentScopeHandle,
    child: IAgentScopeHandle,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
    terminalize: TerminalizeSubagent,
  ): Promise<AgentRunAttemptHandle> {
    const agentId = child.id;
    let run: AgentRunHandle;
    try {
      run = await this.subagents.run(agentContextOf(child), request, {
        signal: options.signal,
        onReady: options.onReady,
      });
    } catch (error) {
      terminalize(agentId, runStartTerminalEvent(agentId, error, options.signal));
      throw error;
    }
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
      terminalize,
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({
        result: r.summary,
        usage: r.usage,
        stopReason: r.stopReason,
      })),
    };
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `${label} "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).snapshot().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async rebuildSubagent(
    agentId: string,
    meta: AgentMeta,
    caller: IAgentScopeHandle,
    signal: AbortSignal,
  ): Promise<IAgentScopeHandle> {
    await createAgentAwaitingClose(
      this.agentLifecycle,
      { agentId, labels: labelsFromAgentMeta(meta), forkedFrom: meta.forkedFrom },
      signal,
    );
    const rebuilt = this.agentLifecycle.handleOf(agentId);
    if (rebuilt === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    if (!hasPinnedPermissionMode(rebuilt.accessor.get(IAgentProfileService).data().profileName)) {
      rebuilt.accessor
        .get(IAgentPermissionModeService)
        .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
    }
    return rebuilt;
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<AgentMeta> {
    const meta = await this.agentMeta(agentId);
    if (meta === undefined || !isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId } },
      );
    }
    return meta;
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;

function runStartTerminalEvent(agentId: string, error: unknown, signal: AbortSignal): Event2 {
  if (classifyRunTermination(error, signal) === 'cancelled') {
    return new SubagentCancelled({ subagentId: agentId });
  }
  return new SubagentFailed({
    subagentId: agentId,
    error: error instanceof Error ? error.message : String(error),
  });
}
