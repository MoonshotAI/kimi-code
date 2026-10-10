import { open, readFile } from 'node:fs/promises';

import {
  FOLD_CARRYOVER_WIRE_TYPES,
  FOLD_RELEVANT_WIRE_TYPES,
  foldWireRecords,
  isRealUserInput,
  type AgentReplayRecord as V2AgentReplayRecord,
  type ContextMessage as V2ContextMessage,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import type { ContextMessage } from '#/context';
import {
  isAgentReplayUserTurnMessage,
  limitAgentReplayByTurns,
  type AgentReplayRecord,
} from '#/replay';

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
  readonly userTurnCount?: number;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

export async function foldAgentWireReplay(
  wirePath: string,
  turnLimit?: number,
): Promise<FoldedAgentReplay> {
  if (turnLimit === undefined) return foldAgentWireReplayFull(wirePath);
  try {
    const limited = await foldAgentWireReplayWindowed(wirePath, turnLimit);
    if (limited !== undefined) return limited;
  } catch {
    // Any windowed-scan irregularity reproduces the reference behavior below.
  }
  const full = await foldAgentWireReplayFull(wirePath);
  return {
    replay: limitAgentReplayByTurns(full.replay, turnLimit),
    toolStore: full.toolStore,
    userTurnCount: full.userTurnCount,
  };
}

async function foldAgentWireReplayFull(wirePath: string): Promise<FoldedAgentReplay> {
  try {
    const userTurns = new UserTurnCounter();
    const records = parseWireRecords(await readFile(wirePath, 'utf-8'), userTurns);
    if (records.length === 0) return { ...EMPTY_FOLD, userTurnCount: userTurns.count };
    const folded = foldWireRecords(records);
    return {
      replay: folded.replay.map(mapReplayRecord),
      toolStore: folded.toolStore,
      userTurnCount: userTurns.count,
    };
  } catch {
    return EMPTY_FOLD;
  }
}

function mapReplayRecord(record: V2AgentReplayRecord): AgentReplayRecord {
  if (record.type === 'config_updated') {
    return {
      type: 'config_updated',
      time: record.time,
      config: {
        modelAlias: record.config.modelAlias,
        profileName: record.config.profileName,
        thinkingEffort: record.config.thinkingLevel,
        systemPrompt: record.config.systemPrompt,
      },
    };
  }
  return record as unknown as AgentReplayRecord;
}

function parseWireRecords(content: string, userTurns: UserTurnCounter): WireRecord[] {
  const lines = content.split('\n');
  const records: WireRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      const record = JSON.parse(line) as WireRecord;
      userTurns.observe(record, index);
      records.push(record);
    } catch (error) {
      if (index === lines.length - 1) {
        userTurns.invalidate();
        break;
      }
      throw error;
    }
  }
  return records;
}

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const TYPE_PREFIX = '{"type":"';
const TYPE_MARKER = '"type":"';
const TYPE_MARKER_BYTES = Buffer.from(TYPE_MARKER);
const RELEVANT_TYPE_PREFIXES = [
  'context.',
  'goal.',
  'full_compaction.',
  'plan_mode.',
  'config.update',
  'permission.',
  'tools.update_store',
  'forked',
];
const CARRYOVER_TYPE_PREFIXES = ['goal.', 'tools.update_store', 'forked'];
const HEAD_TYPE_PREFIXES = [...CARRYOVER_TYPE_PREFIXES, 'turn.prompt', 'context.append_message'];
const HEAD_HEADER_BYTES =
  TYPE_PREFIX.length + Math.max(...HEAD_TYPE_PREFIXES.map((prefix) => prefix.length));

class UserTurnCounter {
  private total = 0;
  private reliable = true;
  private firstPromptStart = Infinity;
  private firstUserMessageStart = Infinity;

  get count(): number | undefined {
    return this.reliable && this.firstUserMessageStart >= this.firstPromptStart
      ? this.total
      : undefined;
  }

