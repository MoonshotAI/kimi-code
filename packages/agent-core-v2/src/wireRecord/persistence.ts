import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

import { syncDir } from "#/_base/utils/fs";
import type { PersistedWireRecord, WireRecordPersistence } from './wireRecord';

export interface FileSystemWireRecordPersistenceOptions {
  readonly onError?: (error: unknown) => void;
  readonly beforeWrite?: (
    record: PersistedWireRecord,
  ) => PersistedWireRecord | Promise<PersistedWireRecord>;
}

export interface InMemoryWireRecordPersistenceOptions {
  readonly onRecord?: (record: PersistedWireRecord) => void;
}

export class InMemoryWireRecordPersistence implements WireRecordPersistence {
  readonly records: PersistedWireRecord[] = [];

  constructor(
    records: readonly PersistedWireRecord[] = [],
    private readonly options: InMemoryWireRecordPersistenceOptions = {},
  ) {
    this.records.push(...records);
  }

  async *read(): AsyncIterable<PersistedWireRecord> {
    for (const record of this.records) {
      yield record;
    }
  }

  append(input: PersistedWireRecord): void {
    this.records.push(input);
    this.options.onRecord?.(input);
  }

  rewrite(records: readonly PersistedWireRecord[]): void {
    this.records.splice(0, this.records.length, ...records);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export class FileSystemWireRecordPersistence implements WireRecordPersistence {
  private readonly pendingRecords: PersistedWireRecord[] = [];
  private shouldClear = false;
  private directorySynced = false;
  private flushPromise: Promise<void> | undefined;
  private error: unknown;

  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemWireRecordPersistenceOptions = {},
  ) {}

  async *read(): AsyncIterable<PersistedWireRecord> {
    await this.flush();

    let line = '';
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    try {
      for await (const chunk of stream) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex);
          line = line.slice(newlineIndex + 1);
          lineNumber++;

          const record = parseRecordLine(
            rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
            lineNumber,
            this.filePath,
            false,
          );
          if (record !== undefined) yield record;

          newlineIndex = line.indexOf('\n');
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw error;
    }

    if (line.length > 0) {
      lineNumber++;
      const record = parseRecordLine(line, lineNumber, this.filePath, true);
      if (record !== undefined) yield record;
    }
  }

  append(input: PersistedWireRecord): void {
    this.throwIfError();
    this.pendingRecords.push(input);
    this.scheduleFlush();
  }

  rewrite(records: readonly PersistedWireRecord[]): void {
    this.throwIfError();
    this.shouldClear = true;
    this.pendingRecords.splice(0, this.pendingRecords.length, ...records);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.throwIfError();
    while (
      this.flushPromise !== undefined ||
      this.shouldClear ||
      this.pendingRecords.length > 0
    ) {
      await this.ensureFlush();
      this.throwIfError();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    void this.ensureFlush().catch((error) => {
      this.options.onError?.(error);
    });
  }

  private ensureFlush(): Promise<void> {
    if (this.flushPromise !== undefined) return this.flushPromise;

    const promise = this.drainPendingRecords()
      .catch((error: unknown) => {
        this.error = error;
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      })
      .finally(() => {
        if (this.flushPromise === promise) {
          this.flushPromise = undefined;
        }
        if (
          this.error === undefined &&
          (this.shouldClear || this.pendingRecords.length > 0)
        ) {
          this.scheduleFlush();
        }
      });
    this.flushPromise = promise;
    return promise;
  }

  private throwIfError(): void {
    // oxlint-disable-next-line typescript-eslint/only-throw-error
    if (this.error !== undefined) throw this.error;
  }

  private async drainPendingRecords(): Promise<void> {
    while (this.shouldClear || this.pendingRecords.length > 0) {
      await this.drainBatch();
    }
  }

  private async drainBatch(): Promise<void> {
    const shouldClear = this.shouldClear;
    const batch = this.pendingRecords.splice(0);
    this.shouldClear = false;

    const writable = this.options.beforeWrite === undefined
      ? batch
      : await Promise.all(batch.map((record) => Promise.resolve(this.options.beforeWrite!(record))));
    const content = writable.map((e) => JSON.stringify(e) + '\n').join('');
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const fh = await open(this.filePath, shouldClear ? 'w' : 'a');
    try {
      if (content.length > 0) {
        await fh.writeFile(content, 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (!this.directorySynced) {
      await syncDir(directory);
      this.directorySynced = true;
    }
  }
}

function parseRecordLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncated: boolean,
): PersistedWireRecord | undefined {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line) as PersistedWireRecord;
  } catch (parseError) {
    if (allowTruncated) return undefined;
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${filePath}: ${String(parseError)}`,
      { cause: parseError },
    );
  }
}
