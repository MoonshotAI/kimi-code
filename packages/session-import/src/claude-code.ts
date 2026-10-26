import { readJsonLines as sourceLines } from '#/jsonl';
import { createImageStore } from '#/images';
import type { EffectiveHistory, HistoryStep, HistoryTurn, ReadOptions } from '#/types';
import type { BigIntStats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

interface SourceBlock extends Record<string, unknown> {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: unknown;
  input?: unknown;
  content?: string | SourceBlock[];
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  source?: Record<string, unknown>;
}

interface SourceMessage extends Record<string, unknown> {
  content?: string | SourceBlock[];
  model?: string;
}

interface Preservation extends Record<string, unknown> {
  uuid?: string;
  message?: SourceMessage;
  headUuid?: string;
  tailUuid?: string;
  startUuid?: string;
  endUuid?: string;
  firstUuid?: string;
  lastUuid?: string;
}

interface SourceRecord extends Record<string, unknown> {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  logicalParentUuid?: string;
  isSidechain?: boolean;
  sessionId?: string;
  leafUuid?: string;
  sourceToolAssistantUUID?: string;
  isCompactSummary?: boolean;
  isSummary?: boolean;
  message?: SourceMessage;
  content?: unknown;
  rendered?: string | SourceBlock[];
  toolUseResult?: Record<string, unknown>;
  preservedMessages?: unknown;
  preservedSegment?: unknown;
  compactMetadata?: { preservedMessages?: unknown; preservedSegment?: unknown };
  summary?: string;
  timestamp?: string;
  isApiErrorMessage?: boolean;
  error?: unknown;
  attachment?: { type?: string; text?: string; content?: unknown; prompt?: unknown; origin?: { kind?: unknown } };
  cwd?: string;
  isMeta?: boolean;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  title?: string;
  version?: string;
  gitBranch?: string;
  permissionMode?: string;
}

interface Entry {
  row: SourceRecord;
  order: number;
  line: number;
  embedded?: boolean;
  supplemented?: boolean;
  excludedContentIndices?: Set<number>;
  sourceUserText?: string;
}

interface ReaderStats extends Record<string, unknown> {
  sourceLines: number;
  parsedRecords: number;
  blankLines: number;
  invalidJsonLines: number;
  invalidRecords: number;
  duplicateUuidRecords: number;
  sidechainRecords: number;
  selectedChainRecords: number;
  excludedOffBranchRecords: number;
  excludedBeforeCompactionRecords: number;
  preservedRecords: number;
  unresolvedPreservedReferences: number;
  unresolvedParentReferences: number;
  chainCycles: number;
  supplementedToolResults: number;
  rejectedOffBranchToolResults: number;
  textThinkingBlocks: number;
  textlessThinkingBlocks: number;
  signatureBlocks: number;
  encryptedOrRedactedBlocks: number;
  imageBlocks: number;
  documentBlocks: number;
  nonTextPayloadBytes: number;
  metadataBinaryPayloads: number;
  metadataBinaryPayloadBytes: number;
  unknownBlocks: number;
  unknownRecords: number;
  missingCompactionSummaries: number;
  contentlessMessages: number;
  toolCalls: number;
  toolResults: number;
  interruptionEvents: number;
  omittedReadResults: number;
  omittedReadChars: number;
  unmatchedToolCalls: number;
  unmatchedToolResults: number;
  turns: number;
  invalidJsonLineNumbers: number[];
  sourceRecordTypes: Record<string, number>;
  selectedRecordTypes: Record<string, number>;
  blockTypes: Record<string, number>;
  imageReferences?: ReturnType<Awaited<ReturnType<typeof createImageStore>>['report']>;
}

const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'progress']);
const METADATA_TYPES = new Set(['summary', 'mode', 'permission-mode', 'atis-latch', 'file-history-snapshot', 'last-prompt', 'ai-title', 'queue-operation', 'cost-state', 'file-history-delta', 'pr-link', 'frame-link', 'custom-title', 'agent-name', 'continued-in', 'agent-setting', 'artifact-comment-monitor', 'artifact-autoreact-ledger']);
const REQUEST_LOG_TYPES = new Set(['api-request', 'api-request-blob', 'api-request-shape']);

