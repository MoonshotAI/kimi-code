import { TestkitError } from '#/errors';
import type {
  ErrorSpec,
  ErrorStep,
  FinishSpec,
  NetworkErrorStep,
  RawStep,
  ReplyPart,
  ReplyStep,
  ScriptedStep,
  ToolCallSpec,
  UsageSpec,
} from '#/model/types';

export interface SayOptions {
  readonly intervalMs?: number;
}

export function say(text: string | readonly string[], options: SayOptions = {}): ReplyStep {
  const chunks = typeof text === 'string' ? [text] : text;
  return {
    ...replyOf(
      chunks.map((chunk) => ({ type: 'text', text: chunk })),
      `say(${JSON.stringify(text)})`,
    ),
    timing: { intervalMs: options.intervalMs },
  };
}

export function think(text: string | readonly string[], then?: ReplyStep): ReplyStep {
  const chunks = typeof text === 'string' ? [text] : text;
  return prepend(
    chunks.map((chunk) => ({ type: 'think', text: chunk })),
    `think(${JSON.stringify(text)})`,
    then,
  );
}

export function thinkSigned(text: string, signature: string, then?: ReplyStep): ReplyStep {
  return prepend([{ type: 'think', text, signature }], `thinkSigned(${JSON.stringify(text)})`, then);
}

export interface CallOptions {
  readonly text?: string;
  readonly id?: string;
  readonly rawArguments?: string;
  readonly argumentChunks?: number;
  readonly invalid?: boolean;
}

export function call(name: string, args: Readonly<Record<string, unknown>>, options: CallOptions = {}): ReplyStep {
  if (options.argumentChunks !== undefined && (!Number.isInteger(options.argumentChunks) || options.argumentChunks < 1)) {
    throw new TestkitError(`call(${JSON.stringify(name)}) needs argumentChunks to be a positive integer, got ${options.argumentChunks}`);
  }
  const spec: ToolCallSpec = {
    name,
    args,
    id: options.id,
    rawArguments: options.rawArguments,
    argumentChunks: options.argumentChunks,
    invalid: options.invalid,
  };
  const parts: ReplyPart[] = options.text === undefined ? [] : [{ type: 'text', text: options.text }];
  parts.push({ type: 'call', call: spec });
  return replyOf(parts, `call(${JSON.stringify(name)})`);
}

export function reply(...steps: readonly ReplyStep[]): ReplyStep {
  return replyOf(
    steps.flatMap((step) => step.parts),
    `reply(${steps.map((step) => step.label).join(', ')})`,
  );
}

export function batch(...steps: readonly ReplyStep[]): ReplyStep {
  return { ...reply(...steps), label: `batch(${steps.map((step) => step.label).join(', ')})` };
}

export function interleave(step: ReplyStep): ReplyStep {
  return { ...step, interleaveCalls: true, label: `interleave(${step.label})` };
}

export function finishWith(finish: FinishSpec, step: ReplyStep): ReplyStep {
  return { ...step, finish, label: `finishWith(${JSON.stringify(finish)}, ${step.label})` };
}

export function withUsage(usage: UsageSpec | null, step: ReplyStep): ReplyStep {
  return { ...step, usage, label: `withUsage(${JSON.stringify(usage)}, ${step.label})` };
}

export function withResponseId(responseId: string, step: ReplyStep): ReplyStep {
  return { ...step, responseId, label: `withResponseId(${JSON.stringify(responseId)}, ${step.label})` };
}

export function paced(intervalMs: number, step: ReplyStep): ReplyStep {
  return { ...step, timing: { ...step.timing, intervalMs }, label: `paced(${intervalMs}, ${step.label})` };
}

export function after<S extends ScriptedStep>(delayMs: number, step: S): S {
  return { ...step, timing: { ...step.timing, delayMs }, label: `after(${delayMs}, ${step.label})` };
}

export function held<S extends ScriptedStep>(name: string, step: S, beforeUnit = 0): S {
  const units = unitsOf(step);
  if (!Number.isInteger(beforeUnit) || beforeUnit < 0 || beforeUnit > units) {
    throw new TestkitError(
      `held(${JSON.stringify(name)}) must pause before a unit between 0 and ${units} of ${step.label}, got ${beforeUnit}`,
    );
  }
  return { ...step, hold: { name, beforeUnit }, label: `held(${JSON.stringify(name)}, ${step.label}, ${beforeUnit})` };
}

export interface HttpErrorOptions {
  readonly message?: string;
  readonly type?: string;
  readonly code?: string | number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly traceId?: string;
}

export function httpError(status: number, options: HttpErrorOptions = {}): ErrorStep {
  return {
    kind: 'error',
    error: errorSpec(status, options),
    timing: {},
    label: `httpError(${status})`,
  };
}

export function streamError(step: ReplyStep, options: HttpErrorOptions & { readonly status?: number } = {}): ReplyStep {
  return {
    ...step,
    ending: { type: 'stream-error', error: errorSpec(options.status ?? 500, options) },
    label: `streamError(${step.label})`,
  };
}

export function disconnect(step: ReplyStep): ReplyStep {
  return { ...step, ending: { type: 'disconnect' }, label: `disconnect(${step.label})` };
}

export function networkError(): NetworkErrorStep {
  return { kind: 'network-error', timing: {}, label: 'networkError()' };
}

export interface RawResponseOptions {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks: readonly string[];
}

export function rawResponse(options: RawResponseOptions): RawStep {
  return {
    kind: 'raw',
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'text/event-stream' },
    chunks: options.chunks,
    timing: {},
    label: `rawResponse(${options.status ?? 200})`,
  };
}

export function unitsOf(step: ScriptedStep): number {
  if (step.kind !== 'reply') return 0;
  return step.parts.reduce((total, part) => total + (part.type === 'call' ? 1 + argumentChunkCount(part.call) : 1), 0);
}

export function argumentChunkCount(call: ToolCallSpec): number {
  return call.argumentChunks ?? 1;
}

export function argumentsText(call: ToolCallSpec): string {
  return call.rawArguments ?? JSON.stringify(call.args);
}

function replyOf(parts: readonly ReplyPart[], label: string): ReplyStep {
  return {
    kind: 'reply',
    parts,
    ending: { type: 'complete' },
    interleaveCalls: false,
    timing: {},
    label,
  };
}

function prepend(parts: readonly ReplyPart[], label: string, then: ReplyStep | undefined): ReplyStep {
  if (then === undefined) return replyOf(parts, label);
  return { ...then, parts: [...parts, ...then.parts], label: `${label} + ${then.label}` };
}

function errorSpec(status: number, options: HttpErrorOptions): ErrorSpec {
  const headers: Record<string, string> = { ...options.headers };
  if (options.retryAfterSeconds !== undefined) headers['retry-after'] = String(options.retryAfterSeconds);
  if (options.retryAfterMs !== undefined) headers['retry-after-ms'] = String(options.retryAfterMs);
  if (options.requestId !== undefined) headers['x-request-id'] = options.requestId;
  if (options.traceId !== undefined) headers['x-trace-id'] = options.traceId;
  return {
    status,
    message: options.message ?? `testkit error ${status}`,
    type: options.type,
    code: options.code,
    body: options.body,
    headers,
  };
}
