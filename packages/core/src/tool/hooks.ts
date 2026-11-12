/**
 * Tool hook registry and runners for the `tool.starting`, `tool.permitting`, and `tool.ending` points,
 * including validation of hook decisions and failure handling.
 */
import type { ToolCall } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';

import {
  isToolResult,
  type Cause,
  type ToolEndingDecision,
  type ToolEndingHookEvent,
  type ToolExecutorHooks,
  type ToolHookFailure,
  type ToolHookFailurePolicy,
  type ToolHookInfo,
  type ToolHookPoint,
  type ToolHooks,
  type ToolPermittingDecision,
  type ToolResult,
  type ToolStartingDecision,
  type ToolStartingHookEvent,
} from './contract';

interface ToolHookItem<P extends ToolHookPoint = ToolHookPoint> {
  readonly id: string;
  readonly point: P;
  readonly hook: ToolHooks[P];
  readonly onFailure: ToolHookFailurePolicy;
  paused: boolean;
}

export interface ToolHookSource {
  active<P extends ToolHookPoint>(point: P): readonly ToolHookItem<P>[];
  suspend(id: string): void;
}

export function createToolHookRegistry(): ToolExecutorHooks & ToolHookSource {
  const items = new Map<string, ToolHookItem>();
  let seq = 0;
  return {
    add(registration) {
      seq += 1;
      const id = registration.id ?? `${registration.point}#${seq}`;
      if (items.has(id)) throw new Error(`hook ${id} already exists`);
      items.set(id, {
        id,
        point: registration.point,
        hook: registration.hook,
        onFailure: registration.onFailure ?? 'pause',
        paused: false,
      } as ToolHookItem);
      return id;
    },
    remove(id) {
      items.delete(id);
    },
    list: () =>
      [...items.values()].map(({ id, point, onFailure, paused }): ToolHookInfo => ({
        id,
        point,
        onFailure,
        paused,
      })),
    active: <P extends ToolHookPoint>(point: P) =>
      [...items.values()].filter((item): item is ToolHookItem<P> => item.point === point && !item.paused),
    suspend(id) {
      const item = items.get(id);
      if (item !== undefined) item.paused = true;
    },
  };
}

export function toolHookFailureText(point: ToolHookPoint, error: unknown): string {
  return `[hook failed] ${point}: ${errorText(error)}`;
}

export function toolHookFailureCause(point: ToolHookPoint, error: unknown, by?: string): Cause {
  return { ...(by === undefined ? {} : { by }), reason: 'hook_failed', message: toolHookFailureText(point, error) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolCall(value: unknown): value is ToolCall {
  return isObject(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string';
}

function isCause(value: unknown): value is Cause {
  return (
    isObject(value) &&
    typeof value['reason'] === 'string' &&
    (value['by'] === undefined || typeof value['by'] === 'string') &&
    (value['message'] === undefined || typeof value['message'] === 'string') &&
    (value['details'] === undefined || isObject(value['details']))
  );
}

function isToolPermittingDecision(value: unknown): value is ToolPermittingDecision {
  if (!isObject(value)) return false;
  if ('toolCall' in value) return isToolCall(value['toolCall']);
  return isCause(value['blocked']) && (value['result'] === undefined || isToolResult(value['result']));
}

function isToolStartingDecision(value: unknown): value is ToolStartingDecision {
  if (!isObject(value)) return false;
  if ('skipPermitting' in value) return value['skipPermitting'] === true;
  return isToolPermittingDecision(value);
}

function isToolEndingDecision(value: unknown): value is ToolEndingDecision {
  return isObject(value) && (value['result'] === undefined || isToolResult(value['result']));
}

interface ItemRun<D> {
  decision?: D;
  failure?: ToolHookFailure;
  blocked?: Cause;
}

async function runItem<D>(
  item: ToolHookItem,
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
      blocked: blocking ? toolHookFailureCause(item.point, error, item.id) : undefined,
    };
  }
}

function signed(cause: Cause, item: ToolHookItem): Cause {
  return cause.by === undefined ? { ...cause, by: item.id } : cause;
}

export interface ToolStartingRun {
  toolCall: ToolCall;
  blocked?: Cause;
  result?: ToolResult;
  skipPermitting?: boolean;
  failures: ToolHookFailure[];
}

export type ToolPermittingRun = ToolStartingRun;

async function runToolCallChain(
  source: ToolHookSource,
  point: 'tool.starting' | 'tool.permitting',
  event: ToolStartingHookEvent,
  signal: AbortSignal,
): Promise<ToolStartingRun> {
  const failures: ToolHookFailure[] = [];
  let toolCall = event.toolCall;
  let skipPermitting = false;
  const isDecision = point === 'tool.starting' ? isToolStartingDecision : isToolPermittingDecision;
  for (const item of source.active(point)) {
    const run = await runItem(item, () => item.hook({ ...event, toolCall }, signal), isDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    const decision = run.decision;
    if (decision !== undefined && 'toolCall' in decision) {
      toolCall = decision.toolCall;
    } else if (decision !== undefined && 'skipPermitting' in decision) {
      skipPermitting = true;
    } else if (decision !== undefined) {
      return { toolCall, blocked: signed(decision.blocked, item), result: decision.result, failures };
    }
    if (run.blocked !== undefined) return { toolCall, blocked: run.blocked, failures };
  }
  return skipPermitting ? { toolCall, skipPermitting, failures } : { toolCall, failures };
}

export function runToolStarting(
  source: ToolHookSource,
  event: ToolStartingHookEvent,
  signal: AbortSignal,
): Promise<ToolStartingRun> {
  return runToolCallChain(source, 'tool.starting', event, signal);
}

export function runToolPermitting(
  source: ToolHookSource,
  event: ToolStartingHookEvent,
  signal: AbortSignal,
): Promise<ToolPermittingRun> {
  return runToolCallChain(source, 'tool.permitting', event, signal);
}

export interface ToolEndingRun {
  result: ToolResult;
  blocked?: Cause;
  failures: ToolHookFailure[];
}

export async function runToolEnding(
  source: ToolHookSource,
  event: ToolEndingHookEvent,
  signal: AbortSignal,
): Promise<ToolEndingRun> {
  const failures: ToolHookFailure[] = [];
  let result = event.result;
  for (const item of source.active('tool.ending')) {
    const run = await runItem(item, () => item.hook({ ...event, result }, signal), isToolEndingDecision);
    if (run.failure !== undefined) failures.push(run.failure);
    if (run.blocked !== undefined) return { result, blocked: run.blocked, failures };
    result = run.decision?.result ?? result;
  }
  return { result, failures };
}