export function isRequestLogLine(line: Buffer): boolean {
  if (!line.includes('"type":"api-request')) return false;
  try {
    const type = (JSON.parse(line.toString('utf8')) as { type?: unknown } | null)?.type;
    return typeof type === 'string' && REQUEST_LOG_TYPES.has(type);
  } catch {
    return false;
  }
}
const isChainRecord = (row: SourceRecord) => CHAIN_TYPES.has(row.type ?? '') || (!METADATA_TYPES.has(row.type ?? '') && Boolean(row.parentUuid ?? row.logicalParentUuid));
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'tool_result', 'image', 'document']);
const textOf = (value: unknown): string => typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);
const blocksOf = (row: SourceRecord): SourceBlock[] => Array.isArray(row.message?.content) ? row.message.content : [];
const isBoundary = (row: SourceRecord) => row.type === 'system' && row.subtype === 'compact_boundary';
const isSummary = (row: SourceRecord) => row.isCompactSummary === true;
const count = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };
const unique = <T>(values: (T | undefined | null)[]) => [...new Set(values.filter((value) => value !== undefined && value !== null))];

function recordMetadata(entry: Entry, block?: SourceBlock) {
  const { message, content: _content, rendered: _rendered, toolUseResult: _toolUseResult, ...record } = entry.row;
  const { content: _messageContent, ...messageMetadata } = message ?? {};
  const { text: _text, thinking: _thinking, input: _input, content: _blockContent, signature: _signature, data: _data, ...blockMetadata } = block ?? {};
  return { sourceLine: entry.line, sourceUuid: entry.row.uuid, record, message: message ? messageMetadata : undefined, block: block ? blockMetadata : undefined };
}

function preservationMetadata(row: SourceRecord): SourceRecord {
  const reference = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reference);
    if (!value || typeof value !== 'object') return value;
    if ('uuid' in value && 'message' in value && value.uuid && value.message) return { uuid: value.uuid };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)]));
  };
  const copy = { ...row };
  for (const key of ['preservedMessages', 'preservedSegment', 'compactMetadata']) {
    if (copy[key]) copy[key] = reference(copy[key]);
  }
  return copy;
}

function toolResultMetadata(value: unknown, text: string, stats: ReaderStats) {
  const omittedDuplicatePayloadPaths: string[] = [];
  const omittedBinaryPayloadPaths: string[] = [];
  const payloadKeys = new Set(['stdout', 'stderr', 'output', 'content', 'text']);
  const visit = (current: unknown, path = 'toolUseResult'): unknown => {
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
    if (!current || typeof current !== 'object') return current;
    return Object.fromEntries(Object.entries(current).flatMap(([key, item]) => {
      if (typeof item === 'string' && (key === 'base64' || (key === 'data' && 'type' in current && current.type === 'base64'))) {
        omittedBinaryPayloadPaths.push(`${path}.${key}`);
        stats.metadataBinaryPayloads++;
        stats.metadataBinaryPayloadBytes += Buffer.byteLength(item);
        return [];
      }
      if (payloadKeys.has(key) && typeof item === 'string' && item === text) {
        omittedDuplicatePayloadPaths.push(`${path}.${key}`);
        return [];
      }
      return [[key, visit(item, `${path}.${key}`)]];
    }));
  };
  const toolUseResult = typeof value === 'string' && value === text ? undefined : visit(value);
  if (typeof value === 'string' && value === text) omittedDuplicatePayloadPaths.push('toolUseResult');
  return { toolUseResult, omittedDuplicatePayloadPaths, omittedBinaryPayloadPaths };
}

function indexRow(row: SourceRecord): SourceRecord {
  const keys = ['type', 'subtype', 'uuid', 'parentUuid', 'logicalParentUuid', 'isSidechain', 'sessionId', 'leafUuid', 'sourceToolAssistantUUID', 'isCompactSummary', 'isSummary'];
  const index: SourceRecord = Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  if (row.message) index.message = { content: blocksOf(row).map((block) => ({ type: block?.type, id: block?.id, tool_use_id: block?.tool_use_id })) };
  const lean = (value: unknown): unknown => Array.isArray(value) ? value.map(lean) : value && typeof value === 'object' && 'message' in value ? { ...indexRow(value as SourceRecord), message: { content: [] } } : value;
  for (const key of ['preservedMessages', 'preservedSegment']) if (row[key]) index[key] = lean(row[key]);
  if (row.compactMetadata) index.compactMetadata = { preservedMessages: lean(row.compactMetadata.preservedMessages), preservedSegment: lean(row.compactMetadata.preservedSegment) };
  return index;
}

