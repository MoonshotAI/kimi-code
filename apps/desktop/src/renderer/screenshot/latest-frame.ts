export class LatestFrameScheduler<T> {
  private pending: T | null = null;
  private frame: number | null = null;

  constructor(
    private readonly commit: (value: T) => void,
    private readonly requestFrame: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
    private readonly cancelFrame: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
  ) {}

  schedule(value: T): void {
    this.pending = value;
    if (this.frame !== null) return;
    this.frame = this.requestFrame(this.run);
  }

  flushPending(): void {
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.run();
  }

  cancel(): void {
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.pending = null;
  }

  private readonly run = (): void => {
    this.frame = null;
    const value = this.pending;
    this.pending = null;
    if (value !== null) this.commit(value);
  };
}
