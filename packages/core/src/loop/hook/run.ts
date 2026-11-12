/**
 * Runs the active hooks at each loop hook point in registration order, validates their decisions, and
 * applies each hook's failure policy (pause the hook, or block) when it throws or returns an invalid value.
 */
import type { Message } from '#/llm/message';
import type { ToolResult } from '#/tool/executor';
import type {
  HookPoint,
  MessageAppendingDecision,
  MessageAppendingEvent,
  StepContinuingVerdict,
  StepStartingDecision,
  StepStartingEvent,
  StepStoppingVerdict,
  ToolBatchStartingDecision,
  ToolBatchStartingEvent,
  TurnStartingEvent,
  TurnStartingVerdict,
} from '../contract/hook';
import type { QueuedItem } from '../contract/inbox';
import type { Cause, StepEndingPoint, StepOutcome } from '../contract/outcome';
import { isMessage, isObject, isToolResult } from '../guards';
import { hookFailureCause, type HookFailure } from './failure';
import type { HookItem, HookSource } from './registry';

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCause(value: unknown): value is Cause {
  return (
    isObject(value) &&
    typeof value['reason'] === 'string' &&
    isOptionalString(value['by']) &&
    isOptionalString(value['message']) &&
    (value['details'] === undefined || isObject(value['details']))
  );
}

function isTurnStartingVerdict(value: unknown): value is TurnStartingVerdict {
  return isObject(value) && value['type'] === 'blocked' && isCause(value['cause']);
}

function isMessageAppendingDecision(value: unknown): value is MessageAppendingDecision {
  return (
    isObject(value) &&
    (value['message'] === undefined || isMessage(value['message'])) &&
    (value['blocked'] === undefined || isCause(value['blocked']))
  );
}

function isStepStartingDecision(value: unknown): value is StepStartingDecision {
  return (
    isObject(value) &&
    (value['messages'] === undefined ||
      (Array.isArray(value['messages']) && value['messages'].every(isMessage))) &&
    (value['blocked'] === undefined || isCause(value['blocked']))
  );
}

function isToolBatchStartingDecision(value: unknown): value is ToolBatchStartingDecision {
  return (
    isObject(value) &&
    isCause(value['blocked']) &&
    (value['result'] === undefined || isToolResult(value['result']))
  );
}

function isStepStoppingVerdict(value: unknown): value is StepStoppingVerdict {
  return isObject(value) && (value['type'] === 'continue' || value['type'] === 'done') && isCause(value['cause']);
}

function isStepContinuingVerdict(value: unknown): value is StepContinuingVerdict {
  return isObject(value) && (value['type'] === 'done' || value['type'] === 'blocked') && isCause(value['cause']);
}

function signed(cause: Cause, item: HookItem): Cause {
  return cause.by === undefined ? { ...cause, by: item.id } : cause;
}

interface ItemRun<D> {
  decision?: D;
  failure?: HookFailure;
  blocked?: Cause;
}

async function runItem<D>(
  item: HookItem,
  call: () => unknown,
  isValid: (value: unknown) => value is D,
): Promise<ItemRun<D>> {
  try {
    const value: unknown = await call();
    if (value === undefined) return {};
    if (isValid(value)) return { decision: value };
    throw new Error(`invalid ${item.point} hook result`);
  } catch (error) {
    const blocking = item.onFailure === 'block';
    return {
      failure: { hookId: item.id, error, paused: !blocking, blocking },
      blocked: blocking ? hookFailureCause(item.point, error, item.id) : undefined,
    };
  }
}

interface FirstRun<D> {
  decision?: D;
  blocked?: Cause;
  failures: HookFailure[];
}

async function runFirst<P extends HookPoint, D extends { readonly cause: Cause }>(
  items: readonly HookItem<P>[],
  call: (item: HookItem<P>) => unknown,
  isValid: (value: unknown) => value is D,
): Promise<FirstRun<D>> {
  const failures: HookFailure[] = [];
  for (const item of items) {
    const run = await runItem(item, () => call(item), isValid);
    if (run.failure !== undefined) failures.push(run.failure);
    if (run.decision !== undefined) {
      return { decision: { ...run.decision, cause: signed(run.decision.cause, item) }, failures };
    }
    if (run.blocked !== undefined) return { blocked: run.blocked, failures };
  }
  return { failures };
}

