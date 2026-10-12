import { randomUUID } from 'node:crypto';

import type { ResyncReason } from './protocol';
import type { TranscriptOperation } from './transcriptModel';

export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  resyncRequired: ResyncReason | false;
  currentSeq: number;
  epoch: string;
}

export interface SessionCursor {
  seq: number;
  epoch?: string;
}

export class EventJournal {
  readonly epoch: string;
  private currentSeq = 0;
  private readonly tail: Array<{ seq: number; envelope: EventEnvelope }> = [];

  constructor(private readonly maxBufferSize: number) {
    this.epoch = `ep_${randomUUID()}`;
  }

  get seq(): number {
    return this.currentSeq;
  }

  nextSeq(): number {
    this.currentSeq += 1;
    return this.currentSeq;
  }

  append(seq: number, envelope: EventEnvelope): void {
    this.tail.push({ seq, envelope });
    while (this.tail.length > this.maxBufferSize) this.tail.shift();
  }

  bufferedSince(cursor: SessionCursor): BufferedSinceResult {
    const currentSeq = this.currentSeq;
    const { epoch } = this;
    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }
    const tailStart = this.tail[0]?.seq;
    if (tailStart === undefined || tailStart > cursor.seq + 1) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }
    return {
      events: this.tail.filter((entry) => entry.seq > cursor.seq),
      resyncRequired: false,
      currentSeq,
      epoch,
    };
  }
}

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

export interface TranscriptOpsCatchup {
  readonly batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[];
  readonly latestSeq: number;
  readonly complete: boolean;
}

export class TranscriptOpsJournal {
  private nextSeq = 1;
  private readonly batches: Array<{ seq: number; ops: TranscriptOperation[] }> = [];

  get watermark(): number {
    return this.nextSeq - 1;
  }

  append(ops: readonly TranscriptOperation[]): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.batches.push({ seq, ops: [...ops] });
    if (this.batches.length > TRANSCRIPT_OPS_JOURNAL_CAPACITY) this.batches.shift();
    return seq;
  }

  since(sinceSeq: number): TranscriptOpsCatchup {
    const latestSeq = this.watermark;
    if (sinceSeq > latestSeq) return { batches: [], latestSeq, complete: false };
    const batches = this.batches.filter((batch) => batch.seq > sinceSeq);
    const oldest = this.batches[0]?.seq;
    const complete = batches.length === 0 || (oldest !== undefined && oldest <= sinceSeq + 1);
    return { batches, latestSeq, complete };
  }
}
