import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'pathe';

import { syncDir } from '#/utils/fs';

export const PENDING_MAX = 1000;
const STDERR_NOTICE_INTERVAL_MS = 30_000;

class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    // Swallow rejection on the tail to prevent unhandled rejection in the
    // serial chain — the actual error surfaces through the returned `next`
    // promise which the caller awaits.
    this.tail = next.catch(() => { /* intentional — serial queue tail guard */ });
    return next;
  }
}
export interface Sink {
  enqueue(line: string): void;
  /** Resolves to false when the pending batch could not be written. */
  flush(): Promise<boolean>;
  close(): Promise<void>;
  flushSync(): void;
}

interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly files: number;
}

export class RotatingFileSink implements Sink {
  private readonly queue = new AsyncSerialQueue();
  private pending: string[] = [];
  private dropped = 0;
  private closed = false;
  private lastStderrNotice = 0;
  private currentBytes = -1;
  private directorySynced = false;
  /** Lines taken from `pending` by `drain()` but not yet confirmed written.
   *  `flushSync()` uses this to avoid losing the last batch when the process
   *  exits while an async drain is in flight (the event loop stops, so the
   *  drain's pending `await`s never resume). */
  private inFlight: string[] | undefined;

  constructor(private readonly options: RotatingFileSinkOptions) {}

  enqueue(line: string): void {
    if (this.closed) return;
    if (this.pending.length >= PENDING_MAX) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(line);
    this.scheduleDrain();
  }

  async flush(): Promise<boolean> {
    return this.queue.run(() => this.drain());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } catch {
      // swallow — close must not throw
    }
  }

  flushSync(): void {
    if (this.closed) return;
    const hasPending = this.pending.length > 0;
    const hasInFlight = this.inFlight !== undefined && this.inFlight.length > 0;
    if (!hasPending && !hasInFlight) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const parts: string[] = [];
      // In-flight lines may have been partially written by the async drain —
      // duplicate lines are preferable to data loss on exit.
      if (hasInFlight) parts.push(this.inFlight!.join(''));
      if (hasPending) {
        parts.push(this.pending.join(''));
        parts.push(this.takeDroppedNotice());
      }
      this.pending = [];
      this.inFlight = undefined;
      appendFileSync(this.options.path, parts.join(''));
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed || this.pending.length === 0) return;
      this.queue.run(() => this.drain()).catch(() => {});
    });
  }

  private async drain(): Promise<boolean> {
    if (this.pending.length === 0) return true;
    const droppedLine = this.takeDroppedNotice();
    const lines = droppedLine === '' ? [...this.pending] : [...this.pending, droppedLine];
    this.pending = [];
    this.inFlight = lines;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      if (this.currentBytes < 0) {
        this.currentBytes = await this.statSize(this.options.path);
      }
      await this.appendLines(lines);

      if (!this.directorySynced) {
        await syncDir(dirname(this.options.path));
        this.directorySynced = true;
      }

      this.inFlight = undefined;
      return true;
    } catch (error) {
      this.noteFailure(error);
      this.inFlight = undefined;
      this.restorePending(lines);
      return false;
    }
  }

  private restorePending(lines: readonly string[]): void {
    const restored = [...lines, ...this.pending];
    const overflow = restored.length - PENDING_MAX;
    if (overflow <= 0) {
      this.pending = restored;
      return;
    }
    this.dropped += overflow;
    this.pending = restored.slice(overflow);
  }

  private async appendLines(lines: readonly string[]): Promise<void> {
    let chunk = '';
    let chunkBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (
        chunkBytes > 0 &&
        (chunkBytes + lineBytes > this.options.maxBytes ||
          this.currentBytes + chunkBytes + lineBytes > this.options.maxBytes)
      ) {
        await this.appendChunk(chunk);
        chunk = '';
        chunkBytes = 0;
      }

      if (
        chunkBytes === 0 &&
        this.currentBytes > 0 &&
        this.currentBytes + lineBytes > this.options.maxBytes
      ) {
        await this.rotate();
      }

      chunk += line;
      chunkBytes += lineBytes;
    }
    if (chunkBytes > 0) {
      await this.appendChunk(chunk);
    }
  }

  private async appendChunk(chunk: string): Promise<void> {
    const fh = await open(this.options.path, 'a');
    try {
      await fh.appendFile(chunk, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.currentBytes += Buffer.byteLength(chunk, 'utf-8');
    if (this.currentBytes >= this.options.maxBytes) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    const { path, files } = this.options;
    for (let i = files - 2; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await rename(path, `${path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // last archive may be evicted; ensure we don't keep > files
    try {
      await unlink(`${path}.${files}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.currentBytes = 0;
    this.directorySynced = false;
  }

  private async statSize(p: string): Promise<number> {
    try {
      const s = await stat(p);
      return s.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private takeDroppedNotice(): string {
    if (this.dropped === 0) return '';
    const line = `... dropped ${this.dropped} entries ...\n`;
    this.dropped = 0;
    return line;
  }

  private noteFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastStderrNotice < STDERR_NOTICE_INTERVAL_MS) return;
    this.lastStderrNotice = now;
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    try {
      process.stderr.write(`[logger] write failed: ${code}\n`);
    } catch {
      // stderr itself is unavailable — nothing left to fall back on.
    }
  }
}
