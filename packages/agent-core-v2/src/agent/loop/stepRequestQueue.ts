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
