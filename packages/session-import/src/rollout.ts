import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageStore } from '#/images';
import { readJsonLines } from '#/jsonl';
import type { EffectiveHistory, HistoryStep, HistoryTurn, ReadOptions } from '#/types';

interface ContentPart extends Record<string, unknown> {
  type?: string;
  text?: string;
}

interface SourceItem extends Record<string, unknown> {
  type?: string;
  id?: string;
  role?: string;
  name?: string;
  call_id?: string;
  turn_id?: string;
  thread_id?: string;
  cwd?: string;
  title?: string;
  timestamp?: string;
  message?: string;
  text?: string;
  num_turns?: number;
  subagent_history_start_ordinal?: number;
  content?: ContentPart[];
  summary?: ContentPart[];
  images?: unknown[];
  local_images?: Array<string | { path?: string }>;
  payload?: SourceItem;
  item?: SourceItem;
  replacement_history?: SourceItem[];
  replacement_history_metadata?: unknown[];
  internal_chat_message_metadata_passthrough?: {
    turn_id?: string;
    content_item_kinds?: string[];
  };
}

interface Descriptor {
  line: number;
  kind: 'response' | 'event' | 'context';
  type?: string;
  role?: string;
  turnId?: string;
  cwd?: string;
  explicitTurn?: boolean;
  user?: boolean;
  userHash?: string;
  userBlockHashes?: string[];
  sourceSummary?: boolean;
  replacementIndex?: number;
  replacementMetadata?: unknown;
  responseIdentity?: string;
  responseDigest?: string;
  userEventMatched?: boolean;
  queuedUser?: boolean;
  mirroredUserLine?: number;
}

interface Candidate extends Descriptor {
  item: SourceItem;
  timestamp?: string;
  originalText?: string;
  omittedMirror?: boolean;
}

