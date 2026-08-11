import type { Message } from '#/kosong/contract/message';
import type { Tool as LLMTool } from '#/kosong/contract/tool';
import { expect } from 'vitest';

import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';

const IS_EVENT_ARRAY = Symbol('isEventArray');
const IS_GENERATE_INPUT_SNAPSHOT = Symbol('isGenerateInputSnapshot');
const IS_GENERATE_INPUTS_SNAPSHOT = Symbol('isGenerateInputsSnapshot');

export const DEFAULT_TEST_SYSTEM_PROMPT = 'You are a deterministic test agent.';

export interface RpcSnapshotEntry {
  readonly type: '[rpc]';
  readonly event: string;
  readonly args: unknown;
}

export interface WireSnapshotEntry {
  readonly type: '[wire]';
  readonly event: string;
  readonly args: unknown;
}

export type EventSnapshotEntry = WireSnapshotEntry | RpcSnapshotEntry;

export interface GenerateCall {
  readonly systemPrompt: string;
  readonly tools: Array<Pick<LLMTool, 'name' | 'description' | 'parameters'>>;
  readonly history: Message[];
}

export type EventSnapshot = ReturnType<typeof eventSnapshot>;

export interface GenerateInputSnapshot {
  readonly [IS_GENERATE_INPUT_SNAPSHOT]: true;
  readonly input: GenerateCall;
  readonly previous: GenerateCall | undefined;
}

export interface GenerateInputsSnapshot {
  readonly [IS_GENERATE_INPUTS_SNAPSHOT]: true;
  readonly inputs: readonly GenerateCall[];
  readonly previous: GenerateCall | undefined;
}

export function eventSnapshot(
  events: readonly EventSnapshotEntry[],
  labels: SnapshotLabels,
) {
  const normalized = events.map((event) => normalizeValue(event, labels));
  (normalized as unknown as Record<symbol, true>)[IS_EVENT_ARRAY] = true;
  return normalized;
}

interface SnapshotLabels {
  readonly uuidLabels: Map<string, string>;
  readonly msgLabels: Map<string, string>;
}

export function createEventSnapshotter() {
  const labels: SnapshotLabels = {
    uuidLabels: new Map<string, string>(),
    msgLabels: new Map<string, string>(),
  };

  return (events: readonly EventSnapshotEntry[]): EventSnapshot => eventSnapshot(events, labels);
}

export function generateInputSnapshot(
  input: GenerateCall,
  previous: GenerateCall | undefined,
): GenerateInputSnapshot {
  return {
    [IS_GENERATE_INPUT_SNAPSHOT]: true,
    input,
    previous,
  };
}

export function generateInputsSnapshot(
  inputs: readonly GenerateCall[],
  previous: GenerateCall | undefined,
): GenerateInputsSnapshot {
  return {
    [IS_GENERATE_INPUTS_SNAPSHOT]: true,
    inputs,
    previous,
  };
}

export function normalizeGenerateInput(input: GenerateCall): GenerateCall {
  return stripUndefined(input) as GenerateCall;
}

function stringifyCompact(obj: unknown) {
  return JSON.stringify(obj, null, 1).replaceAll(/\n\s*/g, ' ').trim();
}

function hasSnapshotSymbol(val: unknown, symbol: symbol): boolean {
  return (
    val !== null && typeof val === 'object' && Boolean((val as Record<symbol, unknown>)[symbol])
  );
}

expect.addSnapshotSerializer({
  test(val) {
    return hasSnapshotSymbol(val, IS_EVENT_ARRAY);
  },
  serialize(val) {
    const events = val as Array<Record<string, unknown>>;
    if (events.length === 0) return '[]';

    const maxEventLength = Math.max(...events.map((event) => String(event['event']).length), 0) + 2;
    return events
      .map((v) => {
        const prefix = v['type'] === '[rpc]' ? '[emit]' : '[wire]';
        return `${prefix} ${String(v['event']).padEnd(maxEventLength, ' ')} ${stringifyCompact(v['args'])}`;
      })
      .join('\n');
  },
});

expect.addSnapshotSerializer({
  test(val) {
    return hasSnapshotSymbol(val, IS_GENERATE_INPUT_SNAPSHOT);
  },
  serialize(val) {
    const snapshot = val as GenerateInputSnapshot;
    return formatGenerateInput(snapshot.input, snapshot.previous);
  },
});

expect.addSnapshotSerializer({
  test(val) {
    return hasSnapshotSymbol(val, IS_GENERATE_INPUTS_SNAPSHOT);
  },
  serialize(val) {
    const snapshot = val as GenerateInputsSnapshot;
    let previous = snapshot.previous;
    return snapshot.inputs
      .map((input, index) => {
        const formatted = formatGenerateInput(input, previous);
        previous = input;
        return `call ${String(index + 1)}:\n${indentLines(formatted)}`;
      })
      .join('\n\n');
  },
});

