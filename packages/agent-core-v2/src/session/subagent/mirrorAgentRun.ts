/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { tryAgentContextOf } from '#/agent/scopeContext/scopeContext';
import { isProviderRateLimitError } from '#/llm-adapter/contract/errors';
import { type TokenUsage } from '#human/llm/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { SubagentCreatedEvent } from '#/app/telemetry/events';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { type AgentRunCompletion, type AgentRunHandle, ISessionSubagentService } from './subagent';
import type { SubagentModelSource } from './configSection';

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
  readonly taskId?: string;
}

export class SubagentSpawned extends Event2<SubagentSpawnedPayload> {
  static override readonly type = 'subagent.spawned';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({
    subagentId: z.string(),
    subagentName: z.string(),
    parentToolCallId: z.string(),
    parentToolCallUuid: z.string().optional(),
    parentAgentId: z.string().optional(),
    callerAgentId: z.string().optional(),
    description: z.string().optional(),
    swarmIndex: z.number().optional(),
    runInBackground: z.boolean(),
    model: z.string().optional(),
    thinkingEffort: z.string().optional(),
    taskId: z.string().optional(),
  });
}
export interface SubagentSpawned extends SubagentSpawnedPayload {}
registerEvent2Class(SubagentSpawned);

export interface SubagentStartedPayload {
  readonly subagentId: string;
}

export class SubagentStarted extends Event2<SubagentStartedPayload> {
  static override readonly type = 'subagent.started';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({ subagentId: z.string() });
}
export interface SubagentStarted extends SubagentStartedPayload {}
registerEvent2Class(SubagentStarted);

export interface SubagentCompletedPayload {
  readonly subagentId: string;
  readonly resultSummary: string;
  readonly usage?: TokenUsage;
  readonly contextTokens?: number;
}

export class SubagentCompleted extends Event2<SubagentCompletedPayload> {
  static override readonly type = 'subagent.completed';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({
    subagentId: z.string(),
    resultSummary: z.string(),
    usage: z.custom<TokenUsage>().optional(),
    contextTokens: z.number().optional(),
  });
}
export interface SubagentCompleted extends SubagentCompletedPayload {}
registerEvent2Class(SubagentCompleted);

export interface SubagentFailedPayload {
  readonly subagentId: string;
  readonly error: string;
}

export class SubagentFailed extends Event2<SubagentFailedPayload> {
  static override readonly type = 'subagent.failed';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({ subagentId: z.string(), error: z.string() });
}
export interface SubagentFailed extends SubagentFailedPayload {}
registerEvent2Class(SubagentFailed);

export interface SubagentCancelledPayload {
  readonly subagentId: string;
}

export class SubagentCancelled extends Event2<SubagentCancelledPayload> {
  static override readonly type = 'subagent.cancelled';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({ subagentId: z.string() });
}
export interface SubagentCancelled extends SubagentCancelledPayload {}
registerEvent2Class(SubagentCancelled);

export interface SubagentSpawnedEvent extends SubagentSpawnedPayload {
  readonly type: 'subagent.spawned';
}

export interface SubagentStartedEvent extends SubagentStartedPayload {
  readonly type: 'subagent.started';
}

export interface SubagentCompletedEvent extends SubagentCompletedPayload {
  readonly type: 'subagent.completed';
}

export interface SubagentFailedEvent extends SubagentFailedPayload {
  readonly type: 'subagent.failed';
}

export interface SubagentCancelledEvent extends SubagentCancelledPayload {
  readonly type: 'subagent.cancelled';
}

export interface AgentRunSpawnedMeta {
  readonly profileName: string;
  readonly parentToolCallId?: string;
  readonly parentToolCallUuid?: string;
  readonly description?: string;
  readonly swarmIndex?: number;
  readonly runInBackground?: boolean;
  readonly fork?: boolean;
  readonly model?: string;
  readonly modelSource?: SubagentModelSource;
  readonly taskId?: string;
}