interface ReaderStats {
  encryptedPayloadsOmitted: number;
  encryptedBytesOmitted: number;
  binaryPayloadsOmitted: number;
  binaryBytesOmitted: number;
  nonTextBlocks: number;
  unknownContentBlocks: number;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

type ItemContext = 'row' | 'response' | 'event' | 'projection' | 'metadata' | 'turn_context' | 'compacted' | 'opaque';

function decodeItem(value: unknown, context: ItemContext = 'response'): SourceItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_RECORD_SHAPE');
  const record = value as Record<string, unknown>;
  const strings = (keys: string[]) => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && typeof record[key] !== 'string') throw fail('INVALID_RECORD_SHAPE');
    }
  };
  const parts = (key: string) => {
    if (record[key] === undefined || record[key] === null) return;
    if (!Array.isArray(record[key])) throw fail('INVALID_RECORD_SHAPE');
    for (const part of record[key]) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) throw fail('INVALID_RECORD_SHAPE');
      for (const field of ['type', 'text']) {
        const fieldValue = object(part)[field];
        if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== 'string') throw fail('INVALID_RECORD_SHAPE');
      }
    }
  };
  if (context === 'opaque') return record as SourceItem;
  if (context === 'metadata' || context === 'turn_context') {
    strings(context === 'metadata' ? ['id', 'cwd', 'title'] : ['cwd', 'turn_id']);
    const ordinal = record['subagent_history_start_ordinal'];
    if (context === 'metadata' && ordinal !== undefined && ordinal !== null && (!Number.isSafeInteger(ordinal) || typeof ordinal !== 'number' || ordinal < 0)) throw fail('INVALID_RECORD_SHAPE');
    return record as SourceItem;
  }
  if (context === 'compacted') {
    const replacement = record['replacement_history'];
    if (Array.isArray(replacement)) for (const item of replacement) decodeItem(item, 'response');
    const metadata = record['replacement_history_metadata'];
    if (metadata !== undefined && metadata !== null && !Array.isArray(metadata)) throw fail('INVALID_RECORD_SHAPE');
    return record as SourceItem;
  }
  strings(['type']);
  if (context === 'row') {
    strings(['timestamp']);
    const payloadContexts: Record<string, ItemContext> = {
      session_meta: 'metadata', turn_context: 'turn_context', compacted: 'compacted',
      response_item: 'response', event_msg: 'event',
    };
    const payloadContext = typeof record['type'] === 'string' ? payloadContexts[record['type']] : undefined;
    if (payloadContext) decodeItem(record['payload'], payloadContext);
    return record as SourceItem;
  }
  if (context === 'event') {
    strings(['thread_id', 'turn_id']);
    if (record['type'] === 'item_completed') decodeItem(record['item'], 'projection');
    if (record['type'] === 'user_message') {
      strings(['message', 'text']);
      for (const key of ['images', 'local_images']) {
        if (record[key] !== undefined && record[key] !== null && !Array.isArray(record[key])) throw fail('INVALID_RECORD_SHAPE');
      }
      if (Array.isArray(record['local_images'])) {
        for (const entry of record['local_images']) {
          if (typeof entry !== 'string' && (entry === null || typeof entry !== 'object' || Array.isArray(entry)
            || (object(entry)['path'] !== undefined && typeof object(entry)['path'] !== 'string'))) throw fail('INVALID_RECORD_SHAPE');
        }
      }
    }
    return record as SourceItem;
  }
  if (context === 'projection') {
    strings(['id']);
    if (record['type'] === 'UserMessage' || record['type'] === 'AgentMessage') parts('content');
    return record as SourceItem;
  }
  strings(['id', 'turn_id']);
  const metadata = record['internal_chat_message_metadata_passthrough'];
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) throw fail('INVALID_RECORD_SHAPE');
    const fields = object(metadata);
    if (fields['turn_id'] !== undefined && fields['turn_id'] !== null && typeof fields['turn_id'] !== 'string') throw fail('INVALID_RECORD_SHAPE');
    const kinds = fields['content_item_kinds'];
    if (kinds !== undefined && kinds !== null && (!Array.isArray(kinds) || kinds.some((entry) => typeof entry !== 'string'))) throw fail('INVALID_RECORD_SHAPE');
  }
  if (record['type'] === 'message') { strings(['role']); parts('content'); }
  if (record['type'] === 'reasoning') { parts('content'); parts('summary'); }
  if (typeof record['type'] === 'string' && ['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call', 'web_search_call', 'function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(record['type'])) strings(['name', 'call_id']);
  return record as SourceItem;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inc = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
const asText = (value: unknown): string => typeof value === 'string' ? value : (value === undefined || value === null) ? '' : JSON.stringify(value) ?? '';
const contentText = (value: unknown) => Array.isArray(value) ? value.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n') : asText(value);
const inputKinds = (item: SourceItem) => item.internal_chat_message_metadata_passthrough?.content_item_kinds;
const itemTurn = (item: SourceItem, fallback?: string) => item.internal_chat_message_metadata_passthrough?.turn_id ?? item.turn_id ?? fallback;
const fail = (code: string, message = code) => Object.assign(new Error(message), { code });
const HISTORY_BASE_MESSAGE = 'This Codex session was forked or restarted from an earlier message, so part of its history is stored in another rollout file. Importing it is not supported yet.';
const sameStamp = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const RETAINED_EVENTS = new Set([
  'task_started', 'turn_started', 'turn_aborted', 'task_aborted', 'agent_reasoning_raw_content', 'context_compacted',
  'entered_review_mode', 'exited_review_mode', 'undo_completed', 'thread_goal_updated', 'thread_name_updated', 'session_renamed',
  'sub_agent_activity', 'image_generation_end', 'patch_apply_end', 'mcp_tool_call_end', 'web_search_end', 'exec_command_end',
  'view_image_tool_call', 'error', 'guardian_assessment', 'dynamic_tool_call_request', 'dynamic_tool_call_response',
  'collab_agent_spawn_end', 'collab_agent_interaction_end', 'collab_waiting_end', 'collab_close_end', 'collab_resume_end',
]);
const RETAINED_PROJECTIONS = new Set([
  'FunctionCallOutput', 'HookPrompt', 'Plan', 'CommandExecution', 'DynamicToolCall', 'CollabAgentToolCall', 'SubAgentActivity', 'WebSearch',
  'ImageView', 'Extension', 'Sleep', 'ImageGeneration', 'EnteredReviewMode', 'ExitedReviewMode', 'FileChange', 'McpToolCall', 'ContextCompaction',
]);
const SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

function isSourceSummary(item: SourceItem) {
  return item.type === 'message' && item.role === 'user' && item.content?.some((part) => typeof part.text === 'string' && part.text.startsWith(`${SUMMARY_PREFIX}\n`));
}

const USER_SHELL_COMMAND = /^\s*<user_shell_command>/;

function contextualText(text: string) {
  return /^\s*(?:# AGENTS\.md instructions for |<environment_context>|<user_instructions>|<permissions instructions>|<turn_aborted>|<subagent_notification>|<skill>|<external_[^>]+>|<user_shell_command>|<recommended_plugins>|<agent_message_board_notification>|<internal_model_context>|<hook_prompt>)/.test(text);
}

function isRealUser(item: SourceItem) {
  if (item.type !== 'message' || item.role !== 'user') return false;
  if (isSourceSummary(item)) return false;
  const kinds = inputKinds(item);
  if (Array.isArray(kinds) && kinds.length > 0 && kinds.length === item.content?.length) {
    return kinds.some((kind) => kind.startsWith('user.') || kind === '' || kind === 'unknown' || /(?:image|audio).*(?:error|unsupported)/.test(kind));
  }
  return !item.content?.some((part) => part.type === 'input_text' && contextualText(part.text ?? ''));
}

function sanitize(value: unknown, stats: ReaderStats, key = ''): unknown {
  if ((value === undefined || value === null)) return value;
  if (/^(?:encrypted_content|encrypted_function_args|signature|encrypted_signature)$/.test(key)) {
    stats.encryptedPayloadsOmitted++;
    stats.encryptedBytesOmitted += Buffer.byteLength(asText(value));
    return undefined;
  }
  if (typeof value === 'string' && /^data:(?:image|audio|application)\//.test(value) && !['text', 'message', 'input', 'arguments', 'output', 'content', 'summary_text', 'raw_content'].includes(key)) {
    stats.binaryPayloadsOmitted++;
    stats.binaryBytesOmitted += Buffer.byteLength(value);
    return '[Non-text payload omitted]';
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, stats));
  if (typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (object(value)['type'] === 'base64' && childKey === 'data' && typeof child === 'string') {
      stats.binaryPayloadsOmitted++;
      stats.binaryBytesOmitted += Buffer.byteLength(child);
      result[childKey] = '[Non-text payload omitted]';
      continue;
    }
    const cleaned = sanitize(child, stats, childKey);
    if (cleaned !== undefined) result[childKey] = cleaned;
  }
  return result;
}

function textBlocks(content: unknown, stats: ReaderStats) {
  if (!Array.isArray(content)) return asText(content);
  return content.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    if (['input_image', 'image', 'input_audio', 'audio', 'input_file', 'file'].includes(part?.type)) {
      stats.nonTextBlocks++;
      return `[Source ${part.type}: ${JSON.stringify(part)}]`;
    }
    stats.unknownContentBlocks++;
    return JSON.stringify(part);
  }).join('\n');
}