  invalidate(): void {
    this.reliable = false;
  }

  observeLine(bytes: Buffer, start: number): void {
    const line = decodeLine(bytes);
    if (line.length === 0) return;
    try {
      this.observe(JSON.parse(line) as WireRecord, start);
    } catch {
      this.invalidate();
    }
  }

  observe(record: WireRecord, start: number): void {
    if (record === null || typeof record !== 'object') {
      this.invalidate();
      return;
    }
    if (record['type'] === 'context.append_message') {
      const message = record['message'] as V2ContextMessage | undefined;
      if (
        message?.role === 'user' &&
        (message.origin === undefined || message.origin === null || isRealUserInput(message))
      ) {
        this.firstUserMessageStart = Math.min(this.firstUserMessageStart, start);
      }
      return;
    }
    if (record['type'] !== 'turn.prompt') return;
    this.firstPromptStart = Math.min(this.firstPromptStart, start);
    const userOrigin = isUserTurnOrigin(record['origin']);
    if (userOrigin === undefined) this.invalidate();
    else if (userOrigin) this.total += 1;
  }
}

function isUserTurnOrigin(origin: unknown): boolean | undefined {
  if (origin === null || typeof origin !== 'object' || !('kind' in origin)) return undefined;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      if (!('trigger' in origin) || typeof origin.trigger !== 'string') return undefined;
      return origin.trigger === 'user-slash';
    case 'shell_command':
      if (!('phase' in origin) || typeof origin.phase !== 'string') return undefined;
      return origin.phase === 'input';
    case 'cron_job':
    case 'cron_missed':
    case 'system_trigger':
    case 'task':
    case 'background_task':
    case 'hook_result':
    case 'compaction_summary':
    case 'injection':
    case 'retry':
      return false;
    default:
      return undefined;
  }
}

interface ScannedRecord {
  readonly start: number;
  readonly record: WireRecord;
}

// Folds exactly the records that the full fold truncated to the last
// `turnLimit` user turns would produce: the raw-record window starting at the
// Nth-from-last turn-start append (extended back over an open step / pending
// tool calls to the last pending-clearing record), plus every earlier
// FOLD_CARRYOVER record so toolStore and goal state survive the window.
// Returns undefined when the window cannot be proven equivalent.
async function foldAgentWireReplayWindowed(
  wirePath: string,
  turnLimit: number,
): Promise<FoldedAgentReplay | undefined> {
  const handle = await open(wirePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) return { ...EMPTY_FOLD, userTurnCount: 0 };
    const scan = new WireReplayScan(turnLimit);
    let carry = Buffer.alloc(0);
    let pos = size;
    let tailChunk = true;
    const readChunk = async (start: number, length: number) => {
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      return chunk.subarray(0, bytesRead);
    };
    let start = Math.max(0, pos - SCAN_CHUNK_BYTES);
    let pending = readChunk(start, pos - start);
    while (true) {
      const view = await pending;
      pos = start;
      let following: ReturnType<typeof readChunk> | undefined;
      if (pos > 0) {
        start = Math.max(0, pos - SCAN_CHUNK_BYTES);
        following = readChunk(start, pos - start);
      }
      const firstNl = view.indexOf(0x0a);
      if (firstNl < 0) {
        carry = carry.length === 0 ? Buffer.from(view) : Buffer.concat([view, carry]);
      } else {
        scan.processChunk(view, firstNl + 1, carry, pos, tailChunk && view.at(-1) !== 0x0a);
        carry = view.subarray(0, firstNl);
      }
      if (pos === 0) break;
      pending = following!;
      tailChunk = false;
    }
    return scan.finish(carry);
  } finally {
    await handle.close();
  }
}

