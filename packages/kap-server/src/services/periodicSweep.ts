export abstract class PeriodicSweep {
  protected timer: ReturnType<typeof setInterval> | undefined;
  protected closed = false;
  private inFlight: Promise<void> | undefined;

  sweep(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.sweepOnce();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  protected schedule(intervalMs: number): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  protected abstract sweepOnce(): Promise<void>;
}