async function scan(path: string, onRecord: (row: SourceItem | undefined, line: number, status?: 'blank' | 'invalid') => void | Promise<void>) {
  const digest = createHash('sha256');
  let lineNumber = 0;
  for await (const line of readJsonLines(path)) {
    lineNumber++;
    digest.update(line).update('\n');
    if (!line.trim()) { await onRecord(undefined, lineNumber, 'blank'); continue; }
    let row: unknown;
    try { row = JSON.parse(line) as unknown; } catch { await onRecord(undefined, lineNumber, 'invalid'); continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { await onRecord(undefined, lineNumber, 'invalid'); continue; }
    await onRecord(decodeItem(row, 'row'), lineNumber);
  }
  return { digest: digest.digest('hex'), lineNumber };
}

const opensTurn = (entry: Descriptor) => entry.user === true || entry.mirroredUserLine !== undefined || entry.kind === 'context'
  || entry.kind === 'response' && entry.type === 'message' && entry.role !== 'assistant';

function responseDescriptor(item: SourceItem, line: number, turnId?: string, replacementIndex?: number, replacementMetadata?: unknown): Descriptor {
  return { line, kind: 'response', responseIdentity: item.id ? `${item.type ?? 'unknown'}:${item.id}` : undefined, responseDigest: item.id ? hash(JSON.stringify(item)) : undefined, type: item.type, role: item.role, turnId: itemTurn(item, turnId), explicitTurn: Boolean(item.internal_chat_message_metadata_passthrough?.turn_id ?? item.turn_id), user: isRealUser(item), userHash: item.role === 'user' ? hash(contentText(item.content)) : undefined, userBlockHashes: item.role === 'user' ? item.content?.flatMap((part) => typeof part.text === 'string' ? [hash(part.text)] : []) : undefined, sourceSummary: isSourceSummary(item), replacementIndex, replacementMetadata };
}

function imageKey(value: unknown, cwd?: string) {
  const part = object(value);
  const localPath = (reference: string) => {
    if (/^file:/i.test(reference)) { try { return fileURLToPath(reference); } catch { return reference; } }
    if (isAbsolute(reference) || win32.isAbsolute(reference) || reference.startsWith('~') || !cwd || !isAbsolute(cwd) && !win32.isAbsolute(cwd)) return reference;
    return win32.isAbsolute(cwd) && !isAbsolute(cwd) ? win32.resolve(cwd, reference) : resolve(cwd, reference);
  };
  if (part['type'] === 'local_image' && typeof part['path'] === 'string') return `path:${localPath(part['path'])}`;
  if (!['input_image', 'image', 'image_url'].includes(asText(part['type']))) return undefined;
  const source = object(part['source']);
  const reference = typeof part['image_url'] === 'string' ? part['image_url']
    : object(part['image_url'])['url'] ?? part['url'] ?? source['url'] ?? source['path'] ?? source['filePath'] ?? part['path'];
  if (source['type'] === 'base64' && typeof source['data'] === 'string') return `embedded:${hash(source['data'].replaceAll(/\s/g, '').replace(/=+$/, ''))}`;
  if (typeof reference !== 'string') return undefined;
  if (/^data:image\//i.test(reference)) return `embedded:${hash(reference.slice(reference.indexOf(',') + 1).replaceAll(/\s/g, '').replace(/=+$/, ''))}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^file:/i.test(reference) && !win32.isAbsolute(reference)) return `url:${reference}`;
  return `path:${localPath(reference)}`;
}

function imageKeys(value: unknown, cwd?: string, result = new Set<string>()) {
  if (!value || typeof value !== 'object') return result;
  const key = imageKey(value, cwd);
  if (key) result.add(key);
  else for (const child of Object.values(value)) imageKeys(child, cwd, result);
  return result;
}

async function threadName(databasePath: string, id: string): Promise<string | undefined> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 3000 });
    try {
      const value = database.prepare('SELECT name FROM threads WHERE id = ?').get(id)?.['name'];
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
}

