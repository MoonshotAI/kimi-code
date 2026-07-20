/**
 * `SessionEventJournal` — per-session durable event log backing the `/api/v1/ws`
 * watermark (`{seq, epoch}`) and replay.
 *
 * Ported from v1 (`packages/server/src/services/gateway/sessionEventJournal.ts`).
 * One JSONL file per session under `<eventsDir>/<sessionId>.jsonl`:
 *
 *   line 1   {"kind":"journal_header","version":1,"epoch":"ep_<ulid>","created_at":...}
 *   line 2+  {"kind":"event","seq":N,"envelope":{...wire envelope...}}
 *
 * Invariants:
 *   - `seq` is assigned at append time, starts at 1, and is monotonic across
 *     server restarts (recovered by scanning the file on open).
 *   - `epoch` identifies this journal incarnation. It is born lazily on the
 *     FIRST durable append (never on a cold read) and changes only when the
 *     file is unreadable/corrupt at open (the next append starts a fresh
 *     journal) — clients holding cursors from the old epoch get
 *     `resync_required(epoch_changed)`. A journal with no baseline yet reports
 *     `epoch: undefined`; absent on the wire means "no baseline", which is
 *     distinct from "baseline changed".
 *   - On open with several headers (crash after a rotation) the LAST header
 *     wins — only the newest incarnation is authoritative.
 *   - Only durable events are written (volatile frames never touch the journal;
 *     see `VOLATILE_EVENT_TYPES` in `./events`).
 *
 * Durability model: `append()` is synchronous (callers need the seq immediately
 * for fan-out); bytes are flushed on a microtask-scheduled async batch. Each
 * batch uses a single `open(path, 'a')` → write → fsync → close cycle. Pending
 * lines are dequeued only AFTER the batch is durable; a failed round keeps the
 * whole batch (and the pending header) for the retry. After
 * {@link STICKY_FAILURE_THRESHOLD} consecutive failures the journal goes
 * sticky: `nextSeq()`/`append()` fail fast (pending can never grow unbounded)
 * and `readSince()` throws a {@link JournalStorageError} instead of silently
 * serving fewer events — "not served" must stay distinguishable from "nothing
 * to serve". `readSince()` flushes first so replay never misses queued lines.
 * A torn trailing line from a crash is tolerated and ignored on open, and a
 * pure cold-read open → close writes zero bytes.
 */

import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;

/**
 * Consecutive write failures that move the journal into the sticky storage
 * failure state. Bounded so a single transient error is retried by the next
 * flush round, while a persistently failing disk fails fast instead of growing
 * the pending queue forever.
 */
const STICKY_FAILURE_THRESHOLD = 2;

/**
 * Explicit journal storage failure. Thrown by `nextSeq()`/`append()` (sticky
 * fail-fast) and by `readSince()` (never answer a replay from a journal whose
 * writes failed). Distinguishable via `instanceof` so the replay edge can map
 * it to a client-visible resync instead of an empty event page.
 */
export class JournalStorageError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`event journal storage failed for ${filePath}: ${causeMessage}`, { cause });
    this.name = 'JournalStorageError';
    this.filePath = filePath;
  }
}

/**
 * Wire event envelope — matches `wsEventEnvelopeSchema` /
 * `sessionEventMessageSchema` in the local `protocol/ws-control` catalog. Defined
 * structurally so the journal does not depend on the zod schema at runtime.
 */
export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

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

/** Minimal logger surface — keeps the journal decoupled from the server logger. */
export interface JournalLogger {
  warn(obj: unknown, msg: string): void;
  error?(obj: unknown, msg: string): void;
}

const noopLogger: JournalLogger = { warn: () => {} };

export class SessionEventJournal {
  private _seq: number;
  private pendingLines: string[] = [];
  private flushPromise: Promise<void> | undefined;
  private headerPending = false;
  private currentEpoch: string | undefined;
  private consecutiveFailures = 0;
  private stickyError: JournalStorageError | undefined;

