import {
  migrateWireJournalRecords,
  reduceContextTranscript,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import { normalizeAnchorLength } from '@moonshot-ai/agent-core-v2/agent/tokenCounting/tokenCountingOps';
import { estimateTokensForMessages } from '@moonshot-ai/agent-core-v2/llm-adapter/contract/tokens';

interface ColdTokenAnchor {
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

const TOKEN_RECORD_TYPES = new Set([
  'token_counting.measured',
  'token_counting.truncated',
  'token_counting.rebased',
  'token_counting.turn_recorded',
]);

export function readColdTokenUsage(records: readonly WireRecord[]): number | undefined {
  if (!records.some((record) => TOKEN_RECORD_TYPES.has(record.type))) return undefined;
  let anchors: ColdTokenAnchor[] = [];
  for (const record of records) {
    if (!TOKEN_RECORD_TYPES.has(record.type)) continue;
    const length = normalizeAnchorLength(numberValue(record['length']));
    const tokens = Math.max(0, numberValue(record['tokens']));
    switch (record.type) {
      case 'token_counting.measured':
        anchors = [...anchors.filter((anchor) => anchor.length < length), { length, tokens, measured: true }];
        break;
      case 'token_counting.truncated':
        anchors = anchors.filter((anchor) => anchor.length <= length);
        break;
      case 'token_counting.rebased':
        anchors = [{ length, tokens, measured: record['measured'] === true }];
        break;
      case 'token_counting.turn_recorded':
        if (!anchors.some((anchor) => anchor.length === length)) {
          anchors = [...anchors.filter((anchor) => anchor.length < length), { length, tokens, measured: false }];
        }
        break;
      default:
        break;
    }
  }

  const context = reduceContextTranscript(migrateWireJournalRecords(records)).entries;
  const anchor = [...anchors].toReversed().find((candidate) => candidate.length <= context.length) ?? {
    length: 0,
    tokens: 0,
    measured: true,
  };
  const measured = [...anchors].toReversed().find((candidate) => candidate.measured)?.tokens ?? 0;
  const size = anchor.tokens + estimateTokensForMessages(context.slice(anchor.length));
  return Math.max(size, measured);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
