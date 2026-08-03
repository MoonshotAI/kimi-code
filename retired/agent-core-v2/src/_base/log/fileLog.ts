/**
 * `_base/log` (L0) — plain (non-DI) log sinks.
 *
 * Owns the `RotatingFileWriter` (size-rotated, async-serial, sync-flush on
 * exit) and the `ILogWriter` implementations built on top of it (`FileLogWriter`),
 * plus the in-memory and console sinks used by tests and debugging. All classes
 * here are plain: constructed with an explicit options object, no `@IService`
 * deps, never registered with the container — a `*LogService` creates and owns
 * them. Uses `node:fs` rather than `kaos` because rotation needs atomic rename
 * and synchronous append.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

import { formatEntry, type FormatOptions } from './formatter';
import type { ILogWriter, LogEntry } from './log';

export const PENDING_MAX = 1000;
const STDERR_NOTICE_INTERVAL_MS = 30_000;

class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

export interface RotatingFileWriterOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly files: number;
}

async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export class RotatingFileWriter {
  private readonly queue = new AsyncSerialQueue();
  private pending: string[] = [];
  private dropped = 0;
  private closed = false;
  private lastStderrNotice = 0;
  private currentBytes = -1;
  private directorySynced = false;

  constructor(private readonly options: RotatingFileWriterOptions) {}

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
    }
  }

  flushSync(): void {
    if (this.closed || this.pending.length === 0) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const body = this.pending.join('') + this.takeDroppedNotice();
      this.pending = [];
      appendFileSync(this.options.path, body);
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

      return true;
    } catch (error) {
      this.noteFailure(error);
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
    } catch {}
  }
}

export interface FileLogWriterOptions extends RotatingFileWriterOptions {
  readonly format?: FormatOptions;
}

export class FileLogWriter implements ILogWriter {
  private readonly sink: RotatingFileWriter;
  private readonly format: FormatOptions;

  constructor(options: FileLogWriterOptions) {
    this.sink = new RotatingFileWriter(options);
    this.format = options.format ?? {};
  }

  write(entry: LogEntry): void {
    const { text, dropped } = formatEntry(entry, this.format);
    if (dropped) return;
    this.sink.enqueue(text + '\n');
  }

  async flush(): Promise<void> {
    await this.sink.flush();
  }

  close(): Promise<void> {
    return this.sink.close();
  }

  flushSync(): void {
    this.sink.flushSync();
  }
}

export function createFileLogWriter(options: FileLogWriterOptions): FileLogWriter {
  return new FileLogWriter(options);
}

export class MemoryLogWriter implements ILogWriter {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

export class ConsoleLogWriter implements ILogWriter {
  write(entry: LogEntry): void {
    const { text } = formatEntry(entry, { ansi: process.stderr.isTTY === true });
    switch (entry.level) {
      case 'error':
        // eslint-disable-next-line no-console
        console.error(text);
        break;
      case 'warn':
        // eslint-disable-next-line no-console
        console.warn(text);
        break;
      case 'debug':
        // eslint-disable-next-line no-console
        console.debug(text);
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(text);
    }
  }
}
