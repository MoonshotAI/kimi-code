import { ulid } from 'ulid';

import type { IDisposable } from '#/_base/di/lifecycle';
import { isAbortError } from '#/_base/utils/abort';
import { APIContextOverflowError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { ErrorCodes, Error2, isCodedError } from '#/errors';
import { IAgentHostService } from '#/agent/host/agentHost';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentContextMemory,
  type ContextMemoryRuntime,
} from '#/actor/contextMemory/contextMemoryAgentRuntime';
import {
  AgentLlmRequester,
  type LlmRequesterRuntime,
} from '#/actor/llmRequester/llmRequesterAgentRuntime';
import { AgentProfile, type ProfileRuntime } from '#/actor/profile/profileAgentRuntime';
import type { ProfileModelContext } from '#/actor/profile/profile';
import { AgentTodo, type TodoRuntime } from '#/actor/todo/todoAgentRuntime';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { LoopErrorContext } from '#/actor/loop/internal/loop';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';

import { FullCompactionBegin, type CompactionState } from '../compactionOps';
import { CompactionBlocked } from '../fullCompactionEvents';
import type {
  FullCompactionBeginInput,
  FullCompactionHookContext,
  FullCompactionStatus,
  FullCompactionTask,
} from '../fullCompactionAgentRuntime';
import type { CompactionBeginData, CompactionResult } from '../types';
import { findAPIStatusError } from './compactionHelpers';
import { RuntimeCompactionStrategy, type CompactionStrategy } from './strategy';
import type { ActiveCompactionHandle, FullCompactionMachineContext } from './compactionMachine';

const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export type CompactionRuntimeContext = AgentRuntimeContext<CompactionState>;

export function compactionContextOf(runtime: CompactionRuntimeContext): FullCompactionMachineContext {
  return runtime.getLogicState<FullCompactionMachineContext>();
}

export function fullCompactionStatusOf(context: FullCompactionMachineContext): FullCompactionStatus {
  if (context.active !== undefined) return 'running';
  if (context.state.phase === 'running') return 'running';
  return context.lastOutcome ?? 'idle';
}

export function compactionTaskOf(handle: ActiveCompactionHandle): FullCompactionTask {
  return {
    get id() {
      return handle.id;
    },
    get status(): FullCompactionStatus {
      return handle.outcome ?? 'running';
    },
  };
}

function newCompactionId(): string {
  return `compaction_${ulid()}`;
}

function manager(runtime: CompactionRuntimeContext): IAgentLifecycleService {
  return runtime.get(IAgentLifecycleService);
}

export function profileOf(runtime: CompactionRuntimeContext): ProfileRuntime {
  return manager(runtime).resolve(runtime.agent, AgentProfile);
}

export function contextMemoryOf(runtime: CompactionRuntimeContext): ContextMemoryRuntime {
  return manager(runtime).resolve(runtime.agent, AgentContextMemory);
}

export function llmRequesterOf(runtime: CompactionRuntimeContext): LlmRequesterRuntime {
  return manager(runtime).resolve(runtime.agent, AgentLlmRequester);
}

export function todoOf(runtime: CompactionRuntimeContext): TodoRuntime {
  return manager(runtime).resolve(runtime.agent, AgentTodo);
}

export function tokenCountingOf(runtime: CompactionRuntimeContext): ISessionTokenCountingService {
  return runtime.get(ISessionTokenCountingService);
}

export function telemetryOf(runtime: CompactionRuntimeContext): ITelemetryService {
  return runtime.get(IAgentHostService).of(runtime.agent).telemetry;
}

export function strategyOf(runtime: CompactionRuntimeContext): CompactionStrategy {
  return new RuntimeCompactionStrategy(
    () => resolveModelContextWithEffectiveMax(runtime),
    (message) => tokenCountingOf(runtime).estimateMessage(message),
  );
}

function getEffectiveMaxContextTokens(runtime: CompactionRuntimeContext): number {
  const profile = profileOf(runtime);
  const capability = profile.data().modelCapabilities;
  const configured = capability.max_input_tokens ?? capability.max_context_tokens;
  const modelAlias = profile.data().modelAlias;
  const observed =
    modelAlias === undefined
      ? undefined
      : compactionContextOf(runtime).observedMaxContextTokensByModel.get(modelAlias);
  if (observed === undefined) return configured;
  if (configured <= 0) return observed;
  return Math.min(configured, observed);
}

function resolveModelContextWithEffectiveMax(runtime: CompactionRuntimeContext): ProfileModelContext {
  const resolved = profileOf(runtime).modelContext();
  const effectiveMax = getEffectiveMaxContextTokens(runtime);
  return {
    ...resolved,
    modelCapabilities: {
      ...resolved.modelCapabilities,
      max_context_tokens: effectiveMax,
      max_input_tokens: effectiveMax,
    },
  };
}

