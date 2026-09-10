import type { ContextMessage } from '#/agent/contextMemory/types';

import { SPINE_TOOL_TRIM } from './spine';
import { TRIM_ACCEPTED_OUTPUT } from './tools/controlResult';

export const SPINE_TRIM_THRESHOLD_BYTES = 10 * 1024;

export type SpineTrimSliceShape =
  | { readonly type: 'head'; readonly chars: number }
  | { readonly type: 'tail'; readonly chars: number }
  | {
      readonly type: 'anchor';
      readonly anchor: string;
      readonly preceding: number;
      readonly following: number;
    };

export type SpineTrimOp =
  | { readonly kind: 'snip' }
  | { readonly kind: 'slice'; readonly shape: SpineTrimSliceShape };

export interface SpineTrimProjection {
  readonly labels: ReadonlyMap<number, string>;
  readonly tagIndex: ReadonlyMap<string, number>;
  readonly masks: ReadonlyMap<number, SpineTrimOp>;
  readonly eligible: ReadonlySet<string>;
  readonly consumed: ReadonlySet<string>;
}

export function deriveSpineTrimProjection(
  messages: readonly ContextMessage[],
): SpineTrimProjection {
  const callNames = new Map<string, string>();
  const trimCalls = new Map<string, SpineTrimCallArgs>();
  const labels = new Map<number, string>();
  const tagIndex = new Map<string, number>();
  const masks = new Map<number, SpineTrimOp>();
  const consumed = new Set<string>();
  let eligible = new Set<string>();
  let pendingCalls = new Set<string>();
  let batchTags: string[] = [];
  let tagCounter = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      if (pendingCalls.size === 0) eligible = new Set(batchTags);
      pendingCalls = new Set<string>();
      batchTags = [];
      for (const call of message.toolCalls) {
        callNames.set(call.id, call.name);
        pendingCalls.add(call.id);
        if (call.name === SPINE_TOOL_TRIM) {
          const args = parseTrimCallArgs(call.arguments);
          if (args !== undefined) trimCalls.set(call.id, args);
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined) continue;
    pendingCalls.delete(callId);
    const name = callNames.get(callId);
    if (name === SPINE_TOOL_TRIM) {
      if (message.isError === true) continue;
      if (messageText(message) !== TRIM_ACCEPTED_OUTPUT) continue;
      const args = trimCalls.get(callId);
      const target = args === undefined ? undefined : tagIndex.get(args.trimId);
      if (args === undefined || target === undefined || consumed.has(args.trimId)) continue;
      masks.set(target, args.op);
      consumed.add(args.trimId);
      continue;
    }
    if (name === undefined || name.startsWith('spine_')) continue;
    if (!message.content.every((part) => part.type === 'text')) continue;
    const text = messageText(message);
    if (utf8Length(text) <= SPINE_TRIM_THRESHOLD_BYTES) continue;
    tagCounter += 1;
    const tag = `trim_${String(tagCounter)}`;
    labels.set(i, tag);
    tagIndex.set(tag, i);
    batchTags.push(tag);
  }
  if (pendingCalls.size === 0) eligible = new Set(batchTags);

  return { labels, tagIndex, masks, eligible, consumed };
}

export function normalizeTrimOp(
  op: string,
  shape: {
    readonly head?: number | undefined;
    readonly tail?: number | undefined;
    readonly anchor?: string | undefined;
    readonly preceding?: number | undefined;
    readonly following?: number | undefined;
  },
): SpineTrimOp | undefined {
  if (op === 'snip') return { kind: 'snip' };
  if (op !== 'slice') return undefined;
  const slices: SpineTrimSliceShape[] = [];
  if (shape.head !== undefined) slices.push({ type: 'head', chars: shape.head });
  if (shape.tail !== undefined) slices.push({ type: 'tail', chars: shape.tail });
  if (shape.anchor !== undefined) {
    slices.push({
      type: 'anchor',
      anchor: shape.anchor,
      preceding: shape.preceding ?? 0,
      following: shape.following ?? 0,
    });
  }
  if (slices.length !== 1) return undefined;
  const slice = slices[0];
  if (slice === undefined) return undefined;
  return { kind: 'slice', shape: slice };
}

interface SpineTrimCallArgs {
  readonly trimId: string;
  readonly op: SpineTrimOp;
}

function parseTrimCallArgs(raw: string | null): SpineTrimCallArgs | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const trimId = record['TRIM_ID'];
  if (typeof trimId !== 'string' || trimId.length === 0) return undefined;
  const op = record['op'];
  if (typeof op !== 'string') return undefined;
  const normalized = normalizeTrimOp(op, {
    head: positiveInt(record['head']),
    tail: positiveInt(record['tail']),
    anchor: nonEmptyString(record['anchor']),
    preceding: nonNegativeInt(record['preceding']),
    following: nonNegativeInt(record['following']),
  });
  if (normalized === undefined) return undefined;
  return { trimId, op: normalized };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
