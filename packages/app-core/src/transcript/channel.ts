import {
  AgentTranscript,
  type AgentDescriptor,
  type AgentTranscriptSnapshot,
  type TranscriptItem,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { SessionTranscriptPage } from '../api/types';

export interface TranscriptChannelOptions {
  sessionId: string;
  agentId: string;
  fetchPage: (query: {
    beforeTurn?: string;
    afterTurn?: string;
    pageSize?: number;
  }) => Promise<SessionTranscriptPage>;
  pageSize?: number;
  onChange?: () => void;
  onGap?: () => void;
  /** Fired when the transcript window is REPLACED (refresh re-anchor or a
   *  server-pushed reset) — not when an older history page merges in.
   *  Consumers keying local state off frame ids (which an undo rewind
   *  reuses) must drop that state here. */
  onReset?: () => void;
}

export class TranscriptChannel {
  readonly transcript: AgentTranscript;
  readonly sessionId: string;
  readonly agentId: string;

  private readonly fetchPage: TranscriptChannelOptions['fetchPage'];
  private readonly pageSize: number;
  private readonly onChange?: () => void;
  private readonly onGap?: () => void;
  private readonly onReset?: () => void;
  private refreshPromise: Promise<void> | null = null;
  private buffered: Array<{ ops: readonly TranscriptOperation[]; seq?: number }> = [];
  private agents_: readonly AgentDescriptor[] = [];
  private seq_: number | undefined;
  private loadingOlder_ = false;
  private loadOlderError_ = false;
  private refreshError_ = false;

  constructor(options: TranscriptChannelOptions) {
    this.sessionId = options.sessionId;
    this.agentId = options.agentId;
    this.transcript = new AgentTranscript(options.agentId);
    this.fetchPage = options.fetchPage;
    this.pageSize = options.pageSize ?? 20;
    this.onChange = options.onChange;
    this.onGap = options.onGap;
    this.onReset = options.onReset;
  }

  get snapshot(): AgentTranscriptSnapshot {
    return this.transcript.snapshot();
  }

  get seq(): number | undefined {
    return this.seq_;
  }

  get agents(): readonly AgentDescriptor[] {
    return this.agents_;
  }

  get loading(): boolean {
    return this.refreshPromise !== null;
  }

  get loadingOlder(): boolean {
    return this.loadingOlder_ || this.loadOlderTask_ !== undefined;
  }

  get loadOlderError(): boolean {
    return this.loadOlderError_;
  }

  get refreshError(): boolean {
    return this.refreshError_;
  }

  /** The single serial read chain: refresh and history pagination register
   *  onto it SYNCHRONOUSLY at call time, so the "is the other read in
   *  flight" check can never be evaluated before the other side has
   *  registered — the failure mode where a refresh and a pagination started
   *  in the same tick both proceed and the older page overwrites the fresh
   *  state. Buffered ops replay INSIDE the chain's critical section (after
   *  the read's own page lands), never interleaved with a queued read. */
  private readChain: Promise<void> = Promise.resolve();

  private enqueueRead(work: () => Promise<void>, onSettled: () => void): Promise<void> {
    const task = this.readChain.then(work).finally(() => {
      onSettled();
      const buffered = this.buffered;
      this.buffered = [];
      for (const batch of buffered) this.applyOps(batch.ops, batch.seq);
      this.onChange?.();
    });
    this.readChain = task.catch(() => undefined);
    return task;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshError_ = false;
    const task = this.enqueueRead(async () => {
      try {
        const page = await this.fetchPage({ pageSize: this.pageSize });
        this.applyPage(page, true);
      } catch (error) {
        this.refreshError_ = true;
        throw error;
      }
    }, () => {
      this.refreshPromise = null;
    });
    this.refreshPromise = task;
    this.onChange?.();
    return task;
  }

  receiveReset(snapshot: AgentTranscriptSnapshot, seq?: number): void {
    this.transcript.receive([{ op: 'reset', agentId: this.agentId, snapshot }]);
    if (seq !== undefined) this.seq_ = seq;
    this.refreshError_ = false;
    this.onReset?.();
    this.onChange?.();
  }

  applyOps(ops: readonly TranscriptOperation[], seq?: number): boolean {
    if (this.refreshPromise !== null || this.loadingOlder) {
      this.buffered.push({ ops, ...(seq !== undefined ? { seq } : {}) });
      return false;
    }
    if (seq !== undefined && this.seq_ !== undefined) {
      if (seq <= this.seq_) return true;
      if (seq !== this.seq_ + 1) {
        this.onGap?.();
        return false;
      }
    }
    const result = this.transcript.apply(ops);
    if (seq !== undefined) this.seq_ = seq;
    if (result.gap !== undefined) this.onGap?.();
    if (result.accepted.length > 0) this.onChange?.();
    return result.gap === undefined;
  }

  private loadOlderTask_: Promise<void> | undefined;

  async loadOlder(): Promise<void> {
    if (!this.snapshot.hasMoreOlder || this.loadingOlder) return;
    const task = this.enqueueRead(async () => {
      // The anchor is chosen INSIDE the serial read: a refresh (or undo
      // rewind) that beat this read's queue slot can't slip a stale anchor
      // or a stale older page past the fresh window.
      if (!this.snapshot.hasMoreOlder) return;
      const firstTurn = this.snapshot.items.find((item) => item.kind === 'turn');
      if (firstTurn?.kind !== 'turn') return;
      this.loadingOlder_ = true;
      this.loadOlderError_ = false;
      this.onChange?.();
      try {
        const page = await this.fetchPage({
          beforeTurn: firstTurn.turnId,
          pageSize: this.pageSize,
        });
        this.applyPage(page, false);
      } catch (error) {
        this.loadOlderError_ = true;
        throw error;
      }
    }, () => {
      this.loadingOlder_ = false;
      this.loadOlderTask_ = undefined;
    });
    this.loadOlderTask_ = task;
    try {
      await task;
    } finally {
      if (this.loadOlderTask_ === task) this.loadOlderTask_ = undefined;
    }
  }


  /** Join the in-flight older-page read: a post-undo refresh must order AFTER
   *  it — a pre-undo page merging afterwards would resurrect rewound items. */
  settleOlder(): Promise<void> {
    return this.loadOlderTask_ ?? Promise.resolve();
  }

  private applyPage(page: SessionTranscriptPage, replace: boolean): void {
    this.agents_ = page.agents;
    const current = this.snapshot;
    if (replace) {
      this.receiveReset(page, page.seq);
      return;
    }
    // An older page MERGES into the window: the live tail survives, so
    // frame-id-keyed local state stays valid (no onReset) — and its
    // watermark must not supersede buffered ops that still need to update
    // the current items (no seq advance).
    const merged: AgentTranscriptSnapshot = {
      ...page,
      items: mergeItems(page.items, current.items),
      hasMoreOlder: page.hasMoreOlder,
    };
    this.transcript.receive([{ op: 'reset', agentId: this.agentId, snapshot: merged }]);
    this.refreshError_ = false;
    this.onChange?.();
  }
}

function mergeItems(
  older: readonly TranscriptItem[],
  current: readonly TranscriptItem[],
): TranscriptItem[] {
  const ids = new Set<string>();
  const merged: TranscriptItem[] = [];
  for (const item of [...older, ...current]) {
    const id =
      item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId;
    if (ids.has(id)) continue;
    ids.add(id);
    merged.push(item);
  }
  return merged;
}
