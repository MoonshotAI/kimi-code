export const TASK_EVENT_BATCH_MS = 1_000;
export const TASK_EVENT_MAX_LINE_CHARS = 2_000;
export const TASK_EVENT_MAX_BATCH_LINES = 50;
export const TASK_EVENT_RATE_WINDOW_MS = 60_000;
export const TASK_EVENT_MAX_LINES_PER_WINDOW = 300;

export interface TaskEventBatch {
  readonly seq: number;
  readonly lines: readonly string[];
  readonly omitted: number;
}

export interface TaskEventStreamHost {
  deliver(batch: TaskEventBatch, settled: () => void): void;
  overflow(): void;
}

export class TaskEventStream {
  private partial = '';
  private discarding = false;
  private pending: string[] = [];
  private omitted = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  private windowStartedAt = 0;
  private windowLines = 0;
  private closed = false;

  constructor(
    private readonly host: TaskEventStreamHost,
    private readonly now: () => number = Date.now,
  ) {}

  get hasQueuedBatch(): boolean {
    return this.inFlight > 0;
  }

  append(chunk: string): void {
    if (this.closed) return;
    let text = chunk;
    if (this.discarding) {
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      this.discarding = false;
      text = text.slice(newline + 1);
    }
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    if (this.partial.length > TASK_EVENT_MAX_LINE_CHARS) {
      lines.push(this.partial);
      this.partial = '';
      this.discarding = true;
    }
    for (const line of lines) {
      if (!this.push(line)) return;
    }
  }

  close(): void {
    if (this.closed) return;
    const tail = this.partial;
    this.partial = '';
    if (tail.length > 0) this.push(tail);
    this.closed = true;
    this.clearTimer();
    this.flush();
  }

  dispose(): void {
    this.closed = true;
    this.clearTimer();
    this.pending = [];
  }

  private push(raw: string): boolean {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return true;
    if (!this.withinRate()) {
      this.closed = true;
      this.clearTimer();
      this.flush();
      this.host.overflow();
      return false;
    }
    this.pending.push(
      line.length > TASK_EVENT_MAX_LINE_CHARS ? `${line.slice(0, TASK_EVENT_MAX_LINE_CHARS)}…` : line,
    );
    if (this.pending.length > TASK_EVENT_MAX_BATCH_LINES) {
      this.pending.shift();
      this.omitted += 1;
    }
    this.schedule();
    return true;
  }

  private withinRate(): boolean {
    const now = this.now();
    if (now - this.windowStartedAt >= TASK_EVENT_RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.windowLines = 0;
    }
    this.windowLines += 1;
    return this.windowLines <= TASK_EVENT_MAX_LINES_PER_WINDOW;
  }

  private schedule(): void {
    if (this.closed || this.timer !== undefined || this.inFlight > 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, TASK_EVENT_BATCH_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch: TaskEventBatch = { seq: ++this.seq, lines: this.pending, omitted: this.omitted };
    this.pending = [];
    this.omitted = 0;
    this.inFlight += 1;
    let settled = false;
    this.host.deliver(batch, () => {
      if (settled) return;
      settled = true;
      this.inFlight -= 1;
      this.schedule();
    });
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