function formatGenerateInput(input: GenerateCall, previous: GenerateCall | undefined): string {
  const lines: string[] = [];

  if (previous === undefined || previous.systemPrompt !== input.systemPrompt) {
    lines.push(`system: ${formatSystemPrompt(input.systemPrompt)}`);
  }

  if (previous === undefined || !isDeepEqual(previous.tools, input.tools)) {
    lines.push(`tools: ${formatToolNames(input.tools)}`);
  }

  lines.push('messages:');

  if (previous !== undefined && isMessagePrefix(previous.history, input.history)) {
    const addedMessages = input.history.slice(previous.history.length);
    lines.push('  <last>');
    if (addedMessages.length > 0) {
      lines.push(...formatMessages(addedMessages));
    }
    return lines.join('\n');
  }

  lines.push(...formatMessages(input.history));
  return lines.join('\n');
}

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatSystemPrompt(systemPrompt: string): string {
  if (systemPrompt === DEFAULT_TEST_SYSTEM_PROMPT) return '<system-prompt>';
  return JSON.stringify(systemPrompt);
}

function formatToolNames(tools: GenerateCall['tools']): string {
  if (tools.length === 0) return '[]';
  return tools.map((tool) => tool.name).join(', ');
}

function isMessagePrefix(previous: readonly Message[], input: readonly Message[]): boolean {
  if (previous.length > input.length) return false;
  return previous.every((message, index) => isDeepEqual(message, input[index]));
}

function formatMessages(messages: readonly Message[]): string[] {
  if (messages.length === 0) return ['  []'];

  return messages.map((message) => {
    const role =
      message.toolCallId === undefined ? message.role : `${message.role}[${message.toolCallId}]`;
    const parts = [formatContent(message.content)];
    if (message.toolCalls.length > 0) {
      parts.push(`calls ${message.toolCalls.map((call) => formatToolCall(call)).join(', ')}`);
    }
    return `  ${role}: ${parts.join('  ')}`;
  });
}

function formatContent(content: Message['content']): string {
  if (content.length === 0) return '[]';

  return content
    .map((part) => {
      if (part.type === 'text') return `text ${formatText(part.text)}`;
      if (part.type === 'think') return `think ${JSON.stringify(part.think)}`;
      return stringifyCompact(part);
    })
    .join(' + ');
}

function formatText(text: string): string {
  if (isAutoModeEnterReminder(text)) {
    return '<auto-mode-enter-reminder>';
  }
  if (isAutoModeExitReminder(text)) {
    return '<auto-mode-exit-reminder>';
  }
  if (isPlanModeReminder(text)) {
    return '<plan-mode-reminder>';
  }
  if (text.includes('first-person handoff note')) {
    return '<compaction-instruction>';
  }
  return JSON.stringify(text);
}

function formatToolCall(call: Message['toolCalls'][number]): string {
  return `${call.id}:${call.name} ${formatToolCallArguments(call.arguments)}`;
}

function formatToolCallArguments(args: string | null): string {
  if (args === null) return 'null';

  try {
    return stringifyCompact(JSON.parse(args));
  } catch {
    return JSON.stringify(args);
  }
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeValue(value: unknown, labels: SnapshotLabels): unknown {
  if (typeof value === 'string') {
    if (isAutoModeEnterReminder(value)) return '<auto-mode-enter-reminder>';
    if (isAutoModeExitReminder(value)) return '<auto-mode-exit-reminder>';
    if (isPlanModeReminder(value)) return '<plan-mode-reminder>';
    if (isUuid(value)) return labelFor(value, labels.uuidLabels, 'uuid');
    if (isMessageId(value)) return labelFor(value, labels.msgLabels, 'msg');
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, labels));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isVolatileDurationKey(key))
        .map(([key, nested]) => [key, normalizeObjectField(key, nested, labels)]),
    );
  }

  return value;
}

function normalizeObjectField(key: string, value: unknown, labels: SnapshotLabels): unknown {
  if (
    (key === 'time' || key === 'created_at' || key === 'since' || key === 'at') &&
    typeof value === 'number'
  ) {
    return '<time>';
  }
  if ((key === 'finishedAt' || key === 'abortedAt' || key === 'steeredAt') && typeof value === 'string') return '<time>';
  if (key === 'protocol_version' && value === WIRE_PROTOCOL_VERSION) {
    return '<protocol-version>';
  }
  if (key === 'cwd' && typeof value === 'string') return '<cwd>';
  return normalizeValue(value, labels);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, stripUndefined(nested)]),
    );
  }

  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isMessageId(value: string): boolean {
  return /^msg_[0-9A-Z]{26}$/.test(value);
}

function labelFor(value: string, labels: Map<string, string>, kind: string): string {
  let label = labels.get(value);
  if (label === undefined) {
    label = `<${kind}-${String(labels.size + 1)}>`;
    labels.set(value, label);
  }
  return label;
}

function isVolatileDurationKey(key: string): boolean {
  return (
    key === 'llmFirstTokenLatencyMs' ||
    key === 'llmStreamDurationMs' ||
    key === 'llmRequestBuildMs' ||
    key === 'llmServerFirstTokenMs' ||
    key === 'llmServerDecodeMs' ||
    key === 'llmClientConsumeMs' ||
    key === 'durationMs'
  );
}

function isPlanModeReminder(value: string): boolean {
  return (
    value.includes('Plan mode is active. You MUST NOT make any edits') &&
    value.includes('Plan file:')
  );
}

function isAutoModeEnterReminder(value: string): boolean {
  return value.includes('Auto permission mode is active.');
}

function isAutoModeExitReminder(value: string): boolean {
  return value.includes('Auto permission mode is no longer active.');
}