export async function readRolloutSession(sourcePath: string, options: ReadOptions): Promise<EffectiveHistory> {
  const path = resolve(sourcePath);
  const before = await stat(path, { bigint: true });
  const stats = {
    sourceLines: 0, invalidJsonLines: 0, blankLines: 0, parsedRecords: 0,
    compactions: 0, replacementCompactions: 0, supersededRecords: 0, rollbacks: 0, rolledBackRecords: 0,
    foreignThreadEvents: 0, inheritedChildRecords: 0, additionalSessionMetadataRecords: 0,
    telemetryRecordsOmitted: 0, encryptedPayloadsOmitted: 0, encryptedBytesOmitted: 0,
    binaryPayloadsOmitted: 0, binaryBytesOmitted: 0, nonTextBlocks: 0, unknownContentBlocks: 0, unknownRecords: 0,
    mirroredEventsOmitted: 0, duplicateResponseIds: 0, eventFallbacks: 0,
    reasoningSummarySteps: 0, reasoningContentSteps: 0, opaqueReasoningSteps: 0, opaqueCompactionSteps: 0,
    toolCalls: 0, toolResults: 0, unmatchedToolResults: 0, abortedTurns: 0,
    sourceRecordTypes: {}, sourceResponseTypes: {}, sourceEventTypes: {}, selectedResponseTypes: {},
  };
  let canonicalMeta: SourceItem | undefined;
  let activeTurn: string | undefined;
  let activeCwd: string | undefined;
  let selected: Descriptor[] = [];
  let latestCompactionLine: number | undefined;
  const first = await scan(path, (row, line, status) => {
    stats.sourceLines = line;
    if (status === 'blank') { stats.blankLines++; return; }
    if (status === 'invalid') { stats.invalidJsonLines++; return; }
    if (!row) return;
    stats.parsedRecords++;
    inc(stats.sourceRecordTypes, row.type ?? 'unknown');
    const payload = row.payload ?? decodeItem({});
    if (row.type === 'session_meta') {
      if (!canonicalMeta) { canonicalMeta = payload; activeCwd = payload.cwd; }
      else stats.additionalSessionMetadataRecords++;
      return;
    }
    if (canonicalMeta?.['history_base']) throw fail('UNSUPPORTED_HISTORY_BASE', HISTORY_BASE_MESSAGE);
    if (typeof canonicalMeta?.subagent_history_start_ordinal === 'number' && line - 1 < canonicalMeta.subagent_history_start_ordinal) {
      stats.inheritedChildRecords++;
      return;
    }
    if (row.type === 'event_msg') {
      inc(stats.sourceEventTypes, payload.type ?? 'unknown');
      if (payload.thread_id && canonicalMeta?.id && payload.thread_id !== canonicalMeta.id) { stats.foreignThreadEvents++; return; }
      if (['task_started', 'turn_started'].includes(payload.type ?? '')) {
        activeTurn = payload.turn_id ?? activeTurn;
        for (let i = selected.length - 1; i >= 0; i--) {
          const entry = selected[i];
          if (!entry || entry.turnId || !opensTurn(entry)) break;
          entry.turnId = activeTurn;
        }
      }
      if (payload.type === 'thread_rolled_back') {
        stats.rollbacks++;
        if (latestCompactionLine) throw fail('UNSUPPORTED_ROLLBACK_ACROSS_COMPACTION');
        if (selected.some((entry) => entry.type === 'agent_message')) throw fail('UNSUPPORTED_INTER_AGENT_ROLLBACK');
        const count = payload.num_turns;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw fail('INVALID_ROLLBACK');
        const boundaries: number[] = [];
        const responseDigests = new Map<string, string>();
        for (const [index, entry] of selected.entries()) {
          if (entry.responseIdentity && entry.responseDigest) {
            if (responseDigests.get(entry.responseIdentity) === entry.responseDigest) continue;
            responseDigests.set(entry.responseIdentity, entry.responseDigest);
          }
          if (entry.user) boundaries.push(index);
        }
        if (count > 0 && boundaries.length > 0) {
          let cutoff = boundaries[Math.max(0, boundaries.length - count)]!;
          const owner = selected[cutoff]?.turnId;
          if (owner !== undefined) while (cutoff > 0 && selected[cutoff - 1]?.turnId === owner && !selected[cutoff - 1]?.user) cutoff--;
          stats.rolledBackRecords += selected.length - cutoff;
          selected.length = cutoff;
        }
        return;
      }
      if (['token_count', 'thread_settings_applied'].includes(payload.type ?? '')) { stats.telemetryRecordsOmitted++; return; }
      const eventUser = payload.type === 'user_message' || payload.type === 'item_completed' && payload.item?.type === 'UserMessage';
      let eventOnlyUser = eventUser;
      let mirroredUserLine;
      let userHash: string | undefined;
      if (eventUser) {
        userHash = hash(payload.type === 'user_message' ? payload.message ?? '' : contentText(payload.item?.content));
        const eventTurn = payload.turn_id ?? activeTurn;
        const response = selected.findLast((entry) => entry.kind === 'response' && (entry.userHash === userHash || entry.userBlockHashes?.includes(userHash ?? '')) && !entry.userEventMatched
          && (entry.turnId === eventTurn || !entry.turnId || !eventTurn || entry.queuedUser));
        if (response) {
          response.user = true;
          response.userEventMatched = true;
          response.queuedUser = false;
          if (!response.explicitTurn) response.turnId = payload.turn_id ?? activeTurn;
          eventOnlyUser = false;
          mirroredUserLine = response.line;
        }
      }
      selected.push({ line, kind: 'event', turnId: payload.turn_id ?? activeTurn, cwd: activeCwd, user: eventOnlyUser, mirroredUserLine, userHash });
      if (['task_complete', 'turn_complete', 'turn_aborted', 'task_aborted'].includes(payload.type ?? '')) activeTurn = undefined;
      return;
    }
    if (row.type === 'turn_context') { activeTurn = payload.turn_id ?? activeTurn; activeCwd = payload.cwd ?? activeCwd; }
    if (row.type === 'compacted') {
      stats.compactions++;
      if (!Array.isArray(payload.replacement_history)) throw fail('UNSUPPORTED_LEGACY_COMPACTION');
      stats.replacementCompactions++;
      stats.supersededRecords += selected.length;
      latestCompactionLine = line;
      selected = payload.replacement_history.map((item, index) => {
        if (!item?.type) throw fail('UNSUPPORTED_REPLACEMENT_ENVELOPE');
        return { ...responseDescriptor(item, line, activeTurn, index, payload.replacement_history_metadata?.[index]), cwd: activeCwd };
      });
      return;
    }
    if (['token_usage_record', 'security_risk_score'].includes(row.type ?? '')) { stats.telemetryRecordsOmitted++; return; }
    if (row.type === 'response_item') {
      inc(stats.sourceResponseTypes, payload.type ?? 'unknown');
      const descriptor = responseDescriptor(payload, line, activeTurn);
      descriptor.cwd = activeCwd;
      descriptor.queuedUser = payload.role === 'user' && !descriptor.explicitTurn && Boolean(activeTurn)
        && selected.some((entry) => entry.user && entry.turnId === activeTurn && !entry.queuedUser);
      if (payload.role === 'user') {
        const earlierEvent = selected.findLast((entry) => entry.kind === 'event' && entry.user && entry.userHash
          && (entry.userHash === descriptor.userHash || descriptor.userBlockHashes?.includes(entry.userHash))
          && (entry.turnId === descriptor.turnId || !entry.turnId || !descriptor.turnId));
        if (earlierEvent) {
          earlierEvent.user = false;
          earlierEvent.mirroredUserLine = line;
          descriptor.user = true;
          descriptor.userEventMatched = true;
          descriptor.queuedUser = false;
          descriptor.turnId ??= earlierEvent.turnId;
        }
      }
      selected.push(descriptor);
    } else selected.push({ line, kind: 'context', type: row.type, turnId: activeTurn, cwd: activeCwd });
  });
  if (!sameStamp(before, await stat(path, { bigint: true }))) throw fail('SOURCE_CHANGED');
  if (!canonicalMeta) throw fail('MISSING_SESSION_METADATA');
  if (canonicalMeta['history_base']) throw fail('UNSUPPORTED_HISTORY_BASE', HISTORY_BASE_MESSAGE);

  const wanted = new Map<number, Descriptor[]>();
  for (const descriptor of selected) {
    const list = wanted.get(descriptor.line) ?? [];
    list.push(descriptor);
    wanted.set(descriptor.line, list);
  }
  const candidates: Candidate[] = [];
  const second = await scan(path, (row, line) => {
    const descriptors = wanted.get(line);
    if (!descriptors || !row) return;
    for (const descriptor of descriptors) {
      const raw = descriptor.replacementIndex === undefined ? row.payload ?? row : row.payload?.replacement_history?.[descriptor.replacementIndex];
      if (!raw) throw fail('SOURCE_CHANGED');
      candidates.push({ ...descriptor, item: raw, timestamp: row.timestamp });
    }
  });
  if (first.digest !== second.digest || !sameStamp(before, await stat(path, { bigint: true }))) throw fail('SOURCE_CHANGED');
  const responseFingerprints = new Map<string, number[]>();
  const reasoningBlocks = new Set<string>();
  const callIds = new Set<string>();
  const responseIds = new Map<string, { digest: string; line: number }>();
  const responseLineAliases = new Map<number, number>();
  const responseImages = new Map<number, Set<string | undefined>>();
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'response') { accepted.push(candidate); continue; }
    const item = candidate.item;
    const identity = candidate.responseIdentity;
    const digest = candidate.responseDigest ?? hash(JSON.stringify(item));
    responseImages.set(candidate.line, imageKeys(item.content ?? item['output'], candidate.cwd));
    const earlier = identity ? responseIds.get(identity) : undefined;
    if (earlier?.digest === digest) { stats.duplicateResponseIds++; responseLineAliases.set(candidate.line, earlier.line); continue; }
    if (identity) responseIds.set(identity, { digest, line: candidate.line });
    const callId = item.call_id ?? item.id;
    if (callId && item.type?.endsWith('call')) callIds.add(callId);
    if (item.type === 'message' && (candidate.user || item.role === 'assistant')) {
      const key = `${candidate.turnId ?? ''}:${candidate.user ? 'user' : 'assistant'}:${hash(contentText(item.content))}`;
      responseFingerprints.set(key, [...responseFingerprints.get(key) ?? [], candidate.line]);
    }
    if (item.type === 'reasoning') {
      const key = `${candidate.turnId ?? ''}:thinking:${hash(contentText(item.summary))}`;
      responseFingerprints.set(key, [...responseFingerprints.get(key) ?? [], candidate.line]);
      for (const [form, parts] of [['summary', item.summary], ['content', item.content]] as const) {
        for (const part of parts ?? []) if (typeof part.text === 'string') reasoningBlocks.add(`${candidate.turnId ?? ''}:${form}:${hash(part.text)}`);
      }
    }
    accepted.push(candidate);
  }
  const imageDirectory = options.imageDirectory;
  const imageStore = await createImageStore({ directory: imageDirectory, cwd: canonicalMeta.cwd });
  for (const candidate of accepted) {
    const raw = candidate.item;
    const projected = raw.type === 'item_completed' ? raw.item : undefined;
    candidate.originalText = projected ? contentText(projected.content) : asText(raw.message ?? raw.text);
    if (candidate.kind === 'event' && candidate.mirroredUserLine === undefined && projected?.type !== 'Reasoning') {
      const role = raw.type === 'user_message' || projected?.type === 'UserMessage' ? 'user'
        : raw.type === 'agent_message' || projected?.type === 'AgentMessage' ? 'assistant'
        : raw.type === 'agent_reasoning' ? 'thinking' : undefined;
      const key = `${candidate.turnId ?? ''}:${role}:${hash(candidate.originalText)}`;
      const mirroredLine = role ? responseFingerprints.get(key)?.shift() : undefined;
      if (mirroredLine !== undefined || projected?.id && callIds.has(projected.id)) {
        const media = role === 'assistant' && mirroredLine !== undefined
          ? projected?.content?.filter((part) => typeof part?.text !== 'string' && !responseImages.get(mirroredLine)?.has(imageKey(part, candidate.cwd))) ?? []
          : [];
        if (media.length === 0) {
          candidate.omittedMirror = true;
          continue;
        }
        candidate.item = { ...raw, item: { ...projected, content: media } };
      }
    }
    if (candidate.mirroredUserLine !== undefined && projected?.content) {
      const knownImages = responseImages.get(candidate.mirroredUserLine) ?? new Set();
      const attachments = projected.content.filter((part) => typeof part?.text !== 'string' && !knownImages.has(imageKey(part, candidate.cwd)));
      candidate.item = { ...raw, item: { ...projected, content: attachments } };
    } else if (candidate.mirroredUserLine !== undefined && raw.type === 'user_message') {
      const knownImages = responseImages.get(candidate.mirroredUserLine) ?? new Set();
      candidate.item = { ...raw,
        images: raw.images?.filter((part) => !knownImages.has(imageKey({ type: 'input_image', image_url: part }, candidate.cwd))),
        local_images: raw.local_images?.filter((part) => !knownImages.has(imageKey({ type: 'local_image', path: typeof part === 'string' ? part : part.path }, candidate.cwd))),
      };
    }
    candidate.item = decodeItem(sanitize(await imageStore.rewrite(candidate.item, { sourceLine: candidate.line, cwd: candidate.cwd }), stats), candidate.kind === 'response' ? 'response' : candidate.kind === 'event' ? 'event' : 'opaque');
    candidate.replacementMetadata = sanitize((await imageStore.rewrite({ metadata: candidate.replacementMetadata }, { sourceLine: candidate.line, cwd: candidate.cwd })).metadata, stats);
  }
  const turns: HistoryTurn[] = [];
  const turnsBySourceLine = new Map<number, HistoryTurn>();
  const pendingUserAttachments = new Map<number, HistoryStep[]>();
  let current: HistoryTurn | undefined;
  let pending: HistoryStep[] = [];
  let sourceSummary: string | undefined;
  const start = (candidate: Candidate, user: string) => {
    const id = `${candidate.turnId ?? canonicalMeta?.id ?? 'source'}:${turns.length + 1}`;
    const { content: _content, ...sourceMessage } = candidate.item;
    current = { id, user, timestamp: candidate.timestamp, metadata: { sourceLine: candidate.line, sourceTurnId: candidate.turnId, sourceMessage, replacementMetadata: candidate.replacementMetadata }, steps: pending.map((step) => ({ ...step, beforeUser: true })) };
    current.steps.push(...pendingUserAttachments.get(candidate.line) ?? []);
    pendingUserAttachments.delete(candidate.line);
    turnsBySourceLine.set(candidate.line, current);
    pending = [];
    turns.push(current);
  };
  const add = (step: HistoryStep) => current ? current.steps.push(step) : pending.push(step);
  for (const candidate of accepted) {
    if (candidate.omittedMirror) { stats.mirroredEventsOmitted++; continue; }
    const { item, timestamp } = candidate;
    const metadata: Record<string, unknown> = { sourceLine: candidate.line, sourceTurnId: candidate.turnId, sourceItemType: item.type, replacementIndex: candidate.replacementIndex, replacementMetadata: candidate.replacementMetadata };
    if (candidate.kind === 'response') {
      inc(stats.selectedResponseTypes, item.type ?? 'unknown');
      const { content, summary, arguments: args, input, output, ...details } = item;
      metadata['item'] = details;
      if (item.type === 'message') {
        const text = textBlocks(content, stats);
        if (candidate.sourceSummary) sourceSummary = sourceSummary ? `${sourceSummary}\n\n${text}` : text;
        else if (candidate.user) start(candidate, text);
        else add({ kind: item.role === 'assistant' ? 'assistant' : item.role === 'user' && USER_SHELL_COMMAND.test(text) ? 'user_event' : 'source_context', text, timestamp, metadata });
      } else if (item.type === 'reasoning') {
        const summaryText = textBlocks(summary ?? [], stats);
        const visibleContent = textBlocks(content ?? [], stats);
        if (summaryText) { stats.reasoningSummarySteps++; add({ kind: 'thinking', text: summaryText, timestamp, metadata: { ...metadata, reasoningForm: 'source summary, not raw reasoning' } }); }
        if (visibleContent) { stats.reasoningContentSteps++; add({ kind: 'thinking', text: visibleContent, timestamp, metadata: { ...metadata, reasoningForm: 'source recorded plaintext' } }); }
        if (!summaryText && !visibleContent) { stats.opaqueReasoningSteps++; add({ kind: 'event', text: '[Source reasoning has no recorded plaintext; encrypted payload omitted.]', timestamp, metadata }); }
      } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call', 'web_search_call'].includes(item.type ?? '')) {
        stats.toolCalls++;
        add({ kind: 'tool_call', name: item.name ?? item.type, callId: item.call_id ?? item.id, text: asText(args ?? input ?? item['action']), timestamp, metadata });
      } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type ?? '')) {
        stats.toolResults++;
        if (!callIds.has(item.call_id ?? '')) stats.unmatchedToolResults++;
        add({ kind: 'tool_result', name: item.name, callId: item.call_id, text: output === undefined ? asText(item['tools']) : textBlocks(output, stats), timestamp, metadata });
      } else if (item.type === 'compaction' || item.type === 'context_compaction') {
        stats.opaqueCompactionSteps++;
        add({ kind: 'event', text: '[Source compaction checkpoint: encrypted state is unavailable as plaintext.]', timestamp, metadata });
      } else {
        if (!['additional_tools', 'agent_message'].includes(item.type ?? '')) stats.unknownRecords++;
        const { item: _item, ...context } = metadata;
        add({ kind: 'event', text: JSON.stringify(item), timestamp, metadata: context });
      }
      continue;
    }
    if (candidate.kind === 'event') {
      const projected = item.type === 'item_completed' ? item.item : undefined;
      if (candidate.mirroredUserLine !== undefined) {
        stats.mirroredEventsOmitted++;
        const attachments = projected?.content ?? [...item.images ?? [], ...item.local_images ?? []];
        if (attachments.length > 0) {
          const step: HistoryStep = { kind: 'source_context', text: textBlocks(attachments, stats), timestamp, metadata };
          const targetLine = responseLineAliases.get(candidate.mirroredUserLine) ?? candidate.mirroredUserLine;
          const target = turnsBySourceLine.get(targetLine);
          if (target) target.steps.push(step);
          else {
            const queued = pendingUserAttachments.get(targetLine) ?? [];
            queued.push(step);
            pendingUserAttachments.set(targetLine, queued);
          }
        }
        continue;
      }
      if (projected?.type === 'Reasoning') {
        let added = 0;
        for (const [form, parts] of [['summary', projected['summary_text']], ['content', projected['raw_content']]] as const) {
          for (const part of Array.isArray(parts) ? parts : parts ? [parts] : []) {
            const visible = asText(part);
            const key = `${candidate.turnId ?? ''}:${form}:${hash(visible)}`;
            if (reasoningBlocks.has(key)) continue;
            reasoningBlocks.add(key);
            added++;
            add({ kind: 'thinking', text: visible, timestamp, metadata: { ...metadata, reasoningForm: `source event ${form}`, eventProjectionFallback: true } });
          }
        }
        if (added) stats.eventFallbacks++;
        else stats.mirroredEventsOmitted++;
        continue;
      }
      const role = item.type === 'user_message' || projected?.type === 'UserMessage' ? 'user'
        : item.type === 'agent_message' || projected?.type === 'AgentMessage' ? 'assistant'
        : item.type === 'agent_reasoning' || projected?.type === 'Reasoning' ? 'thinking' : undefined;
      if (role) {
        const text = projected ? role === 'thinking' ? (Array.isArray(projected['summary_text']) ? projected['summary_text'].join('\n') : asText(projected['summary_text'] ?? projected['raw_content'])) : textBlocks(projected.content, stats)
          : [asText(item.message ?? item.text), textBlocks([...item.images ?? [], ...item.local_images ?? []], stats)].filter(Boolean).join('\n');
        stats.eventFallbacks++;
        if (role === 'user') start(candidate, text);
        else add({ kind: role === 'assistant' ? 'assistant' : 'thinking', text, timestamp, metadata: { ...metadata, eventProjectionFallback: true, reasoningForm: role === 'thinking' ? 'source event summary' : undefined } });
        continue;
      }
      if (projected?.id && callIds.has(projected.id)) { stats.mirroredEventsOmitted++; continue; }
      const aborted = ['turn_aborted', 'task_aborted'].includes(item.type ?? '');
      if (aborted) stats.abortedTurns++;
      if (['task_complete', 'turn_complete'].includes(item.type ?? '')) {
        const { last_agent_message: _lastAgentMessage, ...completion } = item;
        add({ kind: 'event', text: JSON.stringify(completion), timestamp, metadata });
      } else {
        if (!(projected ? RETAINED_PROJECTIONS : RETAINED_EVENTS).has((projected ?? item).type ?? '')) stats.unknownRecords++;
        add({ kind: aborted ? 'user_event' : 'event', text: JSON.stringify(item), timestamp, metadata });
      }
    } else {
      if (!['turn_context', 'world_state', 'inter_agent_communication_metadata'].includes(candidate.type ?? '')) stats.unknownRecords++;
      add({ kind: 'source_context', text: JSON.stringify(item), timestamp, metadata });
    }
  }
  if (pending.length > 0) {
    current = { id: `${canonicalMeta.id ?? 'source'}:context-only`, user: '', steps: pending };
    turns.push(current);
  }
  const title = options.stateDatabasePath ? await threadName(options.stateDatabasePath, canonicalMeta.id ?? '') : undefined;
  const metadata = object(sanitize((await imageStore.rewrite({ metadata: canonicalMeta }, { cwd: canonicalMeta.cwd })).metadata, stats));
  const finalStats = { ...stats, selectedRecords: selected.length, selectedTurns: turns.length, sourceFingerprint: first.digest, imageReferences: imageStore.report() };
  const imageReferenceIndexPath = await imageStore.saveManifest();
  const gitBranch = object(canonicalMeta['git'])['branch'];
  return { source: 'codex', sourcePath: path, sourceId: canonicalMeta.id ?? basename(path), title: title ?? canonicalMeta.title,
    cwd: canonicalMeta.cwd, gitBranch: typeof gitBranch === 'string' ? gitBranch : undefined, metadata, summary: sourceSummary, turns, imageReferences: imageStore.manifest(), imageReferenceIndexPath, stats: finalStats };
}
