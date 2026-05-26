import { readFile } from 'node:fs/promises';

import {
  migrateWireRecords,
  type WireMigrationRecord,
} from '@moonshot-ai/agent-core/agent/records/migration';

import type {
  ContentPartRecord,
  NotificationRecord,
  SessionInitializedRecord,
  StepBeginRecord,
  StepEndRecord,
  SystemReminderRecord,
  SystemPromptChangedRecord,
  ToolCallRecord,
  ToolResultRecord,
  ToolsChangedRecord,
  TurnBeginRecord,
  UserInputPart,
  UserMessageRecord,
  VisWireRecord,
  WireFileMetadata,
} from './types';

export interface ReplayWireResult {
  health: 'ok' | 'broken';
  brokenReason?: string;
  warnings: string[];
  metadata: WireFileMetadata | null;
  sessionInitialized: SessionInitializedRecord | null;
  records: VisWireRecord[];
}

export async function replayWire(wirePath: string): Promise<ReplayWireResult> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const warnings: string[] = [];
  const records: VisWireRecord[] = [];
  const rawRecords: RawWireRecord[] = [];
  let metadata: WireFileMetadata | null = null;
  let sessionInitialized: SessionInitializedRecord | null = null;
  let nextTurnIndex = 0;
  let currentTurnId = '0';

  for (const [index, line] of lines.entries()) {
    const seq = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      warnings.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      warnings.push(`line ${index + 1}: missing record type`);
      continue;
    }
    rawRecords.push({ seq, raw: parsed });
  }

  // Extract source version from metadata (if any) and apply wire migrations.
  let sourceVersion: string | undefined;
  for (const record of rawRecords) {
    if (record.raw['type'] === 'metadata') {
      const meta = record.raw as unknown as WireFileMetadata;
      sourceVersion ??= meta.protocol_version;
    }
  }
  const migrated = migrateWireRecords(
    rawRecords.map((r) => r.raw as WireMigrationRecord),
    sourceVersion,
  );
  for (const [i, rawRecord] of rawRecords.entries()) {
    rawRecord.raw = migrated[i]!;
  }

  for (const [recordIndex, record] of rawRecords.entries()) {
    const parsed = record.raw;
    const seq = record.seq;
    if (parsed['type'] === 'metadata') {
      metadata ??= parsed as unknown as WireFileMetadata;
      continue;
    }
    if (parsed['type'] === 'session_initialized') {
      sessionInitialized = parsed as unknown as SessionInitializedRecord;
      continue;
    }
    const normalized = normalizeRecord(
      parsed,
      seq,
      currentTurnId,
      nextTurnIndex,
      rawRecords,
      recordIndex,
    );
    records.push(...normalized.records);
    if (normalized.currentTurnId !== undefined) currentTurnId = normalized.currentTurnId;
    if (normalized.nextTurnIndex !== undefined) nextTurnIndex = normalized.nextTurnIndex;
  }

  const out: ReplayWireResult = {
    health: warnings.length === 0 ? 'ok' : 'broken',
    warnings,
    metadata,
    sessionInitialized,
    records,
  };
  if (warnings.length > 0) out.brokenReason = warnings[0];
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RawWireRecord {
  seq: number;
  raw: Record<string, unknown>;
}

interface NormalizeResult {
  records: VisWireRecord[];
  currentTurnId?: string;
  nextTurnIndex?: number;
}