export function currentRequestTokens(runtime: CompactionRuntimeContext): number {
  return requestTokens(runtime, contextMemoryOf(runtime).get());
}

export function requestTokens(runtime: CompactionRuntimeContext, messages: readonly Message[]): number {
  return tokenCountingOf(runtime).requestSize({
    systemPrompt: profileOf(runtime).systemPrompt(),
    tools: defaultTools(runtime).filter((tool) => tool.deferred !== true),
    messages,
  });
}

function defaultTools(runtime: CompactionRuntimeContext): readonly Tool[] {
  return manager(runtime)
    .resolve(runtime.agent, AgentTools)
    .toolsForModel()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      deferred: tool.deferred,
    }));
}

function tokenCountWithPending(runtime: CompactionRuntimeContext): number {
  return tokenCountingOf(runtime).get(runtime.agent).size;
}

export function shouldRecoverFromContextOverflow(
  runtime: CompactionRuntimeContext,
  error: unknown,
  estimatedRequestTokens = currentRequestTokens(runtime),
): boolean {
  if (isCodedError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW) return true;
  const statusError = findAPIStatusError(error);
  if (statusError instanceof APIContextOverflowError) return true;
  if (statusError === undefined || statusError.statusCode !== 413) return false;
  const effectiveMax = getEffectiveMaxContextTokens(runtime);
  return (
    effectiveMax > 0 &&
    estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
  );
}

export function observeContextOverflow(
  runtime: CompactionRuntimeContext,
  estimatedRequestTokens: number,
): void {
  if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
  const modelAlias = profileOf(runtime).data().modelAlias;
  if (modelAlias === undefined) return;
  const observed = Math.max(
    1,
    Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
  );
  const current = getEffectiveMaxContextTokens(runtime);
  if (current > 0 && observed >= current) return;
  runtime.send({ type: 'fullCompaction.contextWindowObserved', modelAlias, maxTokens: observed });
}

