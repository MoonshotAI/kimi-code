import type { ToolCall } from '#/llm/message';
import type { HistoryMessage } from '#/history/message';
import type { ToolResult } from '#/tool/index';
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
  ToolEndingDecision,
  ToolEndingEvent,
  ToolStartingDecision,
  ToolStartingEvent,
  TurnStartingEvent,
  TurnStartingVerdict,
} from '../contract/hook';
import type { QueuedItem } from '../contract/inbox';
import type { Cause, StepEndingPoint, StepOutcome } from '../contract/outcome';
import { isEntry, isObject, isToolCall, isToolResult } from '../guards';
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
    (value['entry'] === undefined || isEntry(value['entry'])) &&
    (value['blocked'] === undefined || isCause(value['blocked']))
  );
}

function isStepStartingDecision(value: unknown): value is StepStartingDecision {
  return (
    isObject(value) &&
    (value['messages'] === undefined ||
      (Array.isArray(value['messages']) && value['messages'].every(isEntry))) &&
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

function isToolStartingDecision(value: unknown): value is ToolStartingDecision {
  if (!isObject(value)) return false;
  if ('toolCall' in value) return isToolCall(value['toolCall']);
  return isCause(value['blocked']) && (value['result'] === undefined || isToolResult(value['result']));
}

function isToolEndingDecision(value: unknown): value is ToolEndingDecision {
  return (
    isObject(value) &&
    (value['result'] === undefined || isToolResult(value['result'])) &&
    (value['stopTurn'] === undefined || value['stopTurn'] === true)
  );
}

function isStepStoppingVerdict(value: unknown): value is StepStoppingVerdict {
  return isObject(value) && value['type'] === 'continue' && isCause(value['cause']);
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
  entry: HistoryMessage;
  blocked?: Cause;
  failures: HookFailure[];
}

export async function runMessageAppending(
  source: HookSource,
  event: MessageAppendingEvent,
  signal: AbortSignal,
): Promise<MessageAppendingRun> {
  const failures: HookFailure[] = [];
  let entry: HistoryMessage = event.item.entry;
  for (const item of source.active('message.appending')) {
    const current: MessageAppendingEvent = { ...event, item: { ...event.item, entry } as QueuedItem };
    const run = await runItem(item, () => item.hook(current, signal), isMessageAppendingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    entry = run.decision?.entry ?? entry;
    const decided = run.decision?.blocked;
    const blocked = decided === undefined ? run.blocked : signed(decided, item);
    if (blocked !== undefined) return { entry, blocked, failures };
  }
  return { entry, failures };
}

export interface StepStartingRun {
  messages: readonly HistoryMessage[];
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

export interface ToolStartingRun {
  toolCall: ToolCall;
  blocked?: Cause;
  result?: ToolResult;
  failures: HookFailure[];
}

export type ToolPermittingRun = ToolStartingRun;

async function runToolCallChain(
  source: HookSource,
  point: 'tool.starting' | 'tool.permitting',
  event: ToolStartingEvent,
  signal: AbortSignal,
): Promise<ToolStartingRun> {
  const failures: HookFailure[] = [];
  let toolCall = event.toolCall;
  for (const item of source.active(point)) {
    const run = await runItem(item, () => item.hook({ ...event, toolCall }, signal), isToolStartingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    const decision = run.decision;
    if (decision !== undefined && 'toolCall' in decision) {
      toolCall = decision.toolCall;
    } else if (decision !== undefined) {
      return { toolCall, blocked: signed(decision.blocked, item), result: decision.result, failures };
    }
    if (run.blocked !== undefined) return { toolCall, blocked: run.blocked, failures };
  }
  return { toolCall, failures };
}

export function runToolStarting(
  source: HookSource,
  event: ToolStartingEvent,
  signal: AbortSignal,
): Promise<ToolStartingRun> {
  return runToolCallChain(source, 'tool.starting', event, signal);
}

export function runToolPermitting(
  source: HookSource,
  event: ToolStartingEvent,
  signal: AbortSignal,
): Promise<ToolPermittingRun> {
  return runToolCallChain(source, 'tool.permitting', event, signal);
}

export interface ToolEndingRun {
  result: ToolResult;
  stopTurn: boolean;
  failures: HookFailure[];
}

export async function runToolEnding(
  source: HookSource,
  event: ToolEndingEvent,
  signal: AbortSignal,
): Promise<ToolEndingRun> {
  const failures: HookFailure[] = [];
  let result = event.result;
  let stopTurn = false;
  for (const item of source.active('tool.ending')) {
    const run = await runItem(item, () => item.hook({ ...event, result }, signal), isToolEndingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    result = run.decision?.result ?? result;
    stopTurn ||= run.decision?.stopTurn === true;
  }
  return { result, stopTurn, failures };
}

export interface StepEndingInput {
  readonly turnId: number;
  readonly step: number;
  readonly draft: StepOutcome;
  readonly messages: readonly HistoryMessage[];
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
  if (draft.type === 'done' || draft.type === 'failed') {
    const stopping = await runFirst(
      source.active('step.stopping'),
      (item) => item.hook({ ...event, draft }, signal),
      isStepStoppingVerdict,
    );
    collect('step.stopping', stopping);
    if (stopping.blocked !== undefined) {
      return { outcome: { type: 'blocked', at: 'step.stopping', cause: stopping.blocked }, failures };
    }
    if (stopping.decision === undefined) return { outcome: draft, failures };
    cause = stopping.decision.cause;
  } else if (draft.type === 'continue') {
    cause = draft.cause;
  } else {
    return { outcome: draft, failures };
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