  private constructor(
    private readonly filePath: string,
    private readonly logger: JournalLogger,
    epoch: string | undefined,
    lastSeq: number,
  ) {
    this._seq = lastSeq;
    this.currentEpoch = epoch;
  }

  /** Highest durable seq appended (0 if none). */
  get seq(): number {
    return this._seq;
  }

  /**
   * Current journal epoch. `undefined` until the first durable append stamps a
   * header — a journal with no baseline must present "absent", not a random
   * placeholder (repeated cold reads of the same journal used to yield
   * different fabricated epochs and trigger fake `epoch_changed` resyncs).
   */
  get epoch(): string | undefined {
    return this.currentEpoch;
  }

  /**
   * Whether writes have failed and not yet recovered, i.e. pending lines are
   * not durably on disk. While this holds, replay must consult the journal
   * itself (`readSince`, which retries the flush and throws once sticky)
   * rather than any in-memory copy of the events.
   */
  get writeFailure(): boolean {
    return this.stickyError !== undefined || this.consecutiveFailures > 0;
  }

  get flushInFlight(): boolean {
    return this.flushPromise !== undefined;
  }

  /**
   * Open (or create-on-first-append) the journal for `filePath`. Scans an
   * existing file to recover `{epoch, lastSeq}`. This open is READ-ONLY: a
   * missing file or an unreadable/missing header yields a journal with
   * `epoch: undefined` and seq 0, writes nothing, and defers the fresh epoch
   * to the first real `append()`. With several headers the last one wins.
   */
  static async open(
    filePath: string,
    logger: JournalLogger = noopLogger,
  ): Promise<SessionEventJournal> {
    let epoch: string | undefined;
    let lastSeq = 0;
    let sawAnyLine = false;
    let corrupt = false;
    let segmentSeq = 0;

    try {
      for await (const line of readLines(filePath)) {
        const raw = line.raw;
        if (raw.trim().length === 0) continue;
        sawAnyLine = true;
        const parsed = parseJournalLine(raw);
        if (parsed === undefined) {
          if (!line.terminated) continue;
          corrupt = true;
          break;
        }
        if (parsed.kind === 'journal_header') {
          epoch = parsed.epoch; // last header wins
          segmentSeq = 0;
          continue;
        }
        if (epoch === undefined || parsed.seq !== segmentSeq + 1) {
          corrupt = true;
          break;
        }
        segmentSeq = parsed.seq;
        lastSeq = segmentSeq;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        corrupt = true;
        logger.warn(
          { filePath, err: String(error) },
          'event journal unreadable; starting a fresh epoch on next append',
        );
      }
    }

    if (corrupt || (sawAnyLine && epoch === undefined)) {
      await quarantineCorruptJournal(filePath, logger);
      epoch = undefined;
      lastSeq = 0;
    }

    if (epoch === undefined) {
      if (sawAnyLine) {
        // File exists but has no parseable header — treat as corrupt and let
        // the next append start a fresh incarnation. Old cursors will
        // epoch-mismatch once the new header lands.
        logger.warn({ filePath }, 'event journal missing header; rotating to a fresh epoch on next append');
      }
      return new SessionEventJournal(filePath, logger, undefined, 0);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq);
  }

  /** Reserve the next durable seq. The caller must follow with `append()`. */
  nextSeq(): number {
    this.throwIfSticky();
    if (this.currentEpoch === undefined) {
      // First durable write of this incarnation: seq and epoch are born
      // together, so every envelope can carry the epoch — including the very
      // first one (the broadcaster stamps envelopes before `append()` runs).
      // This is the ONLY place an epoch materializes: cold reads never call
      // `nextSeq`, so they stay byte-free. The header latch alone writes
      // nothing — `flushOnce` only runs when lines are pending (see `flush`).
      this.currentEpoch = `ep_${ulid()}`;
      this.headerPending = true;
    }
    this._seq += 1;
    return this._seq;
  }

  /** Queue a durable event line for write-behind flush. */
  append(seq: number, envelope: EventEnvelope): void {
    this.throwIfSticky();
    const line: JournalEventLine = { kind: 'event', seq, envelope };
    this.pendingLines.push(JSON.stringify(line));
    this.scheduleFlush();
  }

