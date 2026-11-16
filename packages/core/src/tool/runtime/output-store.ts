/**
 * Output stores for tool output logs: an in-memory store and a file-backed store under a directory,
 * with bounded retention, previews, offset reads, and append listeners.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ToolOutput, ToolOutputSnapshot, ToolOutputStore } from './types';

const RETAIN_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 32 * 1024;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

interface RestoredOutput {
  readonly totalBytes: number;
  readonly chunks: readonly string[];
  readonly failure?: string;
}

export function memoryOutputStore(): ToolOutputStore {
  const logs = new Map<string, OutputBody>();
  return {
    open(taskId) {
      const body = logs.get(taskId) ?? new OutputBody();
      logs.set(taskId, body);
      return body.open();
    },
  };
}

export function fileOutputStore(directory: string): ToolOutputStore {
  const logs = new Map<string, OutputBody>();
  return {
    open(taskId) {
      if (!TASK_ID.test(taskId)) return failedOutput(`Invalid task id: ${taskId}`);
      const body = logs.get(taskId) ?? new FileBody(join(directory, `${taskId}.log`));
      logs.set(taskId, body);
      return body.open();
    },
  };
}

class OutputBody {
  protected totalBytes = 0;
  private retainedBytes = 0;
  private chunks: string[];
  private failure: string | undefined;
  private writerHeld = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly appendListeners = new Set<(chunk: string, offset: number) => void>();

  constructor(restored?: RestoredOutput) {
    this.totalBytes = restored?.totalBytes ?? 0;
    this.chunks = [...(restored?.chunks ?? [])];
    this.retainedBytes = Buffer.byteLength(this.chunks.join(''));
    this.failure = restored?.failure;
  }

  open(): ToolOutput {
    const writer = !this.writerHeld;
    if (writer) this.writerHeld = true;
    return new OutputHandle(this, writer);
  }

  releaseWriter(): void {
    this.writerHeld = false;
  }

  onAppend(listener: (chunk: string, offset: number) => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  append(text: string): number | undefined {
    if (this.failure !== undefined) return undefined;
    const offset = this.totalBytes;
    if (text.length === 0) return offset;
    this.retain(text);
    this.queue = this.queue.then(async () => {
      if (this.failure !== undefined) return;
      await this.persist(text);
    }).catch((error: unknown) => {
      this.failure ??= errorMessage(error);
    });
    for (const listener of this.appendListeners) listener(text, offset);
    return offset;
  }

  preview(maxPreviewBytes = DEFAULT_PREVIEW_BYTES): ToolOutputSnapshot {
    const limit = byteCount(maxPreviewBytes, DEFAULT_PREVIEW_BYTES);
    const available = Buffer.from(this.chunks.join(''));
    const take = Math.min(limit, available.length);
    const preview = available.subarray(available.length - take).toString('utf8');
    return this.withLocation({
      totalBytes: this.totalBytes,
      preview,
      truncated: this.totalBytes > Buffer.byteLength(preview),
      error: this.failure,
    });
  }

  async read(offset: number, maxBytes: number): Promise<string> {
    await this.flush();
    const start = byteCount(offset, 0);
    const length = byteCount(maxBytes, 0);
    if (length === 0 || start >= this.totalBytes) return '';
    const persisted = await this.readPersisted(start, length);
    if (persisted !== undefined) return persisted;
    const retainedStart = this.totalBytes - this.retainedBytes;
    const from = Math.max(start, retainedStart);
    const end = Math.min(start + length, this.totalBytes);
    if (from >= end) return '';
    const body = Buffer.from(this.chunks.join(''));
    return body.subarray(from - retainedStart, end - retainedStart).toString('utf8');
  }

  error(): string | undefined {
    return this.failure;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure !== undefined) throw new Error(this.failure);
  }

  protected persist(_text: string): Promise<void> {
    return Promise.resolve();
  }

  protected readPersisted(_offset: number, _maxBytes: number): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  protected withLocation(snapshot: ToolOutputSnapshot): ToolOutputSnapshot {
    return snapshot;
  }

  private retain(text: string): void {
    const bytes = Buffer.byteLength(text);
    this.totalBytes += bytes;
    if (bytes >= RETAIN_BYTES) {
      const retained = Buffer.from(text).subarray(bytes - RETAIN_BYTES).toString('utf8');
      this.chunks = [retained];
      this.retainedBytes = Buffer.byteLength(retained);
      return;
    }
    this.chunks.push(text);
    this.retainedBytes += bytes;
    while (this.retainedBytes > RETAIN_BYTES && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      if (removed === undefined) break;
      this.retainedBytes -= Buffer.byteLength(removed);
    }
  }
}

export class FileBody extends OutputBody {
  readonly path: string;

  constructor(path: string, private readonly directoryMode?: number) {
    super(restoreFile(path));
    this.path = path;
  }

  protected override async persist(text: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: this.directoryMode });
    if (this.directoryMode !== undefined) {
      await chmod(directory, this.directoryMode);
      await chmod(dirname(directory), this.directoryMode);
    }
    await appendFile(this.path, text);
  }

  protected override async readPersisted(offset: number, maxBytes: number): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      file = await openFile(this.path, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      if (isMissingFile(error)) return '';
      throw error;
    } finally {
      await file?.close();
    }
  }

  protected override withLocation(snapshot: ToolOutputSnapshot): ToolOutputSnapshot {
    return { ...snapshot, path: this.path };
  }
}

class OutputHandle implements ToolOutput {
  private writer: boolean;
  private localError: string | undefined;
  private closing: Promise<void> | undefined;
  private readonly body: OutputBody;

  constructor(body: OutputBody, writer: boolean) {
    this.body = body;
    this.writer = writer;
  }

  get closed(): boolean {
    return this.closing !== undefined;
  }

  append(chunk: string): number | undefined {
    if (this.closing !== undefined) {
      this.localError ??= 'Tool output is closed';
      return undefined;
    }
    if (!this.writer) {
      this.localError ??= 'Tool output is already open for writing';
      return undefined;
    }
    return this.body.append(chunk);
  }

  onAppend(listener: (chunk: string, offset: number) => void): () => void {
    return this.body.onAppend(listener);
  }

  preview(maxBytes?: number): ToolOutputSnapshot {
    const snapshot = this.body.preview(maxBytes);
    return this.localError === undefined ? snapshot : { ...snapshot, error: this.localError };
  }

  read(offset: number, maxBytes: number): Promise<string> {
    return this.body.read(offset, maxBytes);
  }

  error(): string | undefined {
    return this.localError ?? this.body.error();
  }

  async flush(): Promise<void> {
    try {
      await this.body.flush();
    } catch (error) {
      this.localError ??= errorMessage(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const writer = this.writer;
    this.writer = false;
    this.closing = (async () => {
      try {
        await this.flush();
      } finally {
        if (writer) this.body.releaseWriter();
      }
    })();
    return this.closing;
  }
}

function restoreFile(path: string): RestoredOutput {
  try {
    const size = statSync(path).size;
    if (size === 0) return { totalBytes: 0, chunks: [] };
    const length = Math.min(size, RETAIN_BYTES);
    const buffer = Buffer.alloc(length);
    const file = openSync(path, 'r');
    try {
      readSync(file, buffer, 0, length, size - length);
    } finally {
      closeSync(file);
    }
    const text = buffer.toString('utf8');
    return { totalBytes: size, chunks: [text] };
  } catch (error) {
    if (isMissingFile(error)) return { totalBytes: 0, chunks: [] };
    return { totalBytes: 0, chunks: [], failure: errorMessage(error) };
  }
}

function failedOutput(message: string): ToolOutput {
  const failure = (): Promise<never> => Promise.reject(new Error(message));
  return {
    append() {
      return undefined;
    },
    preview() {
      return { totalBytes: 0, preview: '', truncated: false, error: message };
    },
    read() {
      return Promise.resolve('');
    },
    flush: failure,
    close: failure,
    error() {
      return message;
    },
  };
}

function byteCount(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