export interface TurnStartingRun {
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runTurnStarting(
  source: HookSource,
  event: TurnStartingEvent,
  signal: AbortSignal,
): Promise<TurnStartingRun> {
  const run = await runFirst(source.active('turn.starting'), (item) => item.hook(event, signal), isTurnStartingVerdict);
  const blocked = run.decision?.cause ?? run.blocked;
  return blocked === undefined ? { failures: run.failures } : { blocked, failures: run.failures };
}

export interface MessageAppendingRun {
  message: Message;
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runMessageAppending(
  source: HookSource,
  event: MessageAppendingEvent,
  signal: AbortSignal,
): Promise<MessageAppendingRun> {
  const failures: HookFailure[] = [];
  let message: Message = event.item.message;
  for (const item of source.active('message.appending')) {
    const current: MessageAppendingEvent = { ...event, item: { ...event.item, message } as QueuedItem };
    const run = await runItem(item, () => item.hook(current, signal), isMessageAppendingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    message = run.decision?.message ?? message;
    const decided = run.decision?.blocked;
    const blocked = decided === undefined ? run.blocked : signed(decided, item);
    if (blocked !== undefined) return { message, blocked, failures };
  }
  return { message, failures };
}

export interface StepStartingRun {
  messages: readonly Message[];
  rewrittenBy?: string;
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runStepStarting(
  source: HookSource,
  event: StepStartingEvent,
  signal: AbortSignal,
): Promise<StepStartingRun> {
  const failures: HookFailure[] = [];
  let messages = event.messages;
  let rewrittenBy: string | undefined;
  for (const item of source.active('step.starting')) {
    const run = await runItem(item, () => item.hook({ ...event, messages }, signal), isStepStartingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    if (run.decision?.messages !== undefined) {
      messages = run.decision.messages;
      rewrittenBy = item.id;
    }
    const decided = run.decision?.blocked;
    const blocked = decided === undefined ? run.blocked : signed(decided, item);
    if (blocked !== undefined) return { messages, rewrittenBy, blocked, failures };
  }
  return { messages, rewrittenBy, failures };
}

export interface ToolBatchStartingRun {
  blocked?: { cause: Cause; result?: ToolResult };
  failures: HookFailure[];
}

export async function runToolBatchStarting(
  source: HookSource,
  event: ToolBatchStartingEvent,
  signal: AbortSignal,
): Promise<ToolBatchStartingRun> {
  const failures: HookFailure[] = [];
  for (const item of source.active('tool.batch-starting')) {
    const run = await runItem(item, () => item.hook(event, signal), isToolBatchStartingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    if (run.decision !== undefined) {
      return { blocked: { cause: signed(run.decision.blocked, item), result: run.decision.result }, failures };
    }
    if (run.blocked !== undefined) return { blocked: { cause: run.blocked }, failures };
  }
  return { failures };
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
  source: HookSource,
  { draft, ...event }: StepEndingInput,
  signal: AbortSignal,
): Promise<StepEndingRun> {
  const failures: StepEndingFailure[] = [];
  const collect = (point: StepEndingPoint, run: FirstRun<unknown>) => {
    failures.push(...run.failures.map((failure) => ({ point, failure })));
  };
  let cause: Cause | undefined;
  if (draft.type === 'aborted' || draft.type === 'blocked') return { outcome: draft, failures };
  const stopping = await runFirst(
    source.active('step.stopping'),
    (item) => item.hook({ ...event, draft }, signal),
    isStepStoppingVerdict,
  );
  collect('step.stopping', stopping);
  if (stopping.blocked !== undefined) {
    return { outcome: { type: 'blocked', at: 'step.stopping', cause: stopping.blocked }, failures };
  }
  if (stopping.decision?.type === 'done') {
    return { outcome: { type: 'done', cause: stopping.decision.cause }, failures };
  }
  if (stopping.decision === undefined) {
    if (draft.type !== 'continue') return { outcome: draft, failures };
    cause = draft.cause;
  } else {
    cause = stopping.decision.cause;
  }
  const continuing = await runFirst(
    source.active('step.continuing'),
    (item) => item.hook({ ...event, ...(cause === undefined ? {} : { cause }) }, signal),
    isStepContinuingVerdict,
  );
  collect('step.continuing', continuing);
  const decision = continuing.decision;
  const blocked = decision?.type === 'blocked' ? decision.cause : continuing.blocked;
  if (blocked !== undefined) return { outcome: { type: 'blocked', at: 'step.continuing', cause: blocked }, failures };
  if (decision !== undefined) return { outcome: { type: 'done', cause: decision.cause }, failures };
  return { outcome: cause === undefined ? { type: 'continue' } : { type: 'continue', cause }, failures };
}
