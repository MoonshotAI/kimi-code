import { readHookChainResult, type HookFailure } from '#/hook/result';
import type { Message } from '#/llm/message';
import type {
  LoopHooks,
  HookPoint,
  MessageAppendingDecision,
  MessageAppendingEvent,
  StepContinuingVerdict,
  StepStartingDecision,
  StepStartingEvent,
  StepStoppingVerdict,
  HookToolResult,
  ToolBatchStartingDecision,
  ToolBatchStartingEvent,
  TurnStartingEvent,
  TurnStartingVerdict,
} from '#/loop/contract/hook';
import type { Cause, StepEndingPoint, StepOutcome } from '#/loop/contract/outcome';
import { isCause, isHookToolResult, isMessage, isObject } from '#/loop/guards';

export function isTurnStartingVerdict(value: unknown): value is TurnStartingVerdict {
  return isObject(value) && value['type'] === 'blocked' && isCause(value['cause']);
}

export function isMessageAppendingDecision(value: unknown): value is MessageAppendingDecision {
  return (
    isObject(value) &&
    (value['message'] === undefined || isMessage(value['message'])) &&
    (value['blocked'] === undefined || isCause(value['blocked']))
  );
}

export function isStepStartingDecision(value: unknown): value is StepStartingDecision {
  return isObject(value) && (value['blocked'] === undefined || isCause(value['blocked']));
}

export function isToolBatchStartingDecision(value: unknown): value is ToolBatchStartingDecision {
  return (
    isObject(value) &&
    isCause(value['blocked']) &&
    (value['result'] === undefined || isHookToolResult(value['result']))
  );
}

export function isStepStoppingVerdict(value: unknown): value is StepStoppingVerdict {
  return isObject(value) && (value['type'] === 'continue' || value['type'] === 'done') && isCause(value['cause']);
}

export function isStepContinuingVerdict(value: unknown): value is StepContinuingVerdict {
  return isObject(value) && (value['type'] === 'done' || value['type'] === 'blocked') && isCause(value['cause']);
}

export interface HookRun<D> {
  decision?: D;
  blocked?: Cause;
  failures: HookFailure[];
}

async function runItem<D>(
  point: HookPoint,
  call: () => unknown,
  isValid: (value: unknown) => value is D,
): Promise<HookRun<D>> {
  const failures: HookFailure[] = [];
  const fail = (error: unknown): HookRun<D> => {
    failures.push({ error, paused: false, blocking: false });
    return { failures };
  };
  let returned: unknown;
  try {
    returned = await call();
  } catch (error) {
    return fail(error);
  }
  try {
    const chained = readHookChainResult(returned);
    if (chained !== undefined) failures.push(...chained.failures);
    const blocked = chained?.blocked;
    if (blocked !== undefined && !isCause(blocked)) throw new Error(`invalid ${point} hook blocked cause`);
    const value = chained === undefined ? returned : chained.decision;
    if (value === undefined) return { failures, blocked };
    if (isValid(value)) return { decision: value, failures, blocked };
    throw new Error(`invalid ${point} hook result`);
  } catch (error) {
    return fail(error);
  }
}