function createCompactionHandle(
  data: CompactionBeginData,
  tokenCount: number,
  originTurnId: number | undefined,
  quiescence: IDisposable | undefined,
): ActiveCompactionHandle {
  const abortController = new AbortController();
  let resolve!: (result: CompactionResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<CompactionResult>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  void promise.catch(() => undefined);
  return {
    id: newCompactionId(),
    startedAt: Date.now(),
    abortController,
    promise,
    trigger: data.source,
    tokenCount,
    originTurnId,
    quiescence,
    data,
    get traceId() {
      return this.trace?.traceId;
    },
    outcome: undefined,
    blockedByTurn: false,
    resolve,
    reject,
    detached: false,
  };
}

function validateCompactionStart(
  runtime: CompactionRuntimeContext,
  source: CompactionBeginData['source'],
): number {
  const history = contextMemoryOf(runtime).get();
  if (history.length === 0) {
    throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
  }
  if (source === 'manual' && getLoopControl(runtime.agent).status().state !== 'idle') {
    throw new Error2(
      ErrorCodes.COMPACTION_UNABLE,
      'Cannot compact while a turn is active. Wait for it to finish, then retry.',
    );
  }
  return requestTokens(runtime, history);
}

function startCompaction(
  runtime: CompactionRuntimeContext,
  input: FullCompactionBeginInput,
): ActiveCompactionHandle {
  const current = compactionContextOf(runtime).active;
  if (current !== undefined) return current;
  const data: CompactionBeginData = {
    source: input.source ?? 'manual',
    instruction: input.instruction,
  };
  runtime.send({ type: 'fullCompaction.slotTaken', source: data.source });
  const strategy = strategyOf(runtime);
  if (compactionContextOf(runtime).compactionCountInTurn > strategy.maxCompactionPerTurn) {
    throw new Error2(
      ErrorCodes.COMPACTION_UNABLE,
      `Compaction limit exceeded (${String(strategy.maxCompactionPerTurn)})`,
    );
  }

  const tokenCount = validateCompactionStart(runtime, data.source);
  const quiescence = data.source === 'manual'
    ? getLoopControl(runtime.agent).tryAcquireQuiescence()
    : undefined;
  if (data.source === 'manual' && quiescence === undefined) {
    throw new Error2(
      ErrorCodes.COMPACTION_UNABLE,
      'Cannot compact while a turn is active or another context change is running. Wait for it to finish, then retry.',
    );
  }
  try {
    void runtime.dispatch(new FullCompactionBegin({ ...data, agentId: runtime.agent.agentId }));

    const handle = createCompactionHandle(
      data,
      tokenCount,
      data.source === 'auto' ? compactionContextOf(runtime).activeTurnId : undefined,
      quiescence,
    );
    handle.abortController.signal.addEventListener(
      'abort',
      () => {
        if (handle.detached) return;
        runtime.send({ type: 'fullCompaction.cancelled' });
      },
      { once: true },
    );
    runtime.send({ type: 'fullCompaction.started', active: handle });
    return handle;
  } catch (error) {
    quiescence?.dispose();
    throw error;
  }
}

export async function beginFullCompaction(
  runtime: CompactionRuntimeContext,
  input: FullCompactionBeginInput = {},
): Promise<FullCompactionTask> {
  return compactionTaskOf(startCompaction(runtime, input));
}

export async function cancelFullCompaction(runtime: CompactionRuntimeContext): Promise<void> {
  const active = compactionContextOf(runtime).active;
  if (active === undefined) return;
  telemetryOf(runtime).track2('cancel', {
    from: 'compacting',
    trace_id: active.traceId,
  });
  if (!active.abortController.signal.aborted) {
    active.abortController.abort();
  }
  await active.promise.catch(() => undefined);
}

export function registerCompactionHook(
  runtime: CompactionRuntimeContext,
  name: string,
  hook: (ctx: FullCompactionHookContext) => Promise<void>,
): IDisposable {
  return compactionContextOf(runtime).beforeCompactHooks.register(name, async (ctx, next) => {
    await hook(ctx);
    await next();
  });
}

async function blockOnCompaction(
  runtime: CompactionRuntimeContext,
  signal?: AbortSignal,
  turnId?: number,
): Promise<void> {
  const active = compactionContextOf(runtime).active;
  if (active === undefined) return;
  active.blockedByTurn = true;
  signal?.addEventListener(
    'abort',
    () => {
      if (compactionContextOf(runtime).active === active) active.abortController.abort();
    },
    { once: true },
  );
  void runtime.dispatch(new CompactionBlocked({ agentId: runtime.agent.agentId, turnId }));
  try {
    await active.promise;
  } catch (error) {
    if (
      signal?.aborted === true &&
      (active.abortController.signal.aborted || isAbortError(error))
    ) {
      return;
    }
    throw error;
  }
}

export async function beforeCompactionStep(
  runtime: CompactionRuntimeContext,
  signal: AbortSignal,
  turnId?: number,
): Promise<void> {
  runtime.send({ type: 'fullCompaction.stepEntered', turnId });
  checkAutoCompaction(runtime);
  if (strategyOf(runtime).shouldBlock(tokenCountWithPending(runtime))) {
    await blockOnCompaction(runtime, signal, turnId);
  }
}

export async function afterCompactionStep(runtime: CompactionRuntimeContext): Promise<void> {
  runtime.send({ type: 'fullCompaction.stepSettled' });
  if (strategyOf(runtime).checkAfterStep) {
    checkAutoCompaction(runtime, false);
  }
}

function checkAutoCompaction(runtime: CompactionRuntimeContext, throwOnLimit = true): boolean {
  const context = compactionContextOf(runtime);
  if (context.active !== undefined) return true;
  if (
    context.lastCompactedTokenCount !== null &&
    tokenCountWithPending(runtime) <= context.lastCompactedTokenCount
  ) {
    return false;
  }
  if (!strategyOf(runtime).shouldCompact(tokenCountWithPending(runtime))) return false;
  return beginAutoCompaction(runtime, throwOnLimit);
}

function beginAutoCompaction(runtime: CompactionRuntimeContext, throwOnLimit = true): boolean {
  const context = compactionContextOf(runtime);
  if (context.active !== undefined) return true;
  const maxCompactions = strategyOf(runtime).maxCompactionPerTurn;
  if (context.compactionCountInTurn >= maxCompactions) {
    if (throwOnLimit) {
      throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
        details: { maxCompactions },
      });
    }
    return false;
  }
  startCompaction(runtime, { source: 'auto' });
  return true;
}

export async function recoverFromContextOverflow(
  runtime: CompactionRuntimeContext,
  context: LoopErrorContext,
): Promise<boolean> {
  recordOverflowRecovery(runtime, context.error);
  const didStartCompaction = beginAutoCompaction(runtime);
  if (!didStartCompaction && compactionContextOf(runtime).active === undefined) return false;

  await blockOnCompaction(runtime, context.signal, context.turnId);
  return retryFailedDriver(context);
}

function recordOverflowRecovery(runtime: CompactionRuntimeContext, error: unknown): void {
  observeContextOverflow(runtime, currentRequestTokens(runtime));
  runtime.send({ type: 'fullCompaction.overflowRecovered' });
  const maxAttempts = strategyOf(runtime).maxOverflowCompactionAttempts;
  if (compactionContextOf(runtime).consecutiveOverflowCompactions <= maxAttempts) return;
  throw new Error2(
    ErrorCodes.CONTEXT_OVERFLOW,
    `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
    { cause: error instanceof Error ? error : undefined },
  );
}

function retryFailedDriver(context: LoopErrorContext): boolean {
  const driver = context.failedDriver;
  if (driver === undefined || context.currentStep?.signal.aborted === true) return false;
  context.retry(driver, { at: 'head' });
  return true;
}