function normalizeRecord(
  raw: Record<string, unknown>,
  fallbackSeq: number,
  currentTurnId: string,
  nextTurnIndex: number,
  rawRecords: readonly RawWireRecord[],
  recordIndex: number,
): NormalizeResult {
  const seq = numberValue(raw['seq']) ?? fallbackSeq;
  const time = numberValue(raw['time']) ?? 0;
  const type = stringValue(raw['type']) ?? 'unknown';

  switch (type) {
    case 'turn.prompt':
      return normalizeTurnStart(raw, seq, time, nextTurnIndex);

    case 'turn.steer': {
      const turnId = inferSteerStartedTurnId(rawRecords, recordIndex, currentTurnId, nextTurnIndex);
      if (turnId === undefined) return { records: [] };
      return normalizeTurnStart(raw, seq, time, nextTurnIndex, turnId);
    }

    case 'context.user_message':
    case 'context.append_message': {
      // `context.append_message` (newer producer) nests `{role, content}`
      // under a `message` field; `context.user_message` (older) puts
      // `content` at the top level. Only surface user-authored messages —
      // assistant messages are already represented by content.part events
      // inside loop events.
      if (!isUserAuthoredAppendMessage(raw)) {
        return { records: [notificationFromRaw(raw, seq, time)] };
      }
      const message = isRecord(raw['message']) ? raw['message'] : undefined;
      const rawContent = message !== undefined ? message['content'] : raw['content'];
      const content = Array.isArray(rawContent)
        ? (rawContent as readonly UserInputPart[])
        : (stringValue(rawContent) ?? '');
      const record: UserMessageRecord = {
        type: 'user_message',
        seq,
        time,
        turn_id: currentTurnId,
        content,
      };
      return { records: [record] };
    }

    case 'context.delta':
    case 'context.append_loop_event': {
      const event = raw['event'];
      if (!isRecord(event)) return { records: [notificationFromRaw(raw, seq, time)] };
      const eventTurnId = stringValue(event['turnId']);
      const records = normalizeLoopEvent(event, seq, time, currentTurnId);
      return {
        records,
        currentTurnId: eventTurnId,
      };
    }

    case 'config.update': {
      const prompt = stringValue(raw['systemPrompt']);
      if (prompt !== undefined) {
        const record: SystemPromptChangedRecord = {
          type: 'system_prompt_changed',
          seq,
          time,
          new_prompt: prompt,
        };
        return { records: [record] };
      }
      return { records: [notificationFromRaw(raw, seq, time)] };
    }

    case 'tool.set_active':
    case 'tools.set_active_tools': {
      const names = Array.isArray(raw['names'])
        ? raw['names'].filter((name): name is string => typeof name === 'string')
        : [];
      const record: ToolsChangedRecord = {
        type: 'tools_changed',
        seq,
        time,
        operation: 'set_active',
        tools: names,
      };
      return { records: [record] };
    }

    case 'context.system_reminder': {
      const record: SystemReminderRecord = {
        type: 'system_reminder',
        seq,
        time,
        content: stringValue(raw['content']) ?? '',
      };
      return { records: [record] };
    }

    case 'context.clear':
      return { records: [{ type: 'context_cleared', seq, time }] };

    case 'context.mark_last_user_prompt_blocked':
      return { records: [] };

    default:
      return {
        records: [
          hasLegacyShape(raw)
            ? (raw as unknown as VisWireRecord)
            : notificationFromRaw(raw, seq, time),
        ],
      };
  }
}

function normalizeTurnStart(
  raw: Record<string, unknown>,
  seq: number,
  time: number,
  nextTurnIndex: number,
  turnId = String(nextTurnIndex),
): NormalizeResult {
  const input = Array.isArray(raw['input']) ? (raw['input'] as readonly UserInputPart[]) : [];
  const record: TurnBeginRecord = {
    type: 'turn_begin',
    seq,
    time,
    turn_id: turnId,
    agent_type: 'main',
    input_kind: 'user',
    user_input: inputToText(input),
  };
  return {
    records: [record],
    currentTurnId: turnId,
    nextTurnIndex: nextTurnIndexAfter(turnId, nextTurnIndex),
  };
}

function inferSteerStartedTurnId(
  rawRecords: readonly RawWireRecord[],
  recordIndex: number,
  currentTurnId: string,
  nextTurnIndex: number,
): string | undefined {
  let sawUserMessage = false;

  // Wire does not persist turn.ended, so past records cannot prove whether
  // core still had an active turn. The next explicit loop turnId is the durable
  // signal for whether this steer stayed buffered or launched a fresh turn.
  for (let index = recordIndex + 1; index < rawRecords.length; index += 1) {
    const raw = rawRecords[index]?.raw;
    if (raw === undefined) continue;

    const type = stringValue(raw['type']);
    if (type === 'turn.prompt' || type === 'turn.steer') break;
    if (type === 'context.user_message' || type === 'context.append_message') {
      // Only an actual user message should count as evidence that the
      // steer launched a fresh turn. The newer `context.append_message`
      // producer carries assistant / system roles too, and
      // `ContextMemory.appendSystemReminder()` persists injected
      // reminders with role: 'user' but a non-user origin — both of
      // those would fabricate a fresh turn ID below and mis-tag
      // subsequent records.
      if (isUserAuthoredAppendMessage(raw)) {
        sawUserMessage = true;
      }
      continue;
    }
    if (type !== 'context.delta' && type !== 'context.append_loop_event') continue;

    const event = raw['event'];
    if (!isRecord(event)) continue;

    const eventTurnId = stringValue(event['turnId']);
    if (eventTurnId === undefined) continue;
    return eventTurnId === currentTurnId ? undefined : eventTurnId;
  }

  return sawUserMessage ? String(nextTurnIndex) : undefined;
}

// Distinguishes real user input from non-user content that shares the
// `role: 'user'` slot for the LLM (system reminders, skill activation
// payloads, injection content, compaction summaries). The older
// `context.user_message` shape has no `origin`, so absence is treated
// as user authorship to preserve back-compat with older wire logs.
function isUserAuthoredAppendMessage(raw: Record<string, unknown>): boolean {
  const message = isRecord(raw['message']) ? raw['message'] : undefined;
  const role = stringValue(message?.['role']) ?? stringValue(raw['role']);
  if (role !== undefined && role !== 'user') return false;
  const origin = isRecord(message?.['origin']) ? message['origin'] : undefined;
  const originKind = stringValue(origin?.['kind']);
  if (originKind !== undefined && originKind !== 'user') return false;
  return true;
}