class WireReplayScan {
  private mode: 'boundary' | 'extend' | 'head';
  private found = 0;
  private skip = 0;
  private endsAfter = 0;
  private beginsAfter = 0;
  private balanceAtBoundary = 0;
  private boundaryStart = -1;
  private windowStart = -1;
  private walkStepBalance = 0;
  private readonly walkCalls = new Set<string>();
  private readonly walkResults = new Set<string>();
  private readonly windowLines: ScannedRecord[] = [];
  private readonly seeds: ScannedRecord[] = [];
  private readonly legacyCompactionStarts: number[] = [];
  private readonly userTurns = new UserTurnCounter();

  constructor(private readonly turnLimit: number) {
    this.mode = turnLimit > 0 ? 'boundary' : 'head';
  }

  processChunk(
    view: Buffer,
    from: number,
    tailFragment: Buffer,
    dataFileStart: number,
    tolerateTailLine: boolean,
  ): void {
    if (this.mode === 'head') {
      this.scanHeadRegion(view, from, view.length, tailFragment, dataFileStart, tolerateTailLine);
      return;
    }
    let end = view.length;
    let tailLine = true;
    while (end > from) {
      const nl = view.lastIndexOf(0x0a, end - 1);
      const lineStart = nl < from ? from : nl + 1;
      const joined =
        tailLine && tailFragment.length > 0
          ? Buffer.concat([view.subarray(lineStart, end), tailFragment])
          : view.subarray(lineStart, end);
      this.processLine(dataFileStart + lineStart, joined, tailLine && tolerateTailLine);
      const mode = this.mode as 'boundary' | 'extend' | 'head';
      if (mode === 'head') {
        this.scanHeadRegion(view, from, lineStart, EMPTY_BUFFER, dataFileStart);
        return;
      }
      tailLine = false;
      end = nl < from ? from : nl;
    }
  }

  finish(firstLineBytes: Buffer): FoldedAgentReplay | undefined {
    const firstLine = decodeLine(firstLineBytes);
    if (firstLine.length === 0) return undefined;
    let firstRecord: WireRecord;
    try {
      firstRecord = JSON.parse(firstLine) as WireRecord;
    } catch {
      return EMPTY_FOLD;
    }
    this.userTurns.observe(firstRecord, 0);
    const boundaryFound = this.boundaryStart >= 0;
    const windowStart = this.mode === 'head' ? this.windowStart : boundaryFound ? 0 : -1;
    if (
      boundaryFound &&
      windowStart > 0 &&
      this.legacyCompactionStarts.some((start) => start >= windowStart)
    ) {
      return undefined;
    }
    const records: WireRecord[] = [firstRecord];
    const seeds = this.seeds.toSorted((a, b) => a.start - b.start);
    for (const seed of seeds) {
      records.push(seed.record);
    }
    for (let index = this.windowLines.length - 1; index >= 0; index--) {
      const line = this.windowLines[index]!;
      if (line.start < windowStart) continue;
      records.push(line.record);
    }
    const folded = foldWireRecords(records);
    if (!boundaryFound || windowStart <= 0) {
      return {
        replay: limitAgentReplayByTurns(folded.replay.map(mapReplayRecord), this.turnLimit),
        toolStore: folded.toolStore,
        userTurnCount: this.userTurns.count,
      };
    }
    const turnStarts = folded.replay.flatMap((record, index) =>
      record.type === 'message' &&
      isAgentReplayUserTurnMessage(record.message as unknown as ContextMessage)
        ? [index]
        : [],
    );
    if (turnStarts.length < this.turnLimit) return undefined;
    return {
      replay: folded.replay
        .slice(turnStarts[turnStarts.length - this.turnLimit])
        .map(mapReplayRecord),
      toolStore: folded.toolStore,
      userTurnCount: this.userTurns.count,
    };
  }