async function assertUnchanged(path: string, before: BigIntStats) {
  const after = await stat(path, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) {
    const error = Object.assign(new Error('Source session changed while reading; retry after the source is stable.'), { code: 'SOURCE_CHANGED' });
    throw error;
  }
}

async function hydrate(path: string, selected: Entry[], globals: Entry[]) {
  const wanted = new Set([...selected, ...globals].map((entry) => entry.line));
  const records = new Map<number, SourceRecord>();
  let line = 0;
  for await (const source of sourceLines(path)) {
    line++;
    if (wanted.has(line)) records.set(line, JSON.parse(source));
  }
  for (const entry of [...selected, ...globals]) {
    const source = records.get(entry.line);
    if (!source) throw Object.assign(new Error('Source session changed while reading.'), { code: 'SOURCE_CHANGED' });
    if (entry.embedded) {
      const visit = (value: unknown): SourceRecord | undefined => {
        if (!value || typeof value !== 'object') return undefined;
        if ('uuid' in value && value.uuid === entry.row.uuid && 'message' in value && value.message) return value as SourceRecord;
        return Object.values(value).map(visit).find(Boolean);
      };
      entry.row = visit(source) ?? entry.row;
    } else if (entry.supplemented) {
      const ids = new Set(blocksOf(entry.row).map((block) => block.tool_use_id));
      entry.excludedContentIndices = new Set(blocksOf(source).flatMap((block, index) => block?.type === 'tool_result' && !ids.has(block.tool_use_id) ? [index] : []));
      entry.row = { ...source, message: { ...source.message, content: blocksOf(source).map((block, index) => entry.excludedContentIndices?.has(index) ? null : block) as SourceBlock[] } };
    } else entry.row = source;
  }
}

function references(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(references);
  if (!value || typeof value !== 'object') return [];
  if ('uuid' in value && typeof value.uuid === 'string') return [value.uuid];
  return ['headUuid', 'tailUuid', 'startUuid', 'endUuid', 'firstUuid', 'lastUuid', 'messageUuids', 'messages', 'uuids', 'allUuids'].flatMap((key) => references((value as Record<string, unknown>)[key]));
}

function preservedValues(row: SourceRecord) {
  return [row.preservedMessages, row.preservedSegment, row.compactMetadata?.preservedMessages, row.compactMetadata?.preservedSegment].filter(Boolean);
}

