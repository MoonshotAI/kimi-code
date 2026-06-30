/**
 * `log` domain (L1) — rotating file writer.
 *
 * Writes formatted `LogEntry` lines to a size-rotated file, exposing `flush`
 * and a synchronous `flushSync` for process-exit paths; `FileLogWriterService` adapts
 * it to the `ILogWriterService` contract. Uses `node:fs` rather than `kaos` because
 * rotation needs atomic rename and synchronous append.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionContext } from '#/session-context';

import { formatEntry, type FormatOptions } from './formatter';
import { ILogWriterService, type LogEntry } from './log';
import { ILogOptions, resolveSessionLogPath } from './logConfig';

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

export interface RotatingWriter {
  enqueue(line: string): void;
  flush(): Promise<boolean>;
  close(): Promise<void>;
  flushSync(): void;
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

export class RotatingFileWriter implements RotatingWriter {
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

export interface FileLogWriterServiceOptions extends RotatingFileWriterOptions {
  readonly format?: FormatOptions;
}

export class FileLogWriterService implements ILogWriterService {
  declare readonly _serviceBrand: undefined;
  private readonly sink: RotatingFileWriter;
  private readonly format: FormatOptions;

  constructor(options: FileLogWriterServiceOptions) {
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

export class SessionFileLogWriterService extends Disposable implements ILogWriterService {
  declare readonly _serviceBrand: undefined;
  private readonly inner: FileLogWriterService;

  constructor(
    @ILogOptions options: ILogOptions,
    @ISessionContext session: ISessionContext,
  ) {
    super();
    this.inner = new FileLogWriterService({
      path: resolveSessionLogPath(session.sessionDir),
      maxBytes: options.sessionMaxBytes,
      files: options.sessionFiles,
      format: { omitContextKeys: ['sessionId'] },
    });
  }

  write(entry: LogEntry): void {
    this.inner.write(entry);
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  override dispose(): void {
    this.inner.flushSync();
    void this.inner.close();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ILogWriterService,
  SessionFileLogWriterService,
  InstantiationType.Delayed,
  'log',
);