  private processLine(start: number, joined: Buffer, tolerate: boolean): void {
    const sniffed = sniffWireTypeBytes(joined);
    if (
      sniffed === 'turn.prompt' ||
      (sniffed === undefined && !hasRelevantMarkerBytes(joined))
    ) {
      this.userTurns.observeLine(joined, start);
      return;
    }
    if (sniffed !== undefined && !FOLD_RELEVANT_WIRE_TYPES.has(sniffed)) {
      if (tolerate) this.userTurns.observeLine(joined, start);
      return;
    }
    const record = parseJsonLine(decodeLine(joined), tolerate);
    if (record === undefined) {
      this.userTurns.invalidate();
      return;
    }
    this.userTurns.observe(record, start);
    const parsedType = record['type'];
    const type = typeof parsedType === 'string' ? parsedType : sniffed;
    if (type === undefined || !FOLD_RELEVANT_WIRE_TYPES.has(type)) return;
    this.windowLines.push({ start, record });
    if (this.mode === 'boundary') this.processBoundaryLine(type, start, record);
    else this.processExtendLine(type, start, record);
  }

  private processBoundaryLine(type: string, start: number, record: WireRecord): void {
    switch (type) {
      case 'context.append_message': {
        const message = record['message'] as V2ContextMessage;
        if (this.skip > 0) {
          if (isRealUserInput(message)) this.skip--;
          return;
        }
        if (isAgentReplayUserTurnMessage(message as unknown as ContextMessage)) {
          this.found++;
          if (this.found === this.turnLimit) {
            this.boundaryStart = start;
            this.balanceAtBoundary = this.endsAfter - this.beginsAfter;
            this.mode = 'extend';
          }
        }
        return;
      }
      case 'context.undo': {
        const count = record['count'];
        if (typeof count === 'number' && count > 0) this.skip += count;
        return;
      }
      case 'context.clear':
        this.skip = 0;
        return;
      case 'context.apply_compaction':
        this.skip = 0;
        this.noteCompaction(record, start);
        return;
      case 'context.append_loop_event': {
        const event = record['event'] as { readonly type?: string };
        if (event.type === 'step.end') this.endsAfter++;
        else if (event.type === 'step.begin') this.beginsAfter++;
        return;
      }
      default:
        return;
    }
  }

  private processExtendLine(type: string, start: number, record: WireRecord): void {
    switch (type) {
      case 'context.append_loop_event': {
        const event = record['event'] as {
          readonly type?: string;
          readonly toolCallId?: unknown;
        };
        if (event.type === 'step.end') {
          this.walkStepBalance++;
        } else if (event.type === 'step.begin') {
          if (this.walkStepBalance > 0) this.walkStepBalance--;
          this.finishExtend(start);
        } else if (event.type === 'tool.call') {
          if (typeof event.toolCallId === 'string') this.walkCalls.add(event.toolCallId);
        } else if (event.type === 'tool.result') {
          if (typeof event.toolCallId === 'string') this.walkResults.add(event.toolCallId);
        }
        return;
      }
      case 'context.undo':
      case 'context.clear':
        this.finishExtend(start);
        return;
      case 'context.apply_compaction':
        this.noteCompaction(record, start);
        this.finishExtend(start);
        return;
      default:
        return;
    }
  }

  private noteCompaction(record: WireRecord, start: number): void {
    if (
      typeof record['tokensAfter'] !== 'number' ||
      typeof record['keptUserMessageCount'] !== 'number'
    ) {
      this.legacyCompactionStarts.push(start);
    }
  }

  private finishExtend(clearingStart: number): void {
    const hasPending = [...this.walkCalls].some((id) => !this.walkResults.has(id));
    this.windowStart =
      this.balanceAtBoundary > 0 || hasPending ? clearingStart : this.boundaryStart;
    this.mode = 'head';
  }