export interface MirrorAgentRunOptions {
  readonly profileName: string;
  readonly prompt?: string;
  readonly suppressRateLimitFailureEvent?: boolean;
  readonly signal: AbortSignal;
  readonly cancel?: (reason?: unknown) => void;
  readonly deferStarted?: boolean;
  readonly terminalize?: (agentId: string, event: Event2) => void;
}

export function emitAgentRunSpawned(
  requester: IAgentScopeHandle,
  targetAgentId: string,
  meta: AgentRunSpawnedMeta,
): void {
  const childProfile = requester.accessor
    .get(IAgentLifecycleService)
    .handleOf(targetAgentId)
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
      taskId: meta.taskId,
    }),
  );
  childProfile?.republishStatus();
  const telemetryEvent: SubagentCreatedEvent = {
    subagent_name: meta.profileName,
    run_in_background: meta.runInBackground ?? false,
    fork: meta.fork ?? false,
    agent_id: targetAgentId,
    parent_agent_id: requester.id,
    parent_tool_call_id: meta.parentToolCallId ?? '',
    model: meta.model,
    model_source: meta.modelSource,
  };
  requester.accessor.get(ITelemetryService)?.track2('subagent_created', telemetryEvent);
}

export async function mirrorAgentRun(
  requester: IAgentScopeHandle,
  run: AgentRunHandle,
  options: MirrorAgentRunOptions,
): Promise<AgentRunCompletion> {
  const dispatcher = requester.accessor.get(IEventDispatcher);
  const subagents = requester.accessor.get(ISessionSubagentService);
  const agentLifecycle = requester.accessor.get(IAgentLifecycleService);
  if (options.deferStarted !== true) {
    void dispatcher?.dispatch(new SubagentStarted({ subagentId: run.agentId }));
  }
  if (options.prompt !== undefined) {
    const cancelAndRethrow = (reason: unknown): never => {
      options.cancel?.(reason);
      void run.completion.catch(() => {});
      const event = terminalEventFor(run.agentId, reason, options);
      if (event !== undefined) emitTerminal(dispatcher, options, run.agentId, event);
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
    const event = terminalEventFor(run.agentId, error, options);
    if (event !== undefined) emitTerminal(dispatcher, options, run.agentId, event);
    throw error;
  }
}

function emitTerminal(
  dispatcher: IEventDispatcher | undefined,
  options: MirrorAgentRunOptions,
  agentId: string,
  event: Event2,
): void {
  if (options.terminalize !== undefined) {
    options.terminalize(agentId, event);
    return;
  }
  void dispatcher?.dispatch(event);
}

export type RunTermination = 'cancelled' | 'failed';

export function classifyRunTermination(error: unknown, signal: AbortSignal): RunTermination {
  if (!signal.aborted && !isAbortError(error)) return 'failed';
  const reason = signal.aborted ? signal.reason : error;
  if (isUserCancellation(reason)) return 'cancelled';
  return reason instanceof Error && !isAbortError(reason) ? 'failed' : 'cancelled';
}

function terminalEventFor(
  agentId: string,
  error: unknown,
  options: MirrorAgentRunOptions,
): Event2 | undefined {
  if (classifyRunTermination(error, options.signal) === 'cancelled') {
    return new SubagentCancelled({ subagentId: agentId });
  }
  if (suppressesRateLimitFailure(options, error)) return undefined;
  return new SubagentFailed({ subagentId: agentId, error: errorMessage(error) });
}

function suppressesRateLimitFailure(options: MirrorAgentRunOptions, error: unknown): boolean {
  return options.suppressRateLimitFailureEvent === true && isProviderRateLimitError(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childContextTokens(
  agentLifecycle: IAgentLifecycleService,
  agentId: string,
): number | undefined {
  const child = agentLifecycle.handleOf(agentId);
  if (child === undefined) return undefined;
  const context = tryAgentContextOf(child);
  if (context === undefined) return undefined;
  return child.accessor.get(ISessionTokenCountingService)?.statusSize(context);
}