function nextTurnIndexAfter(turnId: string, nextTurnIndex: number): number {
  const parsed = Number.parseInt(turnId, 10);
  if (String(parsed) === turnId && parsed >= nextTurnIndex) return parsed + 1;
  return nextTurnIndex + 1;
}

function normalizeLoopEvent(
  event: Record<string, unknown>,
  seq: number,
  time: number,
  currentTurnId: string,
): VisWireRecord[] {
  const eventType = stringValue(event['type']);
  const turnId = stringValue(event['turnId']) ?? currentTurnId;

  switch (eventType) {
    case undefined:
      return [notificationFromRaw({ type: 'context.delta', event }, seq, time)];

    case 'step.begin': {
      const record: StepBeginRecord = {
        type: 'step_begin',
        seq,
        time,
        uuid: stringValue(event['uuid']) ?? `step_${seq}`,
        turn_id: turnId,
        step: numberValue(event['step']) ?? 0,
      };
      return [record];
    }

    case 'content.part': {
      const rawPart = isRecord(event['part']) ? event['part'] : {};
      const kind = rawPart['type'] === 'think' || rawPart['kind'] === 'think' ? 'think' : 'text';
      const record: ContentPartRecord = {
        type: 'content_part',
        seq,
        time,
        uuid: stringValue(event['uuid']) ?? `part_${seq}`,
        turn_id: turnId,
        step: numberValue(event['step']) ?? 0,
        step_uuid: stringValue(event['stepUuid']) ?? '',
        role: 'assistant',
        part:
          kind === 'think'
            ? { kind, think: stringValue(rawPart['think']) ?? '' }
            : { kind, text: stringValue(rawPart['text']) ?? '' },
      };
      return [record];
    }

    case 'tool.call': {
      const record: ToolCallRecord = {
        type: 'tool_call',
        seq,
        time,
        uuid: stringValue(event['uuid']) ?? `tool_${seq}`,
        turn_id: turnId,
        step: numberValue(event['step']) ?? 0,
        step_uuid: stringValue(event['stepUuid']) ?? '',
        data: {
          tool_call_id: stringValue(event['toolCallId']) ?? `tool_${seq}`,
          tool_name: stringValue(event['name']) ?? 'unknown',
          args: event['args'],
          description: stringValue(event['description']),
          display: event['display'],
        },
      };
      return [record];
    }

    case 'tool.result': {
      const result = isRecord(event['result']) ? event['result'] : {};
      const record: ToolResultRecord = {
        type: 'tool_result',
        seq,
        time,
        turn_id: turnId,
        tool_call_id: stringValue(event['toolCallId']) ?? `tool_${seq}`,
        output: result['output'],
        is_error: result['isError'] === true,
        parent_uuid: stringValue(event['parentUuid']),
      };
      return [record];
    }

    case 'step.end': {
      const record: StepEndRecord = {
        type: 'step_end',
        seq,
        time,
        uuid: stringValue(event['uuid']) ?? `step_${seq}`,
        turn_id: turnId,
        step: numberValue(event['step']) ?? 0,
        usage: normalizeUsage(event['usage']),
        finish_reason: stringValue(event['finishReason']),
      };
      return [record];
    }

    default:
      return [notificationFromRaw({ type: 'context.delta', event }, seq, time)];
  }
}

function notificationFromRaw(
  raw: Record<string, unknown>,
  seq: number,
  time: number,
): NotificationRecord {
  const type = stringValue(raw['type']) ?? 'unknown';
  return {
    type: 'notification',
    seq,
    time,
    data: {
      id: `${seq}:${type}`,
      category: 'system',
      type,
      source_kind: 'wire',
      source_id: 'vis',
      title: type,
      body: stringify(raw),
      severity: 'info',
      payload: raw,
      targets: ['wire'],
    },
  };
}

function hasLegacyShape(raw: Record<string, unknown>): boolean {
  const type = stringValue(raw['type']);
  return (
    type !== undefined &&
    !type.includes('.') &&
    typeof raw['seq'] === 'number' &&
    typeof raw['time'] === 'number'
  );
}

function normalizeUsage(value: unknown): StepEndRecord['usage'] {
  if (!isRecord(value)) return undefined;
  return {
    input_tokens:
      numberValue(value['input_tokens']) ??
      numberValue(value['input']) ??
      numberValue(value['inputOther']) ??
      0,
    output_tokens: numberValue(value['output_tokens']) ?? numberValue(value['output']) ?? 0,
    cache_read_tokens:
      numberValue(value['cache_read_tokens']) ??
      numberValue(value['cache_read']) ??
      numberValue(value['inputCacheRead']),
    cache_write_tokens:
      numberValue(value['cache_write_tokens']) ??
      numberValue(value['cache_write']) ??
      numberValue(value['inputCacheCreation']),
  };
}

function inputToText(input: readonly UserInputPart[]): string {
  return input
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image_url') return '<image>';
      return '<video>';
    })
    .join('');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
