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
}

export class TranscriptChannel {
  readonly transcript: AgentTranscript;
  readonly sessionId: string;
  readonly agentId: string;

  private readonly fetchPage: TranscriptChannelOptions['fetchPage'];
  private readonly pageSize: number;
  private readonly onChange?: () => void;
  private readonly onGap?: () => void;
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
    return this.loadingOlder_;
  }

  get loadOlderError(): boolean {
    return this.loadOlderError_;
  }

  get refreshError(): boolean {
    return this.refreshError_;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshError_ = false;
    const task = this.fetchPage({ pageSize: this.pageSize })
      .then((page) => this.applyPage(page, true))
      .catch((error: unknown) => {
        this.refreshError_ = true;
        throw error;
      })
      .finally(() => {
        this.refreshPromise = null;
        const buffered = this.buffered;
        this.buffered = [];
        for (const batch of buffered) this.applyOps(batch.ops, batch.seq);
        this.onChange?.();
      });
    this.refreshPromise = task;
    this.onChange?.();
    return task;
  }

  receiveReset(snapshot: AgentTranscriptSnapshot, seq?: number): void {
    this.transcript.receive([{ op: 'reset', agentId: this.agentId, snapshot }]);
    if (seq !== undefined) this.seq_ = seq;
    this.refreshError_ = false;
    this.onChange?.();
  }

  applyOps(ops: readonly TranscriptOperation[], seq?: number): boolean {
    if (this.refreshPromise !== null || this.loadingOlder_) {
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
    if (!this.snapshot.hasMoreOlder || this.loadingOlder_) return;
    const task = this.loadOlderTask();
    this.loadOlderTask_ = task;
    try {
      await task;
    } finally {
      if (this.loadOlderTask_ === task) this.loadOlderTask_ = undefined;
    }
  }

  private async loadOlderTask(): Promise<void> {
    // Set synchronously (this async body runs to its first await in the
    // caller's tick): ops arriving from here on buffer instead of applying
    // over the about-to-be-reanchored window.
    this.loadingOlder_ = true;
    this.loadOlderError_ = false;
    this.onChange?.();
    try {
      // A refresh in flight must commit BEFORE this read's anchor is chosen
      // and the page fetched: an older page landing over the fresh window
      // would overwrite its meta/tasks/interactions/prompts with the older
      // response's stale ones (refreshAndResumeOnce's settleOlder covers the
      // opposite direction), and a rewind (undo) would let a pre-refresh
      // anchor resurrect rewound items.
      await this.refreshPromise?.catch(() => undefined);
      if (this.snapshot.hasMoreOlder) {
        const firstTurn = this.snapshot.items.find((item) => item.kind === 'turn');
        if (firstTurn?.kind === 'turn') {
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
        }
      }
    } finally {
      this.loadingOlder_ = false;
      const buffered = this.buffered;
      this.buffered = [];
      for (const batch of buffered) this.applyOps(batch.ops, batch.seq);
      this.onChange?.();
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
    const snapshot: AgentTranscriptSnapshot = replace
      ? page
      : {
          ...page,
          items: mergeItems(page.items, current.items),
          hasMoreOlder: page.hasMoreOlder,
        };
    // An older page does not contain the live tail, so its watermark must not
    // supersede buffered ops that still need to update the current items.
    this.receiveReset(snapshot, replace ? page.seq : undefined);
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
