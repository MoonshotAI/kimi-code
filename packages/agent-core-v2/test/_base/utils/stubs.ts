import type { TimeoutScheduler } from '#/_base/utils/timer';

interface ManualEntry {
  readonly handle: object;
  readonly callback: () => void;
  readonly timeoutMs: number;
  readonly dueAt: number;
  readonly seq: number;
}

export class ManualTimeoutScheduler implements TimeoutScheduler {
  private currentTime = 0;
  private nextSeq = 0;
  private readonly entries: ManualEntry[] = [];

  now(): number {
    return this.currentTime;
  }

  set(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
    const handle = {};
    this.entries.push({
      handle,
      callback,
      timeoutMs,
      dueAt: this.currentTime + timeoutMs,
      seq: ++this.nextSeq,
    });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  clear(handle: ReturnType<typeof setTimeout>): void {
    const index = this.entries.findIndex((entry) => entry.handle === handle);
    if (index !== -1) this.entries.splice(index, 1);
  }

  get size(): number {
    return this.entries.length;
  }

  scheduledTimeoutMs(index = 0): number | undefined {
    return this.entries[index]?.timeoutMs;
  }

  async advance(ms: number): Promise<void> {
    const target = this.currentTime + ms;
    for (;;) {
      const due = this.entries
        .filter((entry) => entry.dueAt <= target)
        .toSorted((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.entries.splice(this.entries.indexOf(due), 1);
      this.currentTime = due.dueAt;
      due.callback();
      await this.flushMicrotasks();
    }
    this.currentTime = target;
    await this.flushMicrotasks();
  }

  private async flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}