  private scanHeadRegion(
    view: Buffer,
    from: number,
    to: number,
    tailFragment: Buffer,
    dataFileStart: number,
    tolerateTailLine = false,
  ): void {
    let lineStart = from;
    while (lineStart < to) {
      let lineEnd = view.indexOf(0x0a, lineStart);
      if (lineEnd < 0 || lineEnd > to) lineEnd = to;
      const lastLine = lineEnd === to;
      const canonical = startsWithTypePrefix(view, lineStart);
      const selected = canonical
        ? hasTypePrefixAt(view, lineStart + TYPE_PREFIX.length, HEAD_TYPE_PREFIXES)
        : hasTypeMarker(view, lineStart, lineEnd, HEAD_TYPE_PREFIXES);
      if (selected || !canonical || (lastLine && tolerateTailLine)) {
        const bytes =
          lastLine && tailFragment.length > 0
            ? Buffer.concat([view.subarray(lineStart, lineEnd), tailFragment])
            : view.subarray(lineStart, lineEnd);
        if (!selected) {
          this.userTurns.observeLine(bytes, dataFileStart + lineStart);
          if (lastLine) return;
          lineStart = lineEnd + 1;
          continue;
        }
        let record: WireRecord;
        try {
          record = JSON.parse(decodeLine(bytes)) as WireRecord;
        } catch (error) {
          if (
            startsWithTypePrefix(bytes, 0)
              ? hasTypePrefixAt(bytes, TYPE_PREFIX.length, CARRYOVER_TYPE_PREFIXES)
              : hasTypeMarker(bytes, 0, bytes.length, CARRYOVER_TYPE_PREFIXES)
          ) {
            throw error;
          }
          this.userTurns.invalidate();
          if (lastLine) return;
          lineStart = lineEnd + 1;
          continue;
        }
        this.userTurns.observe(record, dataFileStart + lineStart);
        const recordType = record['type'];
        if (typeof recordType === 'string' && FOLD_CARRYOVER_WIRE_TYPES.has(recordType)) {
          this.seeds.push({ start: dataFileStart + lineStart, record });
        }
      } else if (
        lastLine &&
        tailFragment.length > 0 &&
        lineEnd - lineStart < HEAD_HEADER_BYTES
      ) {
        this.userTurns.observeLine(
          Buffer.concat([view.subarray(lineStart, lineEnd), tailFragment]),
          dataFileStart + lineStart,
        );
      }
      if (lastLine) return;
      lineStart = lineEnd + 1;
    }
  }
}

const EMPTY_BUFFER = Buffer.alloc(0);

function sniffWireTypeBytes(data: Buffer): string | undefined {
  if (!startsWithBytes(data, 0, TYPE_PREFIX)) return undefined;
  const end = data.indexOf(0x22, TYPE_PREFIX.length);
  return end < 0 ? undefined : data.subarray(TYPE_PREFIX.length, end).toString('utf-8');
}

function hasRelevantMarkerBytes(data: Buffer): boolean {
  let from = 0;
  for (;;) {
    const hit = data.indexOf(TYPE_MARKER_BYTES, from);
    if (hit < 0) return false;
    if (hasTypePrefixAt(data, hit + TYPE_MARKER.length, RELEVANT_TYPE_PREFIXES)) return true;
    from = hit + 1;
  }
}

function decodeLine(bytes: Buffer): string {
  const raw = bytes.toString('utf-8');
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

function parseJsonLine(line: string, tolerate: boolean): WireRecord | undefined {
  try {
    return JSON.parse(line) as WireRecord;
  } catch (error) {
    if (tolerate) return undefined;
    throw error;
  }
}

function startsWithTypePrefix(data: Buffer, start: number): boolean {
  return startsWithBytes(data, start, TYPE_PREFIX);
}

function hasTypePrefixAt(data: Buffer, start: number, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (startsWithBytes(data, start, prefix)) return true;
  }
  return false;
}

function hasTypeMarker(
  data: Buffer,
  start: number,
  end: number,
  prefixes: readonly string[],
): boolean {
  let from = start;
  for (;;) {
    const hit = data.indexOf(TYPE_MARKER_BYTES, from);
    if (hit < 0 || hit >= end) return false;
    if (hasTypePrefixAt(data, hit + TYPE_MARKER.length, prefixes)) return true;
    from = hit + 1;
  }
}

function startsWithBytes(data: Buffer, start: number, text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (data[start + index] !== text.codePointAt(index)) return false;
  }
  return true;
}
