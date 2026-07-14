/**
 * `loop` domain (L4) — the step queue held by `AgentLoopService`.
 *
 * Turn-owned FIFO with head insertion: senders enqueue `StepRequest`s (tail
 * for ordered work, head for retries of a failed step), and one Turn drains
 * its queue one batch per step. A batch is one *driver* (the first
 * non-mergeable request) plus every *mergeable* request folded into the
 * driver's step — this is how steers land in the same LLM request as pending
 * tool results or a fresh prompt instead of each costing its own step. Extra
 * non-mergeable requests stay queued and drive later steps. Aborted requests
 * are discarded when reached, leaving the context untouched. When a run ends,
 * turn-scoped requests are aborted while agent-scoped requests (steers) carry
 * into the next turn.
 */

import type { StepRequest } from './stepRequest';

export interface StepRequestBatch {
  readonly driver: StepRequest;
  readonly merged: readonly StepRequest[];
}

export class StepRequestQueue {
  private readonly items: StepRequest[] = [];

  enqueue(request: StepRequest, at: 'head' | 'tail' = 'tail'): void {
    if (at === 'head') {
      this.items.unshift(request);
    } else {
      this.items.push(request);
    }
  }

  hasPendingRequests(): boolean {
    return this.items.some((item) => !item.aborted);
  }

  takeNextBatch(): StepRequestBatch | undefined {
    this.discardAborted();
    if (this.items.length === 0) return undefined;

    let driverIndex = this.items.findIndex((item) => !item.mergeable);
    if (driverIndex < 0) driverIndex = 0;
    const driver = this.items[driverIndex]!;

    const merged: StepRequest[] = [];
    const rest: StepRequest[] = [];
    this.items.forEach((item, index) => {
      if (index === driverIndex) return;
      (item.mergeable ? merged : rest).push(item);
    });
    this.items.length = 0;
    this.items.push(...rest);
    return { driver, merged };
  }

  drain(): StepRequest[] {
    return this.items.splice(0);
  }

  abortTurnScoped(): void {
    for (const item of this.items) {
      if (item.turnScoped) item.abort();
    }
    this.discardAborted();
  }

  private discardAborted(): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]!.aborted) this.items.splice(index, 1);
    }
  }
}