function summaryText(row: SourceRecord) {
  if (typeof row.summary === 'string') return row.summary;
  if (!isSummary(row)) return undefined;
  if (typeof row.message?.content === 'string') return row.message.content;
  if (typeof row.content === 'string') return row.content;
  const texts = blocksOf(row).filter((block) => block?.type === 'text').map((block) => block.text ?? '');
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function selectHistory(entries: Entry[], stats: ReaderStats) {
  const versions = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.row.uuid) continue;
    const list = versions.get(entry.row.uuid) ?? [];
    if (list.length > 0) stats.duplicateUuidRecords++;
    list.push(entry);
    versions.set(entry.row.uuid, list);
  }
  const sidechainMode = !entries.some(({ row }) => row.uuid && !row.isSidechain && isChainRecord(row));
  const eligible = (row: SourceRecord) => sidechainMode || !row.isSidechain;
  const find = (id: string | undefined, before = Infinity): Entry | undefined => versions.get(id ?? '')?.findLast((entry) => entry.order < before && eligible(entry.row));
  const findLater = (id: string | undefined, after: number): Entry | undefined => versions.get(id ?? '')?.find((entry) => entry.order > after && eligible(entry.row));
  const chainRecords = entries.filter(({ row }) => row.uuid && eligible(row) && isChainRecord(row));
  const parents = new Set(chainRecords.flatMap(({ row }) => [row.parentUuid, row.logicalParentUuid]));
  const leaf = chainRecords.findLast(({ row }) => !parents.has(row.uuid)) ?? chainRecords.at(-1);
  if (!leaf) return { selected: [], boundary: undefined, leaf: undefined, find, sidechainMode };
  const selected = new Map<string | undefined, Entry>();
  const traversed = new Set<number>();
  let current: Entry | undefined = leaf;
  let boundary: Entry | undefined;
  let laterParentOffset = 1;
  while (current) {
    if (traversed.has(current.line)) { stats.chainCycles++; break; }
    traversed.add(current.line);
    selected.set(current.row.uuid, current);
    if (isBoundary(current.row)) { boundary = current; break; }
    const parent: string | undefined = current.row.logicalParentUuid ?? current.row.parentUuid;
    if (!parent) break;
    const earlier: Entry | undefined = find(parent, current.order) ?? find(current.row.parentUuid, current.order);
    if (earlier) {
      laterParentOffset = 1;
      current = earlier;
      continue;
    }
    const later: Entry | undefined = findLater(parent, current.order) ?? findLater(current.row.parentUuid, current.order);
    if (!later) { stats.unresolvedParentReferences++; break; }
    laterParentOffset /= 2;
    current = { ...later, order: current.order - laterParentOffset };
  }

  // Some compact writers retain the segment's original parents and record its
  // new logical placement only on the summary/boundary.
  if (!boundary) {
    const candidate = entries.findLast((entry) => isBoundary(entry.row) && entry.order <= leaf.order && eligible(entry.row));
    if (candidate) {
      const summaries = entries.filter((entry) => entry.order > candidate.order && entry.order <= leaf.order && isSummary(entry.row));
      const linkedSummary = summaries.findLast((entry) => selected.has(entry.row.uuid));
      if (linkedSummary) {
        boundary = candidate;
        selected.set(candidate.row.uuid, candidate);
      }
    }
  }

  const preservation = new Map<string | undefined, Entry>();
  const selectedBoundary = boundary;
  if (selectedBoundary) {
    const summaries = [...selected.values()].filter((entry) => isSummary(entry.row) && entry.order >= selectedBoundary.order);
    const owners = [selectedBoundary, ...summaries];
    const explicitIds = new Set(owners.flatMap(({ row }) => preservedValues(row).flatMap(references)));
    for (const owner of owners) {
      const listed = references(owner.row.preservedMessages ?? owner.row.compactMetadata?.preservedMessages);
      for (const value of preservedValues(owner.row)) {
        const segments = (Array.isArray(value) ? value : [value]) as (Preservation | string)[];
        for (const item of segments) {
          const segment = typeof item === 'string' ? undefined : item;
          if (segment?.message && segment.uuid && !versions.has(segment.uuid)) {
            preservation.set(segment.uuid, { row: segment as SourceRecord, order: selectedBoundary.order - 0.5 + preservation.size / 100000, line: owner.line, embedded: true });
          }
          const head = segment?.headUuid ?? segment?.startUuid ?? segment?.firstUuid;
          const tail = segment?.tailUuid ?? segment?.endUuid ?? segment?.lastUuid;
          const preferred = (id: string | undefined): Entry | undefined => {
            const active = selected.get(id);
            return active && active.order > selectedBoundary.order ? active : find(id, selectedBoundary.order) ?? active;
          };
          if (head && tail) {
            if (listed.length > 0) continue;
            let entry = preferred(tail);
            const visited = new Set();
            const segmentEntries = [];
            let reachedHead = false;
            while (entry && !visited.has(entry.order)) {
              visited.add(entry.order);
              segmentEntries.push(entry);
              if (entry.row.uuid === head) { reachedHead = true; break; }
              entry = find(entry.row.parentUuid, entry.order);
            }
            if (reachedHead) {
              for (const item of segmentEntries) preservation.set(item.row.uuid, preferred(item.row.uuid) ?? item);
            } else stats.unresolvedPreservedReferences++;
          } else {
            for (const id of references(item)) {
              const entry = preferred(id);
              if (entry && !isBoundary(entry.row) && !isSummary(entry.row)) preservation.set(id, entry);
              else if (!preservation.has(id)) stats.unresolvedPreservedReferences++;
            }
          }
        }
      }
    }
    for (const [id, entry] of selected) {
      if (entry.order < selectedBoundary.order && !preservation.has(id) && !explicitIds.has(id ?? '')) selected.delete(id);
    }
    for (const [id, entry] of preservation) selected.set(id, entry);
    stats.preservedRecords = preservation.size;
  }

  const selectedCalls = new Map<string | undefined, Entry[]>();
  for (const entry of selected.values()) {
    for (const block of blocksOf(entry.row)) {
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        const list = selectedCalls.get(block.id) ?? [];
        list.push(entry);
        selectedCalls.set(block.id, list);
      }
    }
  }
  const selectedResultKeys = new Set([...selected.values()].flatMap((entry) => blocksOf(entry.row).filter((block) => block?.type === 'tool_result').map((block) => block.tool_use_id)));
  for (const entry of entries) {
    const row = entry.row;
    if (!row.uuid || !eligible(row) || selected.has(row.uuid) || entry.order > leaf.order) continue;
    const resultBlocks = blocksOf(row).filter((block) => block?.type === 'tool_result');
    if (resultBlocks.length === 0) continue;
    const isAssociatedResult = (block: SourceBlock): boolean => {
      if (selectedResultKeys.has(block.tool_use_id)) return false;
      const calls = selectedCalls.get(block.tool_use_id) ?? [];
      for (const call of calls) {
        if (call.order >= entry.order) continue;
        if (selectedBoundary && entry.order < selectedBoundary.order && !preservation.has(call.row.uuid)) continue;
        if (row.sourceToolAssistantUUID && row.sourceToolAssistantUUID !== call.row.uuid) continue;
        const owner = row.sourceToolAssistantUUID ? find(row.sourceToolAssistantUUID, entry.order) : undefined;
        if (owner && owner.order !== call.order) continue;
        let ancestor = find(row.parentUuid, entry.order);
        const seen = new Set();
        while (ancestor && !seen.has(ancestor.order)) {
          seen.add(ancestor.order);
          if (ancestor.order === call.order) return true;
          if (ancestor.row.type === 'user' && !blocksOf(ancestor.row).some((b) => b?.type === 'tool_result')) break;
          if (ancestor.row.type === 'assistant' && !selected.has(ancestor.row.uuid)) break;
          ancestor = find(ancestor.row.parentUuid, ancestor.order);
        }
      }
      return false;
    };
    const matching = resultBlocks.filter(isAssociatedResult);
    if (matching.length === 0) { stats.rejectedOffBranchToolResults += resultBlocks.length; continue; }
    const matchedIds = new Set(matching.map((block) => block.tool_use_id));
    const content = blocksOf(row).filter((block) => block?.type !== 'tool_result' || matchedIds.has(block.tool_use_id));
    const copy = { ...entry, row: { ...row, message: { ...row.message, content } }, supplemented: true };
    selected.set(row.uuid, copy);
    if (selectedBoundary && entry.order < selectedBoundary.order) preservation.set(row.uuid, copy);
    for (const block of matching) selectedResultKeys.add(block.tool_use_id);
    stats.supplementedToolResults += matching.length;
  }

  let ordered = [...selected.values()].toSorted((a, b) => a.order - b.order);
  if (selectedBoundary && preservation.size > 0) {
    const pre = ordered.filter((entry) => preservation.has(entry.row.uuid) && entry.order < selectedBoundary.order);
    const post = ordered.filter((entry) => !preservation.has(entry.row.uuid) || entry.order >= selectedBoundary.order);
    const summaryIndex = post.findLastIndex((entry) => isSummary(entry.row));
    const insertAt = summaryIndex < 0 ? 1 : summaryIndex + 1;
    ordered = [...post.slice(0, insertAt), ...pre, ...post.slice(insertAt)];
  }
  stats.selectedChainRecords = ordered.length;
  stats.excludedOffBranchRecords = entries.filter((entry) => entry.row.uuid && !entry.row.isSidechain && !selected.has(entry.row.uuid) && (!selectedBoundary || entry.order >= selectedBoundary.order)).length;
  stats.excludedBeforeCompactionRecords = selectedBoundary ? entries.filter((entry) => entry.row.uuid && entry.order < selectedBoundary.order && !selected.has(entry.row.uuid)).length : 0;
  return { selected: ordered, boundary, leaf, find, sidechainMode };
}

