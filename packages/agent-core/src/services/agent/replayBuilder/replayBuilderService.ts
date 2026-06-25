import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../../../rpc/resumed';

import type { ContextMessage, WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IReplayBuilderService,
  type ReplayBuilderServiceOptions,
} from './replayBuilder';

// An undo boundary is a `context.splice` that removes messages from the start of
// the history. It is the canonical (post v1.5 migration) equivalent of the legacy
// `context.clear` and `context.apply_compaction` records, both of which the v1.5
// migration rewrites into a `context.splice` with `start === 0` and
// `deleteCount > 0` (see wireRecord/migration/v1.5.ts). A splice that only
// appends (`deleteCount === 0`) or removes messages from the middle/end of the
// history (`start > 0`, e.g. a migrated `context.undo`) is not a boundary.
function isUndoBoundaryRecord(record: WireRecord): boolean {
  return record.type === 'context.splice' && record.start === 0 && record.deleteCount > 0;
}

export class ReplayBuilderService extends Disposable implements IReplayBuilderService {
  declare readonly _serviceBrand: undefined;

  captureLiveRecords = false;

  private readonly records: AgentReplayRecord[] = [];
  private _postRestoring = false;
  private frozen = false;
  private segmentStart = 0;

  constructor(
    private readonly options: ReplayBuilderServiceOptions = {},
    @IWireRecord private readonly wireRecord: IWireRecord,
  ) {
    super();
    this._register(
      wireRecord.hooks.onRestoredRecord.register('replay-builder', async (context, next) => {
        await next();
        if (this.finishRestoringRecord(context.record)) {
          context.stop = true;
        }
      }),
    );
  }

  get postRestoring(): boolean {
    return this._postRestoring || this.wireRecord.postRestoring;
  }

  set postRestoring(value: boolean) {
    this._postRestoring = value;
  }

  push(record: AgentReplayRecordPayload): void {
    if (
      !this.captureLiveRecords &&
      this.wireRecord.restoring === null &&
      !this.postRestoring
    ) {
      return;
    }
    if (this.frozen) return;

    this.records.push({
      ...record,
      time: this.wireRecord.restoring?.time ?? Date.now(),
    });
  }

  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void {
    if (this.frozen) return;
    if (this.wireRecord.restoring === null) return;

    const last = this.records.at(-1);
    if (last?.type === type) {
      Object.assign(last, patch);
    }
  }

  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (this.frozen) return;
    if (removedMessages.size === 0) return;
    this.removeMessagesFrom(this.records, removedMessages);
  }

  finishRestoringRecord(record: WireRecord): boolean {
    const range = this.options.range;
    if (range === undefined) return false;
    if (this.frozen) return true;
    if (!isUndoBoundaryRecord(record)) return false;
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
    const range = this.options.range;
    if (range !== undefined) {
      if (range.start === undefined && range.count !== undefined) {
        const offset = Math.max(0, this.records.length - range.count);
        return this.records.slice(offset);
      }
      const start = range.start ?? 0;
      const offset = Math.max(0, start - this.segmentStart);
      const count = range.count;
      const end = count === undefined ? undefined : offset + count;
      return this.records.slice(offset, end);
    }
    return this.records;
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

registerSingleton(
  IReplayBuilderService,
  new SyncDescriptor(ReplayBuilderService, [{}], true),
);
