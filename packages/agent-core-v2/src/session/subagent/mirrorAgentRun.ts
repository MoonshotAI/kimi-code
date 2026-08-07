/**
 * `subagent` domain — caller-side mirroring of an agent run.
 *
 * When one agent drives another through `ISessionSubagentService.run`, the
 * *requesting* agent surfaces that run
 * on its own record stream so the UI can nest the child transcript under the
 * launching tool call, external hooks fire, and telemetry is tracked. That
 * requester ↔ target association is business data of this wrapper layer — the
 * lifecycle registry itself stays flat and knows nothing about it.
 *
 * External hooks (`SubagentStart` / `SubagentStop`) fire by observation, like
 * every other external hook: this wrapper announces "a run is about to start"
 * / "...has stopped" through the `ISessionSubagentService` agent-run hook
 * slot and stop event.
 *
 * Wire shape note: the signals are still named `subagent.spawned / started /
 * completed / failed` and telemetry still tracks `subagent_created` so existing
 * session recordings and dashboards stay valid. The spawned signal also
 * reports the child's display-normalized model alias (the derived secondary
 * entry resolves to its base alias) and its effective thinking effort, so
 * clients can render both at spawn instead of waiting for the first
 * `agent.status.updated` frame.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { isProviderRateLimitError } from '#/kosong/contract/errors';
import { type TokenUsage } from '#/kosong/contract/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventBus } from '#/app/event/eventBus';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { type AgentRunHandle, ISessionSubagentService } from './subagent';

export interface SubagentSpawnedEvent {
  readonly type: 'subagent.spawned';
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

export interface SubagentStartedEvent {
  readonly type: 'subagent.started';
  readonly subagentId: string;
}

export interface SubagentCompletedEvent {
  readonly type: 'subagent.completed';
  readonly subagentId: string;
  readonly resultSummary: string;
  readonly usage?: TokenUsage;
  readonly contextTokens?: number;
}

export interface SubagentFailedEvent {
  readonly type: 'subagent.failed';
  readonly subagentId: string;
  readonly error: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.spawned': SubagentSpawnedEvent;
    'subagent.started': SubagentStartedEvent;
    'subagent.completed': SubagentCompletedEvent;
    'subagent.failed': SubagentFailedEvent;
  }
}

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
  requester.accessor.get(IEventBus)?.publish({
    type: 'subagent.spawned',
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
  });
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
  const eventBus = requester.accessor.get(IEventBus);
  const subagents = requester.accessor.get(ISessionSubagentService);
  const agentLifecycle = requester.accessor.get(IAgentLifecycleService);
  eventBus?.publish({ type: 'subagent.started', subagentId: run.agentId });
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
    eventBus?.publish({
      type: 'subagent.completed',
      subagentId: run.agentId,
      resultSummary: result.summary,
      usage: result.usage,
      contextTokens,
    });
    subagents?.notifyAgentTaskStopped({
      agentName: options.profileName,
      response: result.summary,
    });
    return result;
  } catch (error) {
    if (!isAbortError(error) && !shouldSuppressFailure(options, error)) {
      eventBus?.publish({
        type: 'subagent.failed',
        subagentId: run.agentId,
        error: errorMessage(error),
      });
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