function makeSteps(entry: Entry, stats: ReaderStats): HistoryStep[] {
  const row = entry.row;
  const timestamp = row.timestamp;
  const result: HistoryStep[] = [];
  const add = (kind: HistoryStep['kind'], text: string, block?: SourceBlock, extra: Partial<HistoryStep> = {}) => result.push({ kind, text, timestamp, metadata: recordMetadata(entry, block), ...extra });
  const content = row.message?.content;
  if (typeof content === 'string') {
    add(row.type === 'assistant' ? (row.isApiErrorMessage || row.message?.model === '<synthetic>' ? 'error' : 'assistant') : 'event', content);
    return result;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) stats.contentlessMessages++;
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        stats.unknownBlocks++;
        add('event', textOf(block));
        continue;
      }
      count(stats.blockTypes, block.type ?? '<missing>');
      if (!KNOWN_BLOCKS.has(block.type ?? '')) stats.unknownBlocks++;
      if (block.signature) stats.signatureBlocks++;
      if (block.type === 'redacted_thinking' && block.data) stats.encryptedOrRedactedBlocks++;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const thinking = block.thinking ?? block.text ?? '';
        if (typeof thinking === 'string' && thinking.length > 0) { stats.textThinkingBlocks++; add('thinking', thinking, block); }
        else { stats.textlessThinkingBlocks++; add('event', `[${block.type}: no text recorded]`, block); }
      } else if (block.type === 'text') {
        add(row.type === 'assistant' ? (row.isApiErrorMessage || row.message?.model === '<synthetic>' ? 'error' : 'assistant') : 'event', textOf(block.text), block);
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        stats.toolCalls++;
        add('tool_call', textOf(block.input), block, { name: block.name, callId: block.id });
      } else if (block.type === 'tool_result') {
        stats.toolResults++;
        const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content }];
        const texts = parts.map((part) => {
          if (part?.type === 'text') return textOf(part.text);
          if (part?.type === 'image' || part?.type === 'document') {
            stats[part.type === 'image' ? 'imageBlocks' : 'documentBlocks']++;
            stats.nonTextPayloadBytes += Buffer.byteLength(textOf(part));
            return `[${part.type}: non-text payload omitted]`;
          }
          stats.unknownBlocks++;
          return textOf(part);
        });
        add('tool_result', texts.join('\n'), { ...block, content: undefined }, { callId: block.tool_use_id, metadata: { ...recordMetadata(entry, { ...block, content: undefined }), ...toolResultMetadata(row.toolUseResult, texts.join('\n'), stats), isError: block.is_error, exitCode: row.toolUseResult?.['exitCode'] ?? row.toolUseResult?.['exit_code'] ?? row.toolUseResult?.['code'], supplemented: entry.supplemented ?? false } });
      } else if (block.type === 'image' || block.type === 'document') {
        stats[block.type === 'image' ? 'imageBlocks' : 'documentBlocks']++;
        stats.nonTextPayloadBytes += Buffer.byteLength(textOf(block));
        add('event', `[${block.type}: non-text payload omitted]`, { ...block, source: block.source ? { ...block.source, data: undefined } : undefined });
      } else {
        add('event', textOf(block));
      }
    }
    return result;
  }
  const rendered = row.rendered;
  const visible = typeof rendered === 'string' ? rendered : Array.isArray(rendered) ? rendered.map((part) => part?.text ?? textOf(part)).join('\n') : undefined;
  const eventText = visible ?? (typeof row.content === 'string' ? row.content : row.attachment?.text ?? row.attachment?.content ?? row.summary);
  const kind = row.type === 'system' && (row.subtype === 'api_error' || row.error) ? 'error' : 'event';
  if (eventText === undefined) add(kind, textOf(row), undefined, { metadata: { sourceLine: entry.line, sourceUuid: row.uuid } });
  else add(kind, textOf(eventText));
  if ((row.type === 'user' || row.type === 'assistant') && content === undefined) stats.contentlessMessages++;
  return result;
}

