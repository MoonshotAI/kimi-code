/**
 * `subagent` domain (L6) — caller-side mirroring of an agent run.
 *
 * When one agent drives another through `ISessionSubagentService.run` (the
 * `Agent` tool, the swarm scheduler), the *requesting* agent surfaces that run
 * on its own record stream so the UI can nest the child transcript under the
 * launching tool call, external hooks fire, and telemetry is tracked. That
 * requester ↔ target association is business data of this wrapper layer — the
 * lifecycle registry itself stays flat and knows nothing about it.
 *
 * External hooks (`SubagentStart` / `SubagentStop`) fire by observation, like
 * every other external hook: this wrapper announces "a run is about to start"
 * / "...has stopped" through the `ISessionSubagentService` agent-run hook slot
 * and stop event, and the Session-scope `externalHooks` adapter registers its
 * own listeners there to translate them into the configured external hook
 * commands.
 *
 * Wire shape note: the signals are still named `subagent.spawned / started /
 * completed / failed` and telemetry still tracks `subagent_created` so existing
 * session recordings and dashboards stay valid. Rename lives on a separate
 * wire-cleanup PR.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { isProviderRateLimitError } from '#/app/llmProtocol/errors';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
} from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event/eventBus';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { type AgentRunHandle, ISessionSubagentService } from './subagent';

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
}

export interface MirrorAgentRunOptions {
  /** Profile the target runs under; only used for hooks / record labels. */
  readonly profileName: string;
  /**
   * Prompt text submitted to the target. When present the requester-side
   * `SubagentStart` external hook runs (via `IAgentLifecycleService`); omit for
   * retry turns, which skip the hook.
   */
  readonly prompt?: string;
  /** Skip the requester-side `subagent.failed` record for provider-rate-limit / aborted failures. */
  readonly suppressRateLimitFailureEvent?: boolean;
  /** The requester's cancellation signal (passed through to the start hook slot). */
  readonly signal: AbortSignal;
  /** Called to abort the underlying run when the start hook slot aborts/rejects it. */
  readonly cancel?: (reason?: unknown) => void;
}

/**
 * Emit the requester-side "an agent run was launched" record + telemetry.
 * Called once per launch (spawn or resume), before or right after the run is
 * submitted, because it carries tool-call provenance (`parentToolCallId`,
 * `swarmIndex`, `runInBackground`) only the requester knows.
 */
export function emitAgentRunSpawned(
  requester: IAgentScopeHandle,
  targetAgentId: string,
  meta: AgentRunSpawnedMeta,
): void {
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
  });
  requester.accessor.get(ITelemetryService)?.track2('subagent_created', {
    subagent_name: meta.profileName,
    run_in_background: meta.runInBackground ?? false,
  });
}

/**
 * Mirror a running agent turn onto the requester's record stream + external
 * hooks and await its completion. Returns the distilled summary/usage;
 * rethrows the run's failure after emitting the requester-side failure record.
 */
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
  return child?.accessor.get(IAgentContextSizeService)?.get().size;
}