export interface TurnStartingRun {
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runTurnStarting(
  hooks: Partial<LoopHooks>,
  event: TurnStartingEvent,
  signal: AbortSignal,
): Promise<TurnStartingRun> {
  const hook = hooks['turn.starting'];
  if (hook === undefined) return { failures: [] };
  const run = await runItem('turn.starting', () => hook(event, signal), isTurnStartingVerdict);
  const blocked = run.decision?.cause ?? run.blocked;
  return blocked === undefined ? { failures: run.failures } : { blocked, failures: run.failures };
}

export interface MessageAppendingRun {
  message: Message;
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runMessageAppending(
  hooks: Partial<LoopHooks>,
  event: MessageAppendingEvent,
  signal: AbortSignal,
): Promise<MessageAppendingRun> {
  const hook = hooks['message.appending'];
  if (hook === undefined) return { message: event.item.message, failures: [] };
  const run = await runItem('message.appending', () => hook(event, signal), isMessageAppendingDecision);
  return {
    message: run.decision?.message ?? event.item.message,
    blocked: run.decision?.blocked ?? run.blocked,
    failures: run.failures,
  };
}

export interface StepStartingRun {
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runStepStarting(
  hooks: Partial<LoopHooks>,
  event: StepStartingEvent,
  signal: AbortSignal,
): Promise<StepStartingRun> {
  const hook = hooks['step.starting'];
  if (hook === undefined) return { failures: [] };
  const run = await runItem('step.starting', () => hook(event, signal), isStepStartingDecision);
  return {
    blocked: run.decision?.blocked ?? run.blocked,
    failures: run.failures,
  };
}

export interface ToolBatchStartingRun {
  blocked?: { cause: Cause; result?: HookToolResult };
  failures: HookFailure[];
}

export async function runToolBatchStarting(
  hooks: Partial<LoopHooks>,
  event: ToolBatchStartingEvent,
  signal: AbortSignal,
): Promise<ToolBatchStartingRun> {
  const hook = hooks['tool.batch-starting'];
  if (hook === undefined) return { failures: [] };
  const run = await runItem('tool.batch-starting', () => hook(event, signal), isToolBatchStartingDecision);
  if (run.decision !== undefined) {
    return { blocked: { cause: run.decision.blocked, result: run.decision.result }, failures: run.failures };
  }
  return run.blocked === undefined
    ? { failures: run.failures }
    : { blocked: { cause: run.blocked }, failures: run.failures };
}

export interface StepEndingInput {
  readonly turnId: number;
  readonly step: number;
  readonly draft: StepOutcome;
  readonly messages: readonly Message[];
}

export interface StepEndingFailure {
  readonly point: StepEndingPoint;
  readonly failure: HookFailure;
}

export interface StepEndingRun {
  outcome: StepOutcome;
  failures: StepEndingFailure[];
}

export async function runStepEnding(
  hooks: Partial<LoopHooks>,
  { draft, ...event }: StepEndingInput,
  signal: AbortSignal,
): Promise<StepEndingRun> {
  const failures: StepEndingFailure[] = [];
  if (draft.type === 'blocked') return { outcome: draft, failures };
  const stoppingHook = hooks['step.stopping'];
  const stopping: HookRun<StepStoppingVerdict> = stoppingHook === undefined
    ? { failures: [] }
    : await runItem('step.stopping', () => stoppingHook({ ...event, draft }, signal), isStepStoppingVerdict);
  failures.push(...stopping.failures.map((failure) => ({ point: 'step.stopping' as const, failure })));
  if (draft.type === 'aborted') return { outcome: draft, failures };
  if (stopping.blocked !== undefined) {
    return { outcome: { type: 'blocked', at: 'step.stopping', cause: stopping.blocked }, failures };
  }
  if (stopping.decision?.type === 'done') {
    return { outcome: { type: 'done', cause: stopping.decision.cause }, failures };
  }
  let cause: Cause | undefined;
  if (stopping.decision === undefined) {
    if (draft.type !== 'continue') return { outcome: draft, failures };
    cause = draft.cause;
  } else {
    cause = stopping.decision.cause;
  }
  const continuingHook = hooks['step.continuing'];
  const continuing: HookRun<StepContinuingVerdict> = continuingHook === undefined
    ? { failures: [] }
    : await runItem(
        'step.continuing',
        () => continuingHook({ ...event, ...(cause === undefined ? {} : { cause }) }, signal),
        isStepContinuingVerdict,
      );
  failures.push(...continuing.failures.map((failure) => ({ point: 'step.continuing' as const, failure })));
  const decision = continuing.decision;
  const blocked = decision?.type === 'blocked' ? decision.cause : continuing.blocked;
  if (blocked !== undefined) return { outcome: { type: 'blocked', at: 'step.continuing', cause: blocked }, failures };
  if (decision !== undefined) return { outcome: { type: 'done', cause: decision.cause }, failures };
  return { outcome: cause === undefined ? { type: 'continue' } : { type: 'continue', cause }, failures };
}
