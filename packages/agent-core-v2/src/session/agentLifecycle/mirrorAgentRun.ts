/**
 * `agentLifecycle` domain (L6) — caller-side mirroring of an agent run.
 *
 * When one agent drives another through `IAgentLifecycleService.run` (the
 * `Agent` tool, the swarm scheduler), the *requesting* agent surfaces that run
 * on its own record stream so the UI can nest the child transcript under the
 * launching tool call, external hooks fire, and telemetry is tracked. That
 * requester ↔ target association is business data of this wrapper layer — the
 * lifecycle registry itself stays flat and knows nothing about it.
 *
 * External hooks (`SubagentStart` / `SubagentStop`) are invoked directly on
 * the requester's `IAgentExternalHooksService` — there is no intermediary
 * hook service; the tool wrapper is just a thin layer over the lifecycle.
 *
 * Wire shape note: the signals are still named `subagent.spawned / started /
 * completed / failed` and telemetry still tracks `subagent_created` so existing
 * session recordings and dashboards stay valid. Rename lives on a separate
 * wire-cleanup PR.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { isProviderRateLimitError, type TokenUsage } from '#/app/llmProtocol';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import type {
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
} from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event';
import { isAbortError } from '#/agent/loop/errors';

import type { AgentRunHandle } from './agentLifecycle';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.spawned': Omit<SubagentSpawnedEvent, 'type'>;
    'subagent.started': Omit<SubagentStartedEvent, 'type'>;
    'subagent.completed': Omit<SubagentCompletedEvent, 'type'>;
    'subagent.failed': Omit<SubagentFailedEvent, 'type'>;
  }
}

const HOOK_TEXT_PREVIEW_LENGTH = 500;

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
   * Prompt text submitted to the target. When present the `SubagentStart`
   * external hook fires (and may block the run); omit for retry turns, which
   * skip the hook.
   */
  readonly prompt?: string;
  /** Skip the requester-side `subagent.failed` record for provider-rate-limit / aborted failures. */
  readonly suppressRateLimitFailureEvent?: boolean;
  /** The requester's cancellation signal (passed through to the start hook). */
  readonly signal: AbortSignal;
  /** Called to abort the underlying run when the start hook blocks it. */
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
    callerAgentId: requester.id,
    description: meta.description,
    swarmIndex: meta.swarmIndex,
    runInBackground: meta.runInBackground ?? false,
  });
  requester.accessor.get(ITelemetryService)?.track('subagent_created', {
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
  const externalHooks = requester.accessor.get(IAgentExternalHooksService);
  eventBus?.publish({ type: 'subagent.started', subagentId: run.agentId });
  if (options.prompt !== undefined) {
    try {
      await externalHooks?.runAgentTaskStart({
        agentName: options.profileName,
        prompt: options.prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
        signal: options.signal,
      });
    } catch (error) {
      options.cancel?.(error);
      void run.completion.catch(() => {});
      throw error;
    }
    if (options.signal.aborted) {
      const reason: unknown = options.signal.reason ?? userCancellationReason();
      options.cancel?.(reason);
      void run.completion.catch(() => {});
      throw reason;
    }
  }
  try {
    const result = await run.completion;
    eventBus?.publish({
      type: 'subagent.completed',
      subagentId: run.agentId,
      resultSummary: result.summary,
      usage: result.usage,
    });
    externalHooks?.notifyAgentTaskStop({
      agentName: options.profileName,
      response: result.summary.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
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
