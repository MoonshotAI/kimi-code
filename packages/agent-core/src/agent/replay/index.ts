import type { Agent } from '..';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../../rpc/resumed';
import type { ContextMessage } from '../context';

export interface ReplayRangeOptions {
  readonly start?: number;
  readonly count?: number;
}

export interface ReplayBuilderOptions {
  readonly range?: ReplayRangeOptions;
}

interface ReplayMessageTiming {
  readonly createdAt?: number;
  readonly completedAt?: number;
}

const UNDO_BOUNDARY_RECORD_TYPES = new Set(['context.clear', 'context.apply_compaction']);

export class ReplayBuilder {
  postRestoring = false;
  captureLiveRecords = false;
  protected readonly records: AgentReplayRecord[] = [];
  private readonly messageTiming = new WeakMap<ContextMessage, ReplayMessageTiming>();
  private frozen = false;
  private segmentStart = 0;

  constructor(
    public readonly agent: Agent,
    private readonly options: ReplayBuilderOptions = {},
  ) {}

  push(record: AgentReplayRecordPayload): void {
    if (this.captureLiveRecords || this.agent.records.restoring || this.postRestoring) {
      if (this.frozen) return;
      const stamped: AgentReplayRecord = {
        ...record,
        time: this.agent.records.restoring?.time ?? Date.now(),
      };
      this.records.push(stamped);
    }
  }

  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void {
    if (this.frozen) return;
    if (this.agent.records.restoring) {
      const last = this.records.at(-1);
      if (last && last.type === type) {
        Object.assign(last, patch);
      }
    }
  }

  setMessageTiming(message: ContextMessage, timing: ReplayMessageTiming): void {
    const current = this.messageTiming.get(message);
    const createdAt = timing.createdAt ?? current?.createdAt;
    const completedAt = timing.completedAt ?? current?.completedAt;
    if (createdAt === undefined && completedAt === undefined) return;
    this.messageTiming.set(message, { createdAt, completedAt });
  }

  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (this.frozen) return;
    if (removedMessages.size === 0) return;
    this.removeMessagesFrom(this.records, removedMessages);
  }

  finishRestoringRecord(type: string): boolean {
    const range = this.options.range;
    if (range === undefined) return false;
    if (this.frozen) return true;
    if (!UNDO_BOUNDARY_RECORD_TYPES.has(type)) return false;
    if (range.start === undefined) return false;

    const start = range.start;
    const nextSegmentStart = this.segmentStart + this.records.length;
    if (nextSegmentStart > start) {
      this.frozen = true;
      return true;
    }

    this.segmentStart = nextSegmentStart;
    this.records.splice(0);
    return false;
  }

  buildResult(): readonly AgentReplayRecord[] {
    let result: readonly AgentReplayRecord[];
    const range = this.options.range;
    if (range !== undefined) {
      if (range.start === undefined && range.count !== undefined) {
        const offset = Math.max(0, this.records.length - range.count);
        result = this.records.slice(offset);
      } else {
        const start = range.start ?? 0;
        const offset = Math.max(0, start - this.segmentStart);
        const count = range.count;
        const end = count === undefined ? undefined : offset + count;
        result = this.records.slice(offset, end);
      }
    } else {
      result = this.records;
    }
    return result.map((record) => this.withMessageTiming(record));
  }

  private withMessageTiming(record: AgentReplayRecord): AgentReplayRecord {
    if (record.type !== 'message') return record;
    const timing = this.messageTiming.get(record.message);
    if (timing === undefined) return record;
    return { ...record, ...timing };
  }

  private removeMessagesFrom(
    records: AgentReplayRecord[],
    removedMessages: ReadonlySet<ContextMessage>,
  ): void {
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.type === 'message' && removedMessages.has(record.message)) {
        records.splice(i, 1);
      }
    }
  }
}
