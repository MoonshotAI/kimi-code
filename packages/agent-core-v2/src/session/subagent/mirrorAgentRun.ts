/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { isProviderRateLimitError } from '#/kosong/contract/errors';
import { type TokenUsage } from '#/kosong/contract/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Event2 } from '#/app/event/event2';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { type AgentRunHandle, ISessionSubagentService } from './subagent';

export interface SubagentSpawnedPayload {
  readonly subagentId: string;
  readonly subagentName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly parentAgentId?: string;
  readonly callerAgentId?: string;
  readonly description?: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export class SubagentSpawned extends Event2<SubagentSpawnedPayload> {
  static override readonly type = 'subagent.spawned';
  static override readonly observable = true;
}
export interface SubagentSpawned extends SubagentSpawnedPayload {}

export interface SubagentStartedPayload {
  readonly subagentId: string;
}

export class SubagentStarted extends Event2<SubagentStartedPayload> {
  static override readonly type = 'subagent.started';
  static override readonly observable = true;
}
export interface SubagentStarted extends SubagentStartedPayload {}

export interface SubagentCompletedPayload {
  readonly subagentId: string;
  readonly resultSummary: string;
  readonly usage?: TokenUsage;
  readonly contextTokens?: number;
}

export class SubagentCompleted extends Event2<SubagentCompletedPayload> {
  static override readonly type = 'subagent.completed';
  static override readonly observable = true;
}
export interface SubagentCompleted extends SubagentCompletedPayload {}

export interface SubagentFailedPayload {
  readonly subagentId: string;
  readonly error: string;
}

export class SubagentFailed extends Event2<SubagentFailedPayload> {
  static override readonly type = 'subagent.failed';
  static override readonly observable = true;
}
export interface SubagentFailed extends SubagentFailedPayload {}

export interface AgentRunSpawnedMeta {
  readonly profileName: string;
  readonly parentToolCallId?: string;
  readonly parentToolCallUuid?: string;
  readonly description?: string;
  readonly swarmIndex?: number;
  readonly runInBackground?: boolean;
  readonly model?: string;
}

export interface MirrorAgentRunOptions {
  readonly profileName: string;
  readonly prompt?: string;
  readonly suppressRateLimitFailureEvent?: boolean;
  readonly signal: AbortSignal;
  readonly cancel?: (reason?: unknown) => void;
}

export function emitAgentRunSpawned(
  requester: IAgentScopeHandle,
  targetAgentId: string,
  meta: AgentRunSpawnedMeta,
): void {
  const childProfile = requester.accessor
    .get(IAgentLifecycleService)
    ?.get(targetAgentId)
    ?.accessor.get(IAgentProfileService);
  void requester.accessor.get(IEventDispatcher)?.dispatch(
    new SubagentSpawned({
      subagentId: targetAgentId,
      subagentName: meta.profileName,
      parentToolCallId: meta.parentToolCallId ?? '',
      parentToolCallUuid: meta.parentToolCallUuid,
      parentAgentId: requester.id,
      callerAgentId: requester.id,
      description: meta.description,
      swarmIndex: meta.swarmIndex,
      runInBackground: meta.runInBackground ?? false,
      model: meta.model,
      thinkingEffort: childProfile?.getEffectiveThinkingLevel(),
    }),
  );
  childProfile?.republishStatus();
  requester.accessor.get(ITelemetryService)?.track2('subagent_created', {
    subagent_name: meta.profileName,
    run_in_background: meta.runInBackground ?? false,
    agent_id: targetAgentId,
    parent_agent_id: requester.id,
    parent_tool_call_id: meta.parentToolCallId ?? '',
  });
}

export async function mirrorAgentRun(
  requester: IAgentScopeHandle,
  run: AgentRunHandle,
  options: MirrorAgentRunOptions,
): Promise<{ summary: string; usage?: TokenUsage }> {
  const dispatcher = requester.accessor.get(IEventDispatcher);
  const subagents = requester.accessor.get(ISessionSubagentService);
  const agentLifecycle = requester.accessor.get(IAgentLifecycleService);
  void dispatcher?.dispatch(new SubagentStarted({ subagentId: run.agentId }));
  if (options.prompt !== undefined) {
    const cancelAndRethrow = (reason: unknown): never => {
      options.cancel?.(reason);
      void run.completion.catch(() => {});
      throw reason;
    };
    try {
      await subagents?.hooks.onWillStartAgentTask.run({
        agentName: options.profileName,
        prompt: options.prompt,
        signal: options.signal,
      });
    } catch (error) {
      cancelAndRethrow(error);
    }
    if (options.signal.aborted) {
      cancelAndRethrow(options.signal.reason ?? userCancellationReason());
    }
  }
  try {
    const result = await run.completion;
    const contextTokens = childContextTokens(agentLifecycle, run.agentId);
    void dispatcher?.dispatch(
      new SubagentCompleted({
        subagentId: run.agentId,
        resultSummary: result.summary,
        usage: result.usage,
        contextTokens,
      }),
    );
    subagents?.notifyAgentTaskStopped({
      agentName: options.profileName,
      response: result.summary,
    });
    return result;
  } catch (error) {
    if (!isAbortError(error) && !shouldSuppressFailure(options, error)) {
      void dispatcher?.dispatch(
        new SubagentFailed({
          subagentId: run.agentId,
          error: errorMessage(error),
        }),
      );
    }
    throw error;
  }
}

function shouldSuppressFailure(options: MirrorAgentRunOptions, error: unknown): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childContextTokens(
  agentLifecycle: IAgentLifecycleService,
  agentId: string,
): number | undefined {
  const child = agentLifecycle.get(agentId);
  return child?.accessor.get(IAgentTokenCountingService)?.statusSize();
}
