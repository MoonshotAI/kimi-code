import type { Message } from '#/llm-adapter/contract/message';
import type { ContextMessageTiming, PromptOrigin } from '#/agent/contextMemory/types';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type { TokenUsage } from '#human/llm-requester/usage';

import { WIRE_PROTOCOL_VERSION } from './migration/migration';

export type PersistentContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly toolCallDisplays?: Record<string, ToolInputDisplay>;
  readonly note?: string;
  readonly usage?: TokenUsage;
  readonly llmTiming?: ContextMessageTiming;
  readonly durationMs?: number;
};

export const AGENT_WIRE_RECORD_KEY = 'wire.jsonl';

export type PartsTransformer = (parts: readonly unknown[]) => Promise<readonly unknown[]>;

export type RecordDehydrator = (
  record: WireRecord,
  transform: PartsTransformer,
) => WireRecord | Promise<WireRecord>;

export interface WireLineRange {
  readonly start: number;
  readonly end: number;
}

export interface WireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export interface WireMetadataRecord extends WireRecord {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
}

export function isWireRecord(record: unknown): record is WireRecord {
  return (
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof (record as { type?: unknown }).type === 'string'
  );
}

export function createWireMetadataRecord(now = Date.now()): WireMetadataRecord {
  return {
    type: 'metadata',
    protocol_version: WIRE_PROTOCOL_VERSION,
    created_at: now,
  };
}

export function isWireMetadataRecord(record: WireRecord): record is WireMetadataRecord {
  return (
    record.type === 'metadata' &&
    typeof record['protocol_version'] === 'string' &&
    typeof record['created_at'] === 'number'
  );
}