  /** Read journal entries with `seq > fromSeqExclusive`, capped at `limit`. */
  async readSince(fromSeqExclusive: number, limit: number): Promise<JournalEntry[]> {
    await this.flush();
    // Never answer a replay from a journal whose writes failed: a partial
    // read would be a lie. Surface the sticky error so the edge can force a
    // client-visible resync instead.
    if (this.stickyError !== undefined) throw this.stickyError;
    const out: JournalEntry[] = [];
    try {
      let activeEpoch: string | undefined;
      let expectedSeq = 0;
      for await (const line of readLines(this.filePath)) {
        const raw = line.raw;
        if (raw.trim().length === 0) continue;
        const parsed = parseJournalLine(raw);
        if (parsed === undefined) {
          if (!line.terminated) continue;
          throw new JournalStorageError(this.filePath, new Error('corrupt journal line'));
        }
        if (parsed.kind === 'journal_header') {
          activeEpoch = parsed.epoch;
          expectedSeq = 0;
          continue;
        }
        if (activeEpoch === undefined || parsed.seq !== expectedSeq + 1) {
          throw new JournalStorageError(this.filePath, new Error('journal sequence gap'));
        }
        expectedSeq = parsed.seq;
        if (activeEpoch !== this.currentEpoch) continue;
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
    if (this.stickyError !== undefined) return;
    while (this.flushPromise !== undefined || this.pendingLines.length > 0) {
      if (this.flushPromise === undefined) {
        this.flushPromise = this.flushOnce().then(() => {
          this.flushPromise = undefined;
        });
      }
      await this.flushPromise;
      // Give up once sticky instead of hot-spinning on a persistently failing
      // disk; the kept pending lines are retried by the next append-scheduled
      // or read-triggered round.
      if (this.stickyError !== undefined) return;
    }
  }

  /** Flush whatever is pending; never throws (the read edge throws instead). */
  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().then((succeeded) => {
      this.flushPromise = undefined;
      // Appends that arrived while this flush was in flight are still pending:
      // chain the next round instead of parking them until a later append (or
      // `close()`) happens to trigger one. A FAILED round must NOT chain — its
      // kept lines are retried only by the next append-scheduled or
      // read-triggered round (see `flush`), otherwise a persistently failing
      // disk hot-spins open attempts forever, even past `close()`.
      if (succeeded && this.pendingLines.length > 0) this.scheduleFlush();
    });
  }

  private async flushOnce(): Promise<boolean> {
    // Snapshot the queue WITHOUT clearing it: lines are dequeued only after
    // the batch is durably on disk (write + fsync succeeded). A failed round
    // keeps every line — and a pending header — for the next retry.
    const headerLine = this.headerPending ? this.buildHeaderLine() : undefined;
    const pendingSnapshot = this.pendingLines.slice();
    if (headerLine === undefined && pendingSnapshot.length === 0) return true;
    let lines = headerLine !== undefined ? [headerLine, ...pendingSnapshot] : pendingSnapshot;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.consecutiveFailures > 0) {
        const committed = await countCommittedPrefix(this.filePath, lines);
        if (committed > 0) {
          if (headerLine !== undefined) this.headerPending = false;
          this.pendingLines.splice(0, Math.max(0, committed - (headerLine === undefined ? 0 : 1)));
          lines = lines.slice(committed);
          if (lines.length === 0) {
            this.consecutiveFailures = 0;
            return true;
          }
        }
      }
      // One open per batch: write header+lines, fsync, close.
      const handle = await openFile(this.filePath, 'a');
      try {
        await handle.writeFile(lines.join('\n') + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const committed = await countCommittedPrefix(this.filePath, lines);
      if (committed > 0) {
        if (headerLine !== undefined && committed > 0) this.headerPending = false;
        this.pendingLines.splice(0, Math.max(0, committed - (headerLine === undefined ? 0 : 1)));
        this.stickyError ??= new JournalStorageError(this.filePath, error);
        return true;
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= STICKY_FAILURE_THRESHOLD && this.stickyError === undefined) {
        // Sticky storage failure: durable events must never silently degrade
        // to live-only. kap-server has no telemetry wiring today, so the
        // sticky transition is an error-level log breadcrumb (the design's
        // `session.journal_write_failed` event lands with the wiring).
        const logError = this.logger.error?.bind(this.logger) ?? this.logger.warn.bind(this.logger);
        logError(
          {
            filePath: this.filePath,
            err: String(error),
            consecutiveFailures: this.consecutiveFailures,
          },
          'event journal storage failed persistently; entering sticky failure state — appends fail fast and readSince throws',
        );
        this.stickyError = new JournalStorageError(this.filePath, error);
      } else {
        this.logger.warn(
          { filePath: this.filePath, err: String(error) },
          'event journal write failed; batch kept pending for retry',
        );
      }
      return false;
    }
    // Success: dequeue exactly the lines written above (appends during the
    // await stay queued for the next round) and release the header latch.
    this.pendingLines.splice(0, pendingSnapshot.length);
    if (headerLine !== undefined) this.headerPending = false;
    this.consecutiveFailures = 0;
    return true;
  }

  private buildHeaderLine(): string | undefined {
    if (this.currentEpoch === undefined) return undefined;
    const header: JournalHeaderLine = {
      kind: 'journal_header',
      version: JOURNAL_VERSION,
      epoch: this.currentEpoch,
      created_at: Date.now(),
    };
    return JSON.stringify(header);
  }

  private throwIfSticky(): void {
    if (this.stickyError !== undefined) throw this.stickyError;
  }
}

/** Default per-session journal path under `<eventsDir>/<sessionId>.jsonl`. */
export function sessionJournalPath(eventsDir: string, sessionId: string): string {
  return join(eventsDir, `${sessionId}.jsonl`);
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
    const version = (value as { version?: unknown }).version;
    if (typeof epoch !== 'string' || epoch.length === 0 || version !== JOURNAL_VERSION) return undefined;
    return value as JournalHeaderLine;
  }
  if (kind === 'event') {
    const seq = (value as { seq?: unknown }).seq;
    const envelope = (value as { envelope?: unknown }).envelope;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return undefined;
    if (!isEventEnvelope(envelope) || envelope.seq !== seq) return undefined;
    return value as JournalEventLine;
  }
  return undefined;
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Partial<EventEnvelope>;
  return (
    typeof envelope.type === 'string' &&
    typeof envelope.seq === 'number' &&
    Number.isInteger(envelope.seq) &&
    envelope.seq > 0 &&
    typeof envelope.timestamp === 'string' &&
    Object.prototype.hasOwnProperty.call(envelope, 'payload')
  );
}

interface RawJournalLine {
  raw: string;
  terminated: boolean;
}

async function* readLines(filePath: string): AsyncIterable<RawJournalLine> {
  let buffered = '';
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      yield { raw: buffered.slice(0, newlineIndex), terminated: true };
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  }
  if (buffered.length > 0) yield { raw: buffered, terminated: false };
}

async function quarantineCorruptJournal(filePath: string, logger: JournalLogger): Promise<void> {
  try {
    await rename(filePath, `${filePath}.corrupt.${ulid()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ filePath, err: String(error) }, 'event journal quarantine failed; truncating file');
      await truncate(filePath, 0).catch(() => undefined);
    }
  }
}

async function countCommittedPrefix(filePath: string, lines: readonly string[]): Promise<number> {
  if (lines.length === 0) return 0;
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return 0;
  }
  const existing = raw.split('\n');
  if (existing.at(-1) === '') existing.pop();
  let committed = 0;
  for (let count = 1; count <= lines.length; count++) {
    const start = existing.length - count;
    if (start < 0) break;
    let matches = true;
    for (let index = 0; index < count; index++) {
      if (existing[start + index] !== lines[index]) {
        matches = false;
        break;
      }
    }
    if (matches) committed = count;
  }
  return committed;
}
