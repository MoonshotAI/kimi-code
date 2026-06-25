/**
 * `SessionEventJournal` — per-session durable event log (the IM-style
 * server-side message log that makes multi-device cursors meaningful).
 *
 * One JSONL file per session under `<kimiHome>/server/events/<sessionId>.jsonl`:
 *
 *   line 1   {"kind":"journal_header","version":1,"epoch":"ep_<ulid>","created_at":...}
 *   line 2+  {"kind":"event","seq":N,"envelope":{...wire envelope...}}
 *
 * Invariants:
 *   - `seq` is assigned at append time, starts at 1, and is monotonic across
 *     server restarts (recovered by scanning the file on open).
 *   - `epoch` identifies this journal incarnation. It changes only when the
 *     file is unreadable/corrupt at open (we start a fresh journal) — clients
 *     holding cursors from the old epoch get `resync_required(epoch_changed)`.
 *   - Only durable events are written (volatile delta/progress/status frames
 *     never touch the journal; see `VOLATILE_EVENT_TYPES`).
 *
 * Durability model matches `FileSystemAgentRecordPersistence`: `append()` is
 * synchronous (callers need the seq immediately for fan-out), bytes are
 * flushed on a microtask-scheduled async batch. `readSince()` flushes first,
 * so replay reads never miss queued lines. A torn trailing line from a crash
 * is tolerated and ignored on open.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ulid } from 'ulid';

import type { ILogService } from '@moonshot-ai/agent-core';

import type { EventEnvelope } from '#/ws/protocol';

const JOURNAL_VERSION = 1;

interface JournalHeaderLine {
  kind: 'journal_header';
  version: number;
  epoch: string;
  created_at: number;
}

interface JournalEventLine {
  kind: 'event';
  seq: number;
  envelope: EventEnvelope;
}

export interface JournalEntry {
  seq: number;
  envelope: EventEnvelope;
}

export class SessionEventJournal {
  private _seq: number;
  private pendingLines: string[] = [];
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;

  private constructor(
    private readonly filePath: string,
    private readonly logger: ILogService,
    public readonly epoch: string,
    lastSeq: number,
    isFresh: boolean,
  ) {
    this._seq = lastSeq;
    this.headerPending = isFresh;
  }

  /** Highest durable seq appended (0 if none). */
  get seq(): number {
    return this._seq;
  }

  /**
   * Open (or create) the journal for `filePath`. Scans an existing file to
   * recover `{epoch, lastSeq}`. A missing file or an unreadable header
   * starts a fresh journal with a new epoch.
   */
  static async open(filePath: string, logger: ILogService): Promise<SessionEventJournal> {
    let epoch: string | undefined;
    let lastSeq = 0;
    let sawAnyLine = false;

    try {
      for await (const raw of readLines(filePath)) {
        sawAnyLine = true;
        const parsed = parseJournalLine(raw);
        if (parsed === undefined) continue; // torn/corrupt line — skip
        if (parsed.kind === 'journal_header') {
          if (epoch === undefined) epoch = parsed.epoch;
          continue;
        }
        if (parsed.seq > lastSeq) lastSeq = parsed.seq;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          { filePath, err: String(error) },
          'event journal unreadable; starting a fresh epoch',
        );
      }
    }

    if (epoch === undefined) {
      if (sawAnyLine) {
        // File exists but has no parseable header — treat as corrupt and
        // start a fresh incarnation. Old cursors will epoch-mismatch.
        logger.warn({ filePath }, 'event journal missing header; rotating to a fresh epoch');
      }
      return new SessionEventJournal(filePath, logger, `ep_${ulid()}`, 0, true);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq, false);
  }

  /** Reserve the next durable seq. The caller must follow with `append()`. */
  nextSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  /** Queue a durable event line for write-behind flush. */
  append(seq: number, envelope: EventEnvelope): void {
    const line: JournalEventLine = { kind: 'event', seq, envelope };
    this.pendingLines.push(JSON.stringify(line));
    this.scheduleFlush();
  }

  /** Read journal entries with `seq > fromSeqExclusive`, capped at `limit`. */
  async readSince(fromSeqExclusive: number, limit: number): Promise<JournalEntry[]> {
    await this.flush();
    const out: JournalEntry[] = [];
    try {
      for await (const raw of readLines(this.filePath)) {
        const parsed = parseJournalLine(raw);
        if (parsed === undefined || parsed.kind !== 'event') continue;
        if (parsed.seq <= fromSeqExclusive) continue;
        out.push({ seq: parsed.seq, envelope: parsed.envelope });
        if (out.length >= limit) break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return out;
  }

  async flush(): Promise<void> {
    while (this.flushPromise !== undefined || this.pendingLines.length > 0) {
      if (this.flushPromise === undefined) {
        this.flushPromise = this.flushOnce().finally(() => {
          this.flushPromise = undefined;
        });
      }
      await this.flushPromise;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
    });
  }

  private async flushOnce(): Promise<void> {
    // Take the queue snapshot first so appends during the await are picked
    // up by the next flush round, never lost.
    const lines: string[] = [];
    if (this.headerPending) {
      const header: JournalHeaderLine = {
        kind: 'journal_header',
        version: JOURNAL_VERSION,
        epoch: this.epoch,
        created_at: Date.now(),
      };
      lines.push(JSON.stringify(header));
      this.headerPending = false;
    }
    lines.push(...this.pendingLines);
    this.pendingLines = [];
    if (lines.length === 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, lines.join('\n') + '\n', 'utf8');
    } catch (error) {
      this.logger.warn(
        { filePath: this.filePath, err: String(error) },
        'event journal write failed; events remain live-only this round',
      );
    }
  }
}

function parseJournalLine(raw: string): JournalHeaderLine | JournalEventLine | undefined {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'journal_header') {
    const epoch = (value as { epoch?: unknown }).epoch;
    if (typeof epoch !== 'string' || epoch.length === 0) return undefined;
    return value as JournalHeaderLine;
  }
  if (kind === 'event') {
    const seq = (value as { seq?: unknown }).seq;
    const envelope = (value as { envelope?: unknown }).envelope;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return undefined;
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    return value as JournalEventLine;
  }
  return undefined;
}

async function* readLines(filePath: string): AsyncIterable<string> {
  let buffered = '';
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  }
  if (buffered.length > 0) yield buffered;
}