function queuedUserPrompt(row: SourceRecord): string | undefined {
  const attachment = row.type === 'attachment' ? row.attachment : undefined;
  return attachment?.type === 'queued_command' && attachment.origin?.kind === 'human' && typeof attachment.prompt === 'string' ? attachment.prompt : undefined;
}

export async function readClaudeSession(path: string, options: ReadOptions): Promise<EffectiveHistory> {
  const sourcePath = resolve(path);
  const before = await stat(sourcePath, { bigint: true });
  const entries: Entry[] = [];
  const stats: ReaderStats = {
    sourceLines: 0, parsedRecords: 0, blankLines: 0, invalidJsonLines: 0, invalidRecords: 0,
    invalidJsonLineNumbers: [], duplicateUuidRecords: 0, sidechainRecords: 0,
    selectedChainRecords: 0, excludedOffBranchRecords: 0, excludedBeforeCompactionRecords: 0,
    preservedRecords: 0, unresolvedPreservedReferences: 0, unresolvedParentReferences: 0, chainCycles: 0,
    supplementedToolResults: 0, rejectedOffBranchToolResults: 0,
    textThinkingBlocks: 0, textlessThinkingBlocks: 0, signatureBlocks: 0, encryptedOrRedactedBlocks: 0, imageBlocks: 0, documentBlocks: 0,
    nonTextPayloadBytes: 0, metadataBinaryPayloads: 0, metadataBinaryPayloadBytes: 0, unknownBlocks: 0, unknownRecords: 0, missingCompactionSummaries: 0, contentlessMessages: 0,
    toolCalls: 0, toolResults: 0, interruptionEvents: 0, omittedReadResults: 0, omittedReadChars: 0,
    sourceRecordTypes: Object.create(null) as Record<string, number>, selectedRecordTypes: Object.create(null) as Record<string, number>, blockTypes: Object.create(null) as Record<string, number>, unmatchedToolCalls: 0, unmatchedToolResults: 0, turns: 0,
  };
  const lines = sourceLines(sourcePath);
  for await (const line of lines) {
    stats.sourceLines++;
    if (!line.trim()) { stats.blankLines++; continue; }
    let row: SourceRecord;
    try { row = JSON.parse(line) as SourceRecord; } catch { stats.invalidJsonLines++; stats.invalidJsonLineNumbers.push(stats.sourceLines); continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { stats.invalidRecords++; continue; }
    stats.parsedRecords++;
    count(stats.sourceRecordTypes, row.type ?? '<missing>');
    if (REQUEST_LOG_TYPES.has(row.type ?? '')) continue;
    if (row.isSidechain) stats.sidechainRecords++;
    entries.push({ row: indexRow(row), line: stats.sourceLines, order: stats.sourceLines });
  }
  await assertUnchanged(sourcePath, before);
  const { selected, boundary, leaf, sidechainMode } = selectHistory(entries, stats);
  const selectedIds = new Set(selected.map((entry) => entry.row.uuid));
  const parentSessionId = entries.findLast(({ row }) => row.sessionId)?.row.sessionId;
  const sourceId = sidechainMode ? basename(path, '.jsonl') : parentSessionId ?? basename(path, '.jsonl');
  const globals = entries.filter(({ row }) => {
    const standaloneUnknown = row.uuid && !row.parentUuid && !row.logicalParentUuid && !CHAIN_TYPES.has(row.type ?? '') && !METADATA_TYPES.has(row.type ?? '');
    return (!row.uuid || standaloneUnknown) && !row.isSidechain && (!row.sessionId || row.sessionId === parentSessionId);
  });
  await hydrate(sourcePath, selected, globals);
  await assertUnchanged(sourcePath, before);
  const timeline = [...selected];
  for (const entry of globals) {
    if (boundary && entry.order < boundary.order) continue;
    if (entry.row.leafUuid && !selectedIds.has(entry.row.leafUuid)) continue;
    const index = timeline.findIndex((candidate) => candidate.order > entry.order && (!boundary || candidate.order >= boundary.order));
    if (index < 0) timeline.push(entry); else timeline.splice(index, 0, entry);
  }
  let sourceCwd = timeline.find(({ row }) => row.cwd)?.row.cwd;
  const images = await createImageStore({ directory: options.imageDirectory, cwd: sourceCwd });
  for (const entry of timeline) {
    entry.sourceUserText = typeof entry.row.message?.content === 'string' ? entry.row.message.content : blocksOf(entry.row).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n');
    sourceCwd = entry.row.cwd ?? sourceCwd;
    entry.row = await images.rewrite(preservationMetadata(entry.row), { sourceLine: entry.line, cwd: sourceCwd });
    if (entry.excludedContentIndices?.size && entry.row.message) entry.row.message.content = blocksOf(entry.row).filter((_, index) => !entry.excludedContentIndices?.has(index));
  }
  await assertUnchanged(sourcePath, before);
  const turns: HistoryTurn[] = [];
  let pending: HistoryStep[] = [];
  let summary;
  const summaryRows: Record<string, unknown>[] = [];
  for (const entry of timeline) {
    const row = entry.row;
    count(stats.selectedRecordTypes, row.type ?? '<missing>');
    if (!CHAIN_TYPES.has(row.type ?? '') && !METADATA_TYPES.has(row.type ?? '')) stats.unknownRecords++;
    const value = summaryText(row);
    if (value !== undefined && isSummary(row)) {
      summary = value;
      const { message, content: _summaryContent, summary: _summaryField, preservedMessages, ...record } = row;
      const { content: _messageContent, ...messageMetadata } = message ?? {};
      summaryRows.push({ sourceLine: entry.line, record: { ...record, preservedMessages: preservedMessages ? { uuids: references(preservedMessages) } : undefined }, message: messageMetadata, bodyReference: 'summary' });
      continue;
    }
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : blocksOf(row).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n');
    const hasResult = blocksOf(row).some((block) => block?.type === 'tool_result');
    const command = /^(?:<command-name>|<local-command|<command-message>)/.test(text.trimStart()) || (row.isMeta && text.trimStart().startsWith('<task-notification>'));
    const interruption = row.type === 'user' && Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && /^\[Request interrupted by user(?: for tool use)?\]$/.test(text);
    if (interruption) stats.interruptionEvents++;
    const startsTurn = row.type === 'user' && !row.isMeta && (!hasResult || (entry.sourceUserText?.length ?? 0) > 0) && !command && !interruption;
    if (startsTurn) {
      if (content === undefined || (Array.isArray(content) && content.length === 0)) stats.contentlessMessages++;
      const nonText = Array.isArray(content) ? content.filter((block) => block?.type !== 'text') : [];
      const extras = nonText.length > 0 ? makeSteps({ ...entry, row: { ...row, message: { ...row.message, content: nonText } } }, stats) : [];
      turns.push({ id: row.uuid ?? `line-${entry.line}`, user: text, steps: [...pending.map((step) => ({ ...step, beforeUser: true })), ...extras], timestamp: row.timestamp, metadata: recordMetadata(entry) });
      pending = [];
    } else {
      const queued = queuedUserPrompt(row);
      const steps: HistoryStep[] = queued === undefined ? makeSteps(entry, stats) : [{ kind: 'user_event', text: queued, timestamp: row.timestamp, metadata: recordMetadata(entry) }];
      if (row.type === 'user' && !row.isMeta && (command || interruption)) for (const step of steps) if (step.kind === 'event') step.kind = 'user_event';
      if (turns.length > 0) turns.at(-1)!.steps.push(...steps); else pending.push(...steps);
    }
  }
  stats.missingCompactionSummaries = boundary && !summary?.trim() ? 1 : 0;
  if (pending.length > 0) turns.push({ id: 'source-context', user: '', steps: pending });
  const relevant = [...selected.map(({ row }) => row), ...globals.map(({ row }) => row)];
  const latest = (field: 'customTitle' | 'aiTitle' | 'agentName' | 'title') => globals.map(({ row }) => row[field])
    .findLast((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim();
  const title = latest('customTitle') ?? latest('aiTitle') ?? latest('agentName') ?? latest('title');
  const calls = new Set(turns.flatMap((turn) => turn.steps.filter((step) => step.kind === 'tool_call').map((step) => step.callId)));
  const results = new Set(turns.flatMap((turn) => turn.steps.filter((step) => step.kind === 'tool_result').map((step) => step.callId)));
  stats.unmatchedToolCalls = [...calls].filter((id) => !results.has(id)).length;
  stats.unmatchedToolResults = [...results].filter((id) => !calls.has(id)).length;
  stats.turns = turns.length;
  stats.imageReferences = images.report();
  stats.imageBlocks = stats.imageReferences.contentReferences;
  const imageReferenceIndexPath = await images.saveManifest();
  await assertUnchanged(sourcePath, before);
  return {
    source: 'claude-code', sourcePath, sourceId, title,
    cwd: relevant.findLast((row) => row.cwd)?.cwd,
    gitBranch: timeline.findLast(({ row }) => row.gitBranch)?.row.gitBranch,
    metadata: {
      sourceKind: sidechainMode ? 'subagent' : 'main', parentSessionId: sidechainMode ? parentSessionId : undefined,
      versions: unique(relevant.map((row) => row.version)), gitBranches: unique(relevant.map((row) => row.gitBranch)),
      models: unique(relevant.map((row) => row.message?.model)), permissionModes: unique(relevant.map((row) => row.permissionMode)),
      leafUuid: leaf?.row.uuid, compactBoundary: boundary ? { sourceLine: boundary.line, record: boundary.row } : undefined,
      sourceSummaryRecords: summaryRows,
      retention: 'Source text is copied verbatim; images are retained as file paths or URLs at their original positions and can be read when needed. Embedded images are saved as attachments. Document payloads retain explicit omission markers. No Read tool output is excluded.',
    },
    summary, turns, stats, imageReferences: images.manifest(), imageReferenceIndexPath,
  };
}
