/**
 * `search` module — the host-agnostic search-index core (stage 4 worker
 * isolation).
 *
 * Everything that touches the `<homeDir>/search-index` MiniDb lives here:
 * open/reopen (writer election via the write lock, corruption rebuild), the
 * read-only freshness machinery (fingerprint + WAL catch-up), the
 * incremental sync pass (wire-file scanning, doc projection, stats), the
 * bounded index-route query execution (candidate search + match/confirm +
 * keyset pagination), reindex, and close.
 *
 * The core runs in TWO hosts with identical semantics:
 *   - INLINE host (rollback switch): the main process instantiates it
 *     directly (`InlineSearchBackend` in searchService.ts) — the pre-stage-4
 *     behavior;
 *   - WORKER host (default): `worker/entry.ts` instantiates it inside a
 *     dedicated worker thread and serves it over the RPC protocol
 *     (`worker/protocol.ts`), so generation loads, WAL replays, syncs and
 *     query execution never share the TUI/HTTP main thread's event loop.
 *
 * Because the worker entry is loaded under Node's native type stripping,
 * every RELATIVE import in this file (and its whole closure) uses an
 * explicit `.ts` specifier, and no decorators / non-erasable TS syntax are
 * allowed in the closure.
 *
 * The concurrency comments carried over from searchService.ts ("the lock is
 * the election", "requests serve a published generation, never wait") all
 * apply per-host: in the worker host the interleaving between a background
 * sync/refresh and a query is the same single-threaded interleaving the
 * pre-worker service had on the main thread.
 */

import { createHash } from 'node:crypto';
import { open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  LockError,
  MiniDb,
  OpTracker,
  TextIndexBuildingError,
  type BatchInputOp,
} from '@moonshot-ai/minidb';

import { GlobalSearchError, type GlobalSearchIncomplete } from './contract.ts';
import {
  MAX_DOC_TEXT_CHARS,
  type FileMetaDoc,
  type MessageDoc,
  type SearchDoc,
  type SessionMetaDoc,
  type StatsDoc,
  type StepTrackerState,
  type TitleDoc,
  type TurnCounterState,
} from './docs.ts';
import {
  decodePageToken,
  matchDocs,
  paginateRows,
  type MatchBudget,
  type MatchedRow,
  type NormalizedQuery,
  type SearchBudgets,
} from './match.ts';
import { analyzeWireLine, type StepEffect, type TurnEffect } from './wireExtract.ts';

// ---------------------------------------------------------------------------
// Constants & key namespaces (moved verbatim from the pre-worker service)
// ---------------------------------------------------------------------------

const TEXT_INDEX_NAME = 'body';
/** n-gram substring index backing literal mode, alongside 'body'. */
const TRI_INDEX_NAME = 'tri';
const WIRE_FILENAME = 'wire.jsonl';

/** Key namespaces inside the single db. */
const FILE_META_PREFIX = '\0meta\\file\\';
const SESSION_META_PREFIX = '\0meta\\session\\';
const STATS_KEY = '\0meta\\stats';

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}

/**
 * minidb keys are limited to 128 bytes, far shorter than an absolute wire
 * path — the file meta key carries the owning session id plus a hash of the
 * path (the path itself lives in the value). The session segment makes a
 * per-session prefix scan (`fileMetaPrefixFor`) touch only that session's
 * metas instead of the global meta namespace.
 */
function fileMetaKey(sessionId: string, filePath: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\${hashPath(filePath)}`;
}

/** All file-meta keys of one session (prefix-scan argument). */
function fileMetaPrefixFor(sessionId: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\`;
}

/**
 * Pre-v2 file-meta key: hash-only, the owning session identifiable only via
 * the value — a per-session lookup required scanning every file meta.
 * Read side of the migration: `syncWireFile` still resolves it by point
 * lookup; `migrateFileMetaKeys` rewrites the rest in one background pass.
 */
function legacyFileMetaKey(filePath: string): string {
  return FILE_META_PREFIX + hashPath(filePath);
}

/** One wire-delta read slice: growth is consumed in bounded chunks instead
 *  of one `size - offset` allocation. */
const WIRE_READ_CHUNK_BYTES = 1 << 20;
/** Flush doc ops to the db in batches of this size while scanning a delta. */
const WIRE_BATCH_OPS = 1_000;
const EMPTY_BUFFER = Buffer.alloc(0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Turn counter / step tracker (replay over the wire file; states in docs.ts)
// ---------------------------------------------------------------------------

const INITIAL_TURN_STATE: TurnCounterState = { next: 0, hasTurn: false, openers: [] };

function initialTurnState(): TurnCounterState {
  return INITIAL_TURN_STATE;
}

/**
 * Replay `context.undo {count}`: drop the last `count` anchor-opened turns.
 * The counter rewinds to the ordinal of the earliest dropped anchor, and the
 * opener stack is truncated there. An undo with fewer anchors than `count`
 * never reaches the wire (the engine's precheck rejects it) — left untouched.
 */
function applyUndoToTurnState(state: TurnCounterState, count: number): TurnCounterState {
  let found = 0;
  for (let i = state.openers.length - 1; i >= 0; i--) {
    if (state.openers[i]!.anchor) {
      found++;
      if (found === count) {
        return {
          next: state.openers[i]!.turn,
          hasTurn: i > 0,
          openers: state.openers.slice(0, i),
        };
      }
    }
  }
  return state;
}

/**
 * Advance the counter with one record's turn effect. Returns the ordinal that
 * documents extracted from the SAME record belong to: a user opener carries
 * the turn it opens; assistant content carries the current turn (after the
 * `ensure` gate). Undefined when the record owns no turn.
 *
 * The counter is monotonic except for `undo` rewinds: `apply_compaction` and
 * `clear` do NOT renumber (the transcript's cold replay keeps full history
 * and groupTurns numbers it continuously; the live TurnModel is monotonic
 * too), so they are `none` effects by construction. Docs indexed BEFORE an
 * `undo` keep their pre-undo ordinals — those messages no longer exist in the
 * transcript view, so their ordinals point nowhere (known, accepted
 * deviation, same class as "folded-away messages stay searchable").
 */
function advanceTurnCounter(
  state: TurnCounterState,
  effect: TurnEffect,
): { docTurn: number | undefined; state: TurnCounterState } {
  switch (effect.kind) {
    case 'open':
      return {
        docTurn: state.next,
        state: {
          next: state.next + 1,
          hasTurn: true,
          openers: [...state.openers, { turn: state.next, anchor: effect.anchor }],
        },
      };
    case 'ensure': {
      const next = state.hasTurn ? state : { ...state, next: state.next + 1, hasTurn: true };
      return { docTurn: next.next - 1, state: next };
    }
    case 'undo':
      return { docTurn: undefined, state: applyUndoToTurnState(state, effect.count) };
    case 'none':
      return { docTurn: undefined, state };
  }
}

const INITIAL_STEP_STATE: StepTrackerState = { byUuid: {}, begins: 0 };

function initialStepState(): StepTrackerState {
  return INITIAL_STEP_STATE;
}

/**
 * Advance the tracker with one record's step effect. `begin` maps the step's
 * uuid to its ordinal: the wire record's own `step` field when present (the
 * engine's live 1-based numbering — the same numbering transcript step ids
 * use), otherwise the count of begins seen in this turn (v1 loops had no
 * loop-level retries, so counting matches the surviving-step numbering).
 * The mapping is never narrowed per step — it is reset wholesale at turn
 * boundaries (`open`, a fallback-opening `ensure`, `undo`) by the caller.
 */
function advanceStepTracker(state: StepTrackerState, effect: StepEffect): StepTrackerState {
  if (effect.kind !== 'begin') return state;
  const begins = state.begins + 1;
  const ordinal = effect.ordinal ?? begins;
  if (state.byUuid[effect.uuid] === ordinal) return state;
  return { byUuid: { ...state.byUuid, [effect.uuid]: ordinal }, begins };
}

// ---------------------------------------------------------------------------
// Core options & wire types
// ---------------------------------------------------------------------------

/** Minimal logger surface the core needs (the worker forwards these over RPC). */
export interface SearchCoreLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SearchCoreOptions {
  /** Absolute path of the search-index database directory. */
  readonly indexDir: string;
  readonly log: SearchCoreLog;
  /**
   * Unique-per-host-boot salt mixed into the token-pinning generation: a
   * worker/process restart resets the local generation counter, and the
   * salt makes tokens issued before the restart fail validation instead of
   * colliding with the fresh counter (see `tokenGeneration`).
   */
  readonly bootSalt: string;
  /**
   * Fired synchronously when an open acquires the write lock — BEFORE the
   * heavy recovery work runs. The worker entry forwards it to the host so a
   * mid-open crash leaves a reapable lock.
   */
  readonly onLockToken?: (token: string) => void;
}

/**
 * One session to index, with its persistence directory PRE-RESOLVED by the
 * caller (the main process owns `sessionDirOf`/`workspacePersistenceScope`;
 * the worker closure deliberately does not import agent-core-v2).
 */
export interface SyncSessionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly updatedAt: number;
  /** Absolute session directory (the parent of wire.jsonl / agents/). */
  readonly dir: string;
}

/** The core's view of the served index, embedded in every search response. */
export interface CoreIndexView {
  readonly state: 'building' | 'ready' | 'readonly';
  readonly indexedSessions: number;
  readonly documents: number;
  readonly readOnly: boolean;
  /**
   * Read-only-branch staleness: the on-disk fingerprint changed (a refresh
   * is pending) or a refresh is in flight. Writer-side staleness is the
   * caller's coordinator state and is OR'ed in by the service.
   */
  readonly freshnessStale: boolean;
  /** Last background refresh failure, when serving a stale view. */
  readonly degraded?: string;
  /**
   * Token of the db.lock line this core published (writer only) — the main
   * process uses it to reap the lock file after a worker crash without ever
   * deleting another owner's lock.
   */
  readonly lockToken?: string;
}

export type CoreSearchResult =
  | {
      readonly kind: 'page';
      readonly rows: MatchedRow[];
      readonly hasMore: boolean;
      readonly incomplete?: GlobalSearchIncomplete;
      /** Token-pinning generation (`bootSalt:counter`) — see tokenGeneration. */
      readonly generation: string;
      readonly index: CoreIndexView;
    }
  | { readonly kind: 'building'; readonly index: CoreIndexView };

export interface CoreSearchParams {
  readonly q: NormalizedQuery;
  /** Raw opaque token from the request; decoded (and generation-checked) here. */
  readonly pageToken?: string;
  readonly budgets: SearchBudgets;
}

export interface CoreSyncOutcome {
  /** True when the pass did not run (no db yet, or a read-only instance). */
  readonly noop: boolean;
  readonly sessions: number;
  readonly documents: number;
  readonly lockToken?: string;
  /** Post-pass lifecycle snapshot (stage 5) — keeps the host's cached
   *  aggregate state exact on the sync-first path, where no search/status
   *  response ever carries it. */
  readonly lifecycle: CoreLifecycleReport;
}

/** The pass body's return — the wrapper adds the lock token and lifecycle. */
type CoreSyncPassOutcome = Omit<CoreSyncOutcome, 'lockToken' | 'lifecycle'>;

/**
 * The aggregate lifecycle of the served index (stage 5): the diagnostic state
 * machine behind the service's status surface —
 * `stopped → opening → ready → building/degraded → closing`. Distinct from
 * the per-page `CoreIndexView.state` (which answers "can this page serve hits
 * now"): the lifecycle also covers the no-db phases and carries the failure
 * detail, so logs/diagnostics can tell building, stale-serving, degraded,
 * corrupt-rebuild and worker-unavailable apart.
 */
export type CoreLifecycleState =
  /** Never opened, or fully closed. */
  | 'stopped'
  /** An open/reopen is in flight (generation load / WAL replay / rebuild). */
  | 'opening'
  /** A db is published but its text base is still (re)building. */
  | 'building'
  /** A published generation is serving (writer or read-only). A base that
   *  keeps serving after a failed background refresh stays 'ready' — the
   *  failure rides the `degraded` message field of the page/status surfaces. */
  | 'ready'
  /** No base is serving: the last open failed, or (worker host) the worker
   *  is down/backing off. The detail carries the error. */
  | 'degraded'
  /** Close has started; in-flight ops are draining. */
  | 'closing';

export interface CoreLifecycleReport {
  readonly state: CoreLifecycleState;
  readonly detail?: string;
}

export interface CoreStatus {
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number | null;
  readonly generation: number;
  readonly readOnly: boolean;
  readonly lockToken?: string;
  readonly degraded?: string;
  /** Post-open/post-refresh lifecycle snapshot (stage 5). */
  readonly lifecycle: CoreLifecycleReport;
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

export class SearchIndexCore {
  /** WAL watermark (bytes applied) for read-only catch-up. */
  private walOffset = 0;
  private fingerprint = '';
  private disposed = false;
  /**
   * Close-gate + drain for lifecycle-managed background ops (sync passes and
   * read-only refreshes): close() closes the gate (new ops skip) and drains
   * the in-flight ones BEFORE closing the db, so no background task ever
   * touches a closed handle.
   */
  private readonly ops = new OpTracker();
  /**
   * Identity of the published index base: bumped on every open/reopen
   * (initial open, read-only swap, reindex) and on a sync pass that REPLACED
   * already-indexed documents (shrink rescan, title overwrite). Page tokens
   * pin it; additive/deletion-only passes deliberately keep it stable so
   * keyset pagination over a live index is not constantly restarted (see
   * contract.ts for the weak-consistency semantics).
   */
  private generation = 0;
  /** Set by a sync pass when it replaced indexed documents → generation bump. */
  private syncReplaced = false;
  /** Last background refresh failure — surfaced as degraded. */
  private lastRefreshError: { at: number; message: string } | null = null;
  /** Last open failure — a search with no published generation fails fast. */
  private openError: string | null = null;
  /** One-time per-process migration flag for pre-v2 file-meta keys. */
  private fileMetaMigrated = false;
  /** Token of the published db.lock line (writer only) — see CoreIndexView. */
  private lockToken: string | undefined;

  // Visible to the inline host and to tests (the worker host never touches
  // these directly — it talks RPC).
  db: MiniDb<SearchDoc> | null = null;
  openPromise: Promise<void> | null = null;
  refreshPromise: Promise<void> | null = null;
  fullSyncDone = false;

  constructor(private readonly options: SearchCoreOptions) {}

  /** The published db.lock token (writer only) — see CoreIndexView.lockToken. */
  get lockTokenView(): string | undefined {
    return this.lockToken;
  }

  private get indexDir(): string {
    return this.options.indexDir;
  }

  private get log(): SearchCoreLog {
    return this.options.log;
  }

  // -- lifecycle ---------------------------------------------------------------

  ensureOpen(): Promise<void> {
    this.openPromise ??= this.openDb().then(
      () => {
        this.openError = null;
      },
      (error: unknown) => {
        this.openPromise = null;
        this.openError = errorMessage(error);
        throw error;
      },
    );
    return this.openPromise;
  }

  private async openDb(): Promise<void> {
    const db = await this.openSearchDb();
    // The host may have been closed while the (slow) open was in flight —
    // close the handle immediately instead of leaking it and writing the
    // text-index definition below into a directory the caller may already be
    // deleting.
    if (this.disposed) {
      await db.close().catch(() => {});
      throw new GlobalSearchError('index_unavailable', 'search service is disposed');
    }
    await this.publishDb(db, null);
  }

  /**
   * The generation page tokens pin: `<bootSalt>:<local counter>`. The local
   * counter alone restarts from 0 when the worker (or, pre-workerization,
   * the process) respawns — a token issued before the restart (say g=1)
   * would otherwise validate against the fresh host's g=1 and silently
   * paginate a different base. The boot salt makes every pre-restart token
   * fail with `invalid_page_token` so the client restarts the search.
   */
  private tokenGeneration(): string {
    return `${this.options.bootSalt}:${this.generation}`;
  }

  /**
   * Swap a freshly opened db in as the new published generation: writer-side
   * text-index definitions and the (handle-independent) fingerprint are
   * computed BEFORE the swap, so a failure closes `next` and leaves `prev`
   * (or the no-db state) untouched; the swap itself is one synchronous
   * segment with no failure point between publishing `next` and closing
   * `prev`.
   */
  private async publishDb(next: MiniDb<SearchDoc>, prev: MiniDb<SearchDoc> | null): Promise<void> {
    let fingerprint: string;
    try {
      if (!next.readOnly) {
        // Both indexes are created here (not at first write) so a
        // pre-existing db gets the tri index built over its current documents
        // on first open after the upgrade, and a read-only peer only ever
        // reopens on the definitions-file fingerprint change.
        for (const [name, options] of [
          [TEXT_INDEX_NAME, { fields: ['text'] }],
          [TRI_INDEX_NAME, { fields: ['text'], tokenizer: 'ngram' }],
        ] as const) {
          try {
            await next.createTextIndex(name, options);
          } catch (error) {
            if (!(error instanceof Error && error.message.includes('already exists'))) throw error;
          }
        }
      }
      fingerprint = await this.computeFingerprint();
    } catch (error) {
      await next.close().catch(() => {});
      throw error;
    }
    this.db = next;
    this.walOffset = next.recoveryInfo?.walScanEnd ?? 0;
    this.generation++;
    this.fingerprint = fingerprint;
    this.lockToken = next.readOnly ? undefined : await this.readLockToken();
    if (prev !== null) await prev.close().catch(() => {});
    // The lifecycle read model answers from logs alone which database this
    // surface serves and which path its open took (a published-generation
    // attach vs a full recovery), and how expensive the open was.
    const lifecycle = next.lifecycleStatus();
    this.log.info('global search: index opened', {
      dir: this.indexDir,
      readOnly: next.readOnly,
      state: lifecycle.state,
      generation: next.getIndexGeneration()?.id ?? null,
      openMs: Math.round(lifecycle.phases.openMs),
      fullRecoveryMs: Math.round(lifecycle.phases.fullRecoveryMs),
    });
  }

  /**
   * The db.lock token this core published, so the main process can reap the
   * lock after a worker crash. Read from the lock file (the LockFile
   * instance's token is instance-private by design); anything unreadable or
   * foreign-owned yields undefined and the reaper stays conservative.
   */
  private async readLockToken(): Promise<string | undefined> {
    try {
      const raw = await readFile(join(this.indexDir, 'db.lock'), 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      if (parsed.pid !== process.pid || typeof parsed.token !== 'string') return undefined;
      return parsed.token;
    } catch {
      return undefined;
    }
  }

  /**
   * Open the index db, rebuilding from scratch on unrecoverable corruption
   * (the index is derived data — never repaired, only rebuilt).
   *
   * Rebuild is WRITER-ONLY: a process that fails to grab the write lock must
   * never delete the directory out from under the live indexer. Lock state is
   * not observable once `open` throws, so corruption is disambiguated with a
   * probe open WITHOUT `onLockFail`: it throws `LockError` before recovery
   * when another process holds the lock, and re-throws the corruption
   * (releasing the lock) when the lock is free — in which case this process
   * is the would-be writer and may rebuild.
   */
  private async openSearchDb(): Promise<MiniDb<SearchDoc>> {
    const opts = {
      dir: this.indexDir,
      valueCodec: 'json',
      fsyncPolicy: 'everysec',
      onLockFail: 'readonly',
      onLockAcquired: (info: { readonly token: string }) => {
        // The lock is held from this instant; publish the token immediately
        // so a mid-open crash leaves a reapable lock (the token read back at
        // publishDb remains the final authority).
        this.lockToken = info.token;
        this.options.onLockToken?.(info.token);
      },
    } as const;
    try {
      return await MiniDb.open<SearchDoc>(opts);
    } catch (error) {
      if (!isRebuildableCorruption(error)) throw error;
      let probeError: unknown;
      try {
        const probe = await MiniDb.open<SearchDoc>({ dir: opts.dir, valueCodec: opts.valueCodec });
        await probe.close().catch(() => {});
        probeError = undefined; // lock free AND data fine — cannot happen, but treat as rebuildable
      } catch (error) {
        probeError = error;
      }
      if (probeError instanceof LockError) {
        // Another process holds the write lock: leave its files alone. The
        // caller's open fails; the next search retries from scratch.
        throw error;
      }
      // The index is derived data — never repaired, only rebuilt. The rebuild
      // destroys the previous index files, so the corruption that justified it
      // must be visible in the logs (stage 5: 'corrupt' is a distinguishable
      // diagnostic outcome, separate from building/degraded).
      this.log.warn('global search: search-index corruption detected; rebuilding from scratch', {
        dir: this.indexDir,
        error: errorMessage(error),
      });
      await rm(this.indexDir, { recursive: true, force: true });
      return MiniDb.open<SearchDoc>(opts);
    }
  }

  /**
   * Synchronously mark the core closed: in-flight sync/refresh passes skip
   * their remaining work at the next `disposed` check, and no new background
   * work starts. The async close() then drains and releases the handle. The
   * split exists so a host's synchronous dispose() can gate mid-pass writes
   * BEFORE awaiting anything (the pre-worker service did this with its
   * synchronous `disposed = true`).
   */
  beginClose(): void {
    this.disposed = true;
  }

  /**
   * Close the core: close the op gate (new syncs / refreshes skip at
   * enter()), wait for every in-flight op and the in-flight open to settle,
   * then release and close the handle — no background task can touch a
   * closed db.
   */
  async close(): Promise<void> {
    this.disposed = true;
    await this.ops.close();
    await this.openPromise?.catch(() => {});
    const db = this.db;
    this.db = null;
    if (db) await db.close().catch(() => {});
  }

  /**
   * Run one lifecycle-managed background op under the close drain gate:
   * skipped once close has started, and close waits for every op that
   * already entered before it closes the db.
   */
  private async tracked(op: () => Promise<void>): Promise<void> {
    if (!this.ops.enter()) return;
    try {
      await op();
    } finally {
      this.ops.leave();
    }
  }

  // -- read-only freshness (fingerprint + WAL catch-up) -------------------------

  private async computeFingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const name of ['db.wal', 'db.snapshot', 'db.textindexes.json']) {
      try {
        const s = await stat(join(this.indexDir, name));
        parts.push(`${name}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }

  /**
   * Bring a read-only instance up to date with the indexer's committed
   * writes. Unchanged fingerprint → zero IO; WAL pure-append → incremental
   * `catchUpFromWal`; anything else → open the replacement db and swap (which
   * may also promote this process to indexer when the old writer's lock is
   * gone). Single-flight; a failure is recorded in `lastRefreshError` and
   * the stale generation keeps serving (surfaced as `indexState.degraded`).
   */
  refresh(): Promise<void> {
    this.refreshPromise ??= this.tracked(() => this.doRefreshReadonly())
      .then(
        () => {
          this.lastRefreshError = null;
        },
        (error: unknown) => {
          // A failed refresh must not fail the search — serve the stale view,
          // but no longer swallow the error silently.
          this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
          this.log.warn('global search: read-only refresh failed; serving the stale view', {
            error: errorMessage(error),
          });
        },
      )
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async doRefreshReadonly(): Promise<void> {
    const db = this.db;
    if (!db || !db.readOnly || this.disposed) return;
    const fp = await this.computeFingerprint();
    if (fp === this.fingerprint) return;
    const [, snapPrev, defsPrev] = this.fingerprint.split('|');
    const [, snapNow, defsNow] = fp.split('|');
    if (snapPrev === snapNow && defsPrev === defsNow) {
      const res = await db.catchUpFromWal(this.walOffset);
      if (res !== null) {
        this.walOffset = res.offset;
        this.fingerprint = fp;
        return;
      }
    }
    // WAL rotated/truncated, snapshot or index definitions changed, or the
    // watermark no longer aligns: reopen from scratch. The replacement is
    // opened and published BEFORE the stale handle closes, so a failed
    // reopen leaves the previous generation servable instead of dropping
    // the index out from under in-flight searches.
    const next = await this.openSearchDb();
    if (this.disposed) {
      await next.close().catch(() => {});
      return;
    }
    if (this.db !== db) {
      // A concurrent refresh already swapped: just close the duplicate.
      await next.close().catch(() => {});
      return;
    }
    await this.publishDb(next, db);
  }

  // -- sync pass (indexer only) -------------------------------------------------
  //
  // The caller (the service's coordinator) owns debounce/single-flight and
  // enumerates the sessions; the pass itself — wire-file scanning, doc
  // projection, stats — runs here. A sync that REPLACED indexed documents
  // bumps the generation, invalidating older page tokens.

  async sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome> {
    let outcome: CoreSyncPassOutcome = { noop: true, sessions: 0, documents: 0 };
    await this.tracked(async () => {
      outcome = await this.runSync(sessions);
    });
    return { ...outcome, lockToken: this.lockToken, lifecycle: this.lifecycleState() };
  }

  private async runSync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncPassOutcome> {
    if (this.disposed) return { noop: true, sessions: 0, documents: 0 };
    this.syncReplaced = false;
    await this.ensureOpen();
    const db = this.db;
    if (!db || db.readOnly || this.disposed) return { noop: true, sessions: 0, documents: 0 };

    // One-time rewrite of pre-v2 hash-only file-meta keys, inside the
    // background pass — never in the query path. After it, every per-session
    // lookup below scans only that session's meta prefix.
    await this.migrateFileMetaKeys(db);

    const currentIds = new Set(sessions.map((s) => s.id));

    // Drop sessions whose directory disappeared since the last sync. The
    // disposed gate covers this loop and the trailing stats write: once
    // close starts, the pass skips them instead of writing into a db whose
    // close is already draining.
    for (const row of db.query({ key: { prefix: SESSION_META_PREFIX }, project: [] })) {
      if (this.disposed) return { noop: true, sessions: 0, documents: 0 };
      const sessionId = row.key.slice(SESSION_META_PREFIX.length);
      if (!currentIds.has(sessionId)) await this.deleteSessionDocs(db, sessionId);
    }

    let indexed = 0;
    for (const summary of sessions) {
      if (this.disposed) return { noop: true, sessions: 0, documents: 0 };
      try {
        await this.syncSession(db, summary);
        indexed++;
      } catch (error) {
        // One unreadable session must not abort the whole pass.
        this.log.warn('global search: failed to index session', {
          sessionId: summary.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.disposed) return { noop: true, sessions: 0, documents: 0 };
    const metaCount = db.query({ key: { prefix: '\0meta\\' }, project: [] }).length;
    const stats: StatsDoc = {
      kind: 'stats',
      sessions: indexed,
      documents: db.size - metaCount,
      lastIndexedAt: Date.now(),
    };
    await db.set(STATS_KEY, stats);
    this.fullSyncDone = true;
    if (this.syncReplaced) {
      // The pass REPLACED indexed documents (shrink rescan / title
      // overwrite), so their sort keys may have moved: page tokens from the
      // previous generation must restart instead of drifting.
      this.generation++;
    }
    return { noop: false, sessions: indexed, documents: stats.documents };
  }

  /**
   * One-time per-process migration of pre-v2 hash-only file-meta keys to the
   * session-scoped format (`fileMetaKey`). A single full prefix scan of the
   * meta namespace; per-session work afterwards only scans that session's
   * keys. Idempotent — a crash mid-migration just rescans on the next pass.
   */
  private async migrateFileMetaKeys(db: MiniDb<SearchDoc>): Promise<void> {
    if (this.fileMetaMigrated) return;
    const ops: BatchInputOp<SearchDoc>[] = [];
    for (const row of db.query({ key: { prefix: FILE_META_PREFIX }, project: [] })) {
      const rest = row.key.slice(FILE_META_PREFIX.length);
      if (rest.includes('\\')) continue; // already session-scoped
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      ops.push({ op: 'set', key: fileMetaKey(meta.sessionId, meta.path), value: meta });
      ops.push({ op: 'del', key: row.key });
    }
    // Batch the rewrite instead of one op per key; empty on every later pass.
    if (ops.length > 0) await db.batch(ops);
    this.fileMetaMigrated = true;
  }

  private async deleteSessionDocs(db: MiniDb<SearchDoc>, sessionId: string): Promise<void> {
    for (const row of db.query({ key: { prefix: `${sessionId}/` }, project: [] })) {
      await db.del(row.key);
    }
    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(sessionId) }, project: [] })) {
      await db.del(row.key);
    }
    await db.del(SESSION_META_PREFIX + sessionId);
  }

  private async syncSession(db: MiniDb<SearchDoc>, summary: SyncSessionInput): Promise<void> {
    const wireFiles = await collectWireFiles(summary.dir);
    const seenPaths = new Set(wireFiles.map((file) => file.path));

    // A wire file that vanished on its own (e.g. one agent's log deleted
    // while the session lives on): drop its docs and meta. Session-level
    // disappearance is handled separately in runSync. The scan is scoped to
    // THIS session's meta prefix — O(files of this session), independent of
    // the global session count.
    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(summary.id) } })) {
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      if (seenPaths.has(meta.path)) continue;
      await this.deleteFileDocs(db, meta);
      await db.del(row.key);
    }

    for (const file of wireFiles) {
      await this.syncWireFile(db, summary, file);
    }

    const title = summary.title ?? '';
    const titleKey = `${summary.id}/$title`;
    const existing = db.get(titleKey);
    if (title.length > 0) {
      if (existing?.kind !== 'title' || existing.text !== title) {
        const doc: TitleDoc = {
          kind: 'title',
          sessionId: summary.id,
          workspaceId: summary.workspaceId,
          sessionTitle: title,
          agentId: '',
          role: 'title',
          text: title,
          time: summary.updatedAt,
        };
        await db.set(titleKey, doc);
        // Overwriting an existing title doc moves its sort key mid-pagination
        // — a replacing change, unlike the additive first-time create.
        if (existing !== undefined) this.syncReplaced = true;
      }
    } else if (existing !== undefined) {
      await db.del(titleKey);
    }
    // Session marker: presence is the information — write only when missing.
    if (db.get(SESSION_META_PREFIX + summary.id) === undefined) {
      const sessionMeta: SessionMetaDoc = { kind: 'sessionMeta' };
      await db.set(SESSION_META_PREFIX + summary.id, sessionMeta);
    }
  }

  private async deleteFileDocs(db: MiniDb<SearchDoc>, meta: FileMetaDoc): Promise<void> {
    const prefix = `${meta.sessionId}/${meta.agentId}/${meta.source}:`;
    for (const row of db.query({ key: { prefix }, project: [] })) {
      await db.del(row.key);
    }
  }

  private async syncWireFile(
    db: MiniDb<SearchDoc>,
    summary: SyncSessionInput,
    file: WireFileRef,
  ): Promise<void> {
    let st: { size: number; mtimeMs: number; ino: number };
    try {
      st = await stat(file.path);
    } catch {
      return; // transiently unreadable — retry next pass
    }
    const size = st.size;
    const metaKey = fileMetaKey(summary.id, file.path);
    // New session-scoped key first, then the pre-v2 hash-only key (a cheap
    // point lookup, not a scan): metas written before the key migration are
    // honored and opportunistically rewritten under the new key.
    let meta = db.get(metaKey);
    let legacyKey: string | null = null;
    if (meta?.kind !== 'fileMeta') {
      const oldKey = legacyFileMetaKey(file.path);
      const legacy = db.get(oldKey);
      if (legacy?.kind === 'fileMeta') {
        meta = legacy;
        legacyKey = oldKey;
      }
    }
    const known = meta?.kind === 'fileMeta' ? meta : undefined;
    let offset = known?.offset ?? 0;
    let turnState: TurnCounterState = known?.turnState ?? initialTurnState();
    let stepState: StepTrackerState = known?.stepState ?? initialStepState();
    const fileMeta = (
      nextOffset: number,
      turns: TurnCounterState,
      steps: StepTrackerState,
    ): FileMetaDoc => ({
      kind: 'fileMeta',
      sessionId: summary.id,
      agentId: file.agentId,
      source: file.source,
      path: file.path,
      offset: nextOffset,
      size,
      mtimeMs: st.mtimeMs,
      ino: st.ino,
      turnState: turns,
      stepState: steps,
    });
    // Metas written before step tracking carry no `stepState`: rescan the
    // file from scratch so stepIds are all-or-nothing per file rather than
    // drifting mid-file (the shrink path does exactly this).
    const legacyMeta = known !== undefined && known.stepState === undefined;
    // An inode change means the file was replaced (atomic rewrite); a bumped
    // mtime at an unchanged size means an in-place rewrite. Both invalidate
    // the byte-offset watermark even though the size alone would not.
    const replacedFile = known?.ino !== undefined && known.ino !== st.ino;
    const rewrittenInPlace =
      known?.mtimeMs !== undefined && size === known.offset && st.mtimeMs > known.mtimeMs;
    if (size < offset || legacyMeta || replacedFile || rewrittenInPlace) {
      // File was rebuilt/truncated: drop its docs and rescan from scratch —
      // the turn counter and step tracker restart with it. A replacing
      // change: the docs' sort keys may move → bump the generation.
      this.syncReplaced = true;
      await this.deleteFileDocs(db, fileMeta(0, initialTurnState(), initialStepState()));
      offset = 0;
      turnState = initialTurnState();
      stepState = initialStepState();
    }
    if (size === offset) {
      // No growth: only rewrite the meta when something actually changed
      // (first sight, stat refresh after an upgrade, legacy key cleanup) —
      // an unchanged file must not cost a WAL record per pass.
      if (
        legacyKey !== null ||
        known === undefined ||
        known.size !== size ||
        known.mtimeMs !== st.mtimeMs ||
        known.ino !== st.ino ||
        known.offset !== offset
      ) {
        const ops: BatchInputOp<SearchDoc>[] = [
          { op: 'set', key: metaKey, value: fileMeta(offset, turnState, stepState) },
        ];
        if (legacyKey !== null) ops.push({ op: 'del', key: legacyKey });
        await db.batch(ops);
      }
      return;
    }

    // Read only the new byte range, in bounded chunks, consuming complete
    // lines; a trailing partial line (or a short read from a mid-read
    // truncation) is left for the next pass — the watermark below never
    // advances past bytes that were actually consumed. The line loop keeps
    // only line-sized strings alive instead of one `size - offset` buffer
    // plus a full split array.
    const handle = await open(file.path, 'r');
    const ops: BatchInputOp<SearchDoc>[] = [];
    let byteCursor = offset;
    try {
      let position = offset;
      let pending: Buffer = EMPTY_BUFFER; // partial-line bytes starting at byteCursor
      const chunk = Buffer.allocUnsafe(WIRE_READ_CHUNK_BYTES);
      while (position < size) {
        if (this.disposed) return; // meta not advanced: the next pass redoes the file
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - position),
          position,
        );
        if (bytesRead === 0) break;
        const slice = chunk.subarray(0, bytesRead);
        position += bytesRead;
        let start = 0;
        for (;;) {
          const nl = slice.indexOf(0x0a, start);
          if (nl === -1) break;
          const lineBuf =
            pending.length > 0
              ? Buffer.concat([pending, slice.subarray(start, nl)])
              : slice.subarray(start, nl);
          pending = EMPTY_BUFFER;
          const lineOffset = byteCursor;
          byteCursor += lineBuf.length + 1;
          ({ turnState, stepState } = this.collectWireLine(
            ops,
            summary,
            file,
            lineBuf.toString('utf8'),
            lineOffset,
            { turnState, stepState },
          ));
          start = nl + 1;
        }
        // The chunk buffer is reused, so the unconsumed tail must be copied.
        pending =
          pending.length > 0
            ? Buffer.concat([pending, slice.subarray(start)])
            : Buffer.from(slice.subarray(start));
        if (ops.length >= WIRE_BATCH_OPS) {
          await db.batch(ops);
          ops.length = 0;
        }
      }
    } finally {
      await handle.close();
    }

    if (byteCursor === offset && legacyKey === null) return; // no complete line yet
    ops.push({ op: 'set', key: metaKey, value: fileMeta(byteCursor, turnState, stepState) });
    if (legacyKey !== null) ops.push({ op: 'del', key: legacyKey });
    await db.batch(ops);
  }

  /**
   * Turn/step counting and doc extraction for one complete wire line.
   * Returns the counter states advanced by the line (they are immutable and
   * replaced per line, so the caller threads them through the chunk loop).
   */
  private collectWireLine(
    ops: BatchInputOp<SearchDoc>[],
    summary: SyncSessionInput,
    file: WireFileRef,
    line: string,
    lineOffset: number,
    counters: { turnState: TurnCounterState; stepState: StepTrackerState },
  ): { turnState: TurnCounterState; stepState: StepTrackerState } {
    let { turnState, stepState } = counters;
    const analysis = analyzeWireLine(line);
    // Turn counting runs independently of indexing: every line moves the
    // counter (a text-less user message still opens a turn).
    const advanced = advanceTurnCounter(turnState, analysis.turn);
    // A turn boundary invalidates the step mapping: a new turn opens
    // (`open`, or `ensure` opening a fallback turn from no-turn), or an
    // `undo` rewinds the counter mid-turn.
    if (
      analysis.turn.kind === 'open' ||
      analysis.turn.kind === 'undo' ||
      (analysis.turn.kind === 'ensure' && !turnState.hasTurn)
    ) {
      stepState = initialStepState();
    }
    turnState = advanced.state;
    stepState = advanceStepTracker(stepState, analysis.step);
    const extracted = analysis.messages;
    for (let i = 0; i < extracted.length; i++) {
      const e = extracted[i]!;
      const stepOrdinal = e.stepUuid !== undefined ? stepState.byUuid[e.stepUuid] : undefined;
      const doc: MessageDoc = {
        kind: 'message',
        sessionId: summary.id,
        workspaceId: summary.workspaceId,
        sessionTitle: summary.title ?? '',
        agentId: file.agentId,
        role: e.role,
        text: e.text.length > MAX_DOC_TEXT_CHARS ? e.text.slice(0, MAX_DOC_TEXT_CHARS) : e.text,
        time: e.time ?? summary.updatedAt,
        turn: advanced.docTurn,
        // A doc whose step cannot be resolved (no `step.begin` seen, or a
        // turn boundary invalidated the mapping) just omits the id.
        stepId:
          advanced.docTurn !== undefined && stepOrdinal !== undefined
            ? `t${advanced.docTurn}.${stepOrdinal}`
            : undefined,
      };
      // A line can yield several docs — the per-line index keeps keys unique.
      ops.push({
        op: 'set',
        key: `${docKeyPrefix(summary.id, file)}${lineOffset}:${i}`,
        value: doc,
      });
    }
    return { turnState, stepState };
  }

  // -- index-route query ---------------------------------------------------------

  /**
   * Serve one page from the currently published generation. Never waits for
   * an open, sync, reopen or reindex: with no published base it answers with
   * `building` semantics (or fails fast when the last open failed), and the
   * page-token generation check runs against the base pinned at request
   * time.
   */
  async search(params: CoreSearchParams): Promise<CoreSearchResult> {
    const { q, budgets } = params;
    const db = this.db;
    if (db === null) {
      if (this.disposed) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      if (this.openError !== null) {
        // The last open failed (e.g. a read-only open racing a writer's
        // compaction): surface the failure; the caller kicks a background
        // retry, so search traffic self-heals the index once the transient
        // cause goes away — a successful retry clears openError.
        throw new GlobalSearchError(
          'index_unavailable',
          `search index failed to open: ${this.openError}`,
        );
      }
      if (params.pageToken !== undefined) {
        // No generation to validate the token against — the client restarts
        // the search once a base is published.
        throw new GlobalSearchError(
          'invalid_page_token',
          'the search index is not ready yet; restart the search',
        );
      }
      return { kind: 'building', index: this.buildingView() };
    }

    let freshnessStale = false;
    let serveDb = db;
    if (serveDb.readOnly) {
      // Cheap freshness probe (3 stats). A changed fingerprint refreshes in
      // the BACKGROUND — this request deliberately serves the stale
      // generation instead of waiting for a catch-up or a full reopen.
      let fp: string | null = null;
      try {
        fp = await this.computeFingerprint();
      } catch (error) {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      }
      // A background refresh may have swapped (and closed) the captured
      // handle during the await. Re-pin to the currently published handle.
      // (The async query path awaits again below, so a later swap can still
      // close it mid-query — the bounded pass retries once on the fresh
      // handle for exactly that race.)
      if (this.db === null) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      serveDb = this.db;
      if (serveDb.readOnly) {
        freshnessStale = fp === null || fp !== this.fingerprint || this.refreshPromise !== null;
        if (fp !== null && fp !== this.fingerprint) void this.refresh();
      }
      // else: the reopen promoted this instance to writer (the old writer's
      // lock was gone) — the caller's coordinator picks up sync work from
      // here; freshnessStale stays false.
    }
    const generation = this.tokenGeneration();
    const page = decodePageToken(q, 'index', params.pageToken, generation);

    // The served handle's text base is still (re)building — the deferred
    // open-time build on the no-generation fallback path has not committed (or
    // finally failed). Answer with the building page instead of running a
    // pass that would raise TextIndexBuildingError; the background build
    // commits and a later search serves real hits. Tokens from an older
    // generation already failed validation above, so reaching here with a
    // building handle is always a first-page situation.
    if (serveDb.textIndexBuilding(q.mode === 'literal' ? TRI_INDEX_NAME : TEXT_INDEX_NAME)) {
      return { kind: 'building', index: this.buildingView(serveDb) };
    }

    // One bounded text-index pass: db.searchBoundedAsync returns at most the
    // budgeted candidates with their scores (the async variant — postings
    // reads and disk-mode value reads run off the event loop);
    // container/role/time filters and the requested sort are applied in
    // memory. (A separate db.query({text}) for pagination would scan the
    // same postings a second time.)
    let candidates: { key: string; value: SearchDoc | undefined; score: number }[];
    let incomplete: GlobalSearchIncomplete | undefined;
    const runBounded = (
      db2: MiniDb<SearchDoc>,
    ): Promise<{
      hits: { key: string; value: SearchDoc; score: number }[];
      visits: number;
      truncated: boolean;
    }> => {
      if (q.mode === 'literal') {
        // Ask for one past the cap so an over-cap candidate set is
        // detectable; the postings budget bounds the index-side work before
        // confirmation even starts.
        return db2.searchBoundedAsync(TRI_INDEX_NAME, q.query, {
          op: 'AND',
          limit: budgets.literalCandidateCap + 1,
          maxVisits: budgets.postingsVisitBudget,
        });
      }
      return db2.searchBoundedAsync(TEXT_INDEX_NAME, q.query, {
        op: q.op,
        limit: budgets.maxTextHits + 1,
        maxVisits: budgets.postingsVisitBudget,
      });
    };
    try {
      let res: {
        hits: { key: string; value: SearchDoc; score: number }[];
        visits: number;
        truncated: boolean;
      };
      try {
        res = await runBounded(serveDb);
      } catch (error) {
        // The async query path awaits: a background read-only refresh may
        // have swapped (and closed) the pinned handle mid-query. Re-pin the
        // currently published handle and retry ONCE — anything else is a
        // real failure.
        const msg = error instanceof Error ? error.message : String(error);
        const closedRace =
          msg.includes('postings file is closed') ||
          msg.includes('MiniDb is closed') ||
          msg.includes('ValueReader is not open');
        if (!closedRace || this.db === null || this.db === serveDb) throw error;
        serveDb = this.db;
        res = await runBounded(serveDb);
      }
      if (q.mode === 'literal') {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > budgets.literalCandidateCap) {
          candidates.length = budgets.literalCandidateCap;
          incomplete ??= 'candidate_cap';
        }
      } else {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > budgets.maxTextHits) {
          candidates.length = budgets.maxTextHits;
          incomplete ??= 'candidate_cap';
        }
      }
    } catch (error) {
      // The base build's state flipped between the early check and the pass
      // (or a read-only refresh swapped in a still-building handle mid-page):
      // serve the same building page the early check produces.
      if (error instanceof TextIndexBuildingError) {
        return { kind: 'building', index: this.buildingView(serveDb) };
      }
      // A read-only instance can open before the writer has created the text
      // index — serve an empty page instead of failing the search.
      if (error instanceof Error && error.message.includes('no such text index')) {
        return {
          kind: 'page',
          rows: [],
          hasMore: false,
          incomplete: undefined,
          generation,
          index: this.readIndexView(serveDb, freshnessStale),
        };
      }
      throw error;
    }

    const budget: MatchBudget = {
      deadlineAt: Date.now() + budgets.queryDeadlineMs,
      textCharsLeft: budgets.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    const matched = matchDocs(q, candidates, boundary, budget);
    incomplete ??= matched.incomplete;
    const { pageRows, hasMore } = paginateRows(q, page, matched.rows);
    return {
      kind: 'page',
      rows: pageRows,
      hasMore,
      incomplete,
      generation,
      index: this.readIndexView(serveDb, freshnessStale),
    };
  }

  // -- reindex & status ------------------------------------------------------------

  /**
   * Full rebuild: close the handle, wipe the directory and reopen. The
   * caller (the service) blocks new sync passes beforehand and runs the
   * authoritative sync afterwards.
   */
  async reindex(): Promise<void> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      throw new GlobalSearchError(
        'readonly_index',
        'another process holds the search-index write lock; reindex from that process',
      );
    }
    // Let an in-flight refresh settle before closing the db it swaps.
    await this.refreshPromise?.catch(() => {});
    const db = this.db;
    if (db) {
      await db.close().catch(() => {});
      this.db = null;
    }
    this.openPromise = null;
    this.fullSyncDone = false;
    this.lockToken = undefined;
    await rm(this.indexDir, { recursive: true, force: true });
    await this.ensureOpen();
  }

  /**
   * Synchronous lifecycle snapshot (stage 5) — never kicks an open, never
   * awaits: the diagnostic view of `stopped → opening → ready →
   * building/degraded → closing`. 'degraded' means NO base is serving (the
   * last open failed); a published base that keeps serving after a failed
   * background refresh stays 'ready' — the failure rides the `degraded`
   * message field of the page/status surfaces, same as the per-page
   * `indexState` discipline.
   */
  lifecycleState(): CoreLifecycleReport {
    if (this.disposed) return { state: this.db === null ? 'stopped' : 'closing' };
    const db = this.db;
    if (db === null) {
      if (this.openPromise !== null) return { state: 'opening' };
      if (this.openError !== null) return { state: 'degraded', detail: this.openError };
      return { state: 'stopped' };
    }
    if (db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME)) {
      return { state: 'building' };
    }
    return { state: 'ready' };
  }

  async status(): Promise<CoreStatus> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      // An explicit status call may wait for the refresh; searches may not.
      await this.refresh();
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      lastIndexedAt: stats?.kind === 'stats' ? stats.lastIndexedAt : null,
      generation: this.generation,
      readOnly: this.db?.readOnly === true,
      lockToken: this.lockToken,
      degraded: this.lastRefreshError?.message,
      lifecycle: this.lifecycleState(),
    };
  }

  // -- index-state views ------------------------------------------------------------

  /** The view served while no queryable base is available. */
  private buildingView(db?: MiniDb<SearchDoc>): CoreIndexView {
    const handle = db ?? this.db;
    const stats = handle?.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    return {
      state: 'building',
      indexedSessions: indexed,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      readOnly: handle?.readOnly === true,
      freshnessStale: true,
      degraded: this.lastRefreshError?.message,
      lockToken: this.lockToken,
    };
  }

  private readIndexView(db: MiniDb<SearchDoc>, freshnessStale: boolean): CoreIndexView {
    const stats = db.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    const documents = stats?.kind === 'stats' ? stats.documents : 0;
    // A deferred open-time base build (no-generation fallback path) puts the
    // served handle's text indexes into the building state — surface it as
    // the same 'building' the first-sync window uses, whatever the process role.
    const building = db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME);
    return {
      state: building ? 'building' : db.readOnly ? 'readonly' : this.fullSyncDone ? 'ready' : 'building',
      indexedSessions: indexed,
      documents,
      readOnly: db.readOnly,
      freshnessStale,
      degraded: this.lastRefreshError?.message,
      lockToken: this.lockToken,
    };
  }
}

// ---------------------------------------------------------------------------
// wire file enumeration & doc keys
// ---------------------------------------------------------------------------

interface WireFileRef {
  readonly path: string;
  /** 'main' or a subagent id, for both legacy and v2 layouts. */
  readonly agentId: string;
  /**
   * Key discriminator: a session can carry BOTH a legacy root wire.jsonl and
   * v2 per-agent logs; without this their `<agentId>/<offset>` keys collide.
   */
  readonly source: 'root' | 'agents';
}

async function collectWireFiles(sessionDir: string): Promise<WireFileRef[]> {
  const files: WireFileRef[] = [];
  const root = join(sessionDir, WIRE_FILENAME);
  try {
    if ((await stat(root)).isFile()) files.push({ path: root, agentId: 'main', source: 'root' });
  } catch {
    // no legacy root log
  }
  const agentsDir = join(sessionDir, 'agents');
  try {
    const entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
      const path = join(entry.parentPath, entry.name);
      files.push({ path, agentId: relative(agentsDir, entry.parentPath), source: 'agents' });
    }
  } catch {
    // no agents dir
  }
  return files;
}

function docKeyPrefix(sessionId: string, file: WireFileRef): string {
  return `${sessionId}/${file.agentId}/${file.source}:`;
}

/** Same rebuildability test as `MiniDb.openOrRebuild`. */
function isRebuildableCorruption(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error !== null &&
      typeof error === 'object' &&
      (error as { name?: string }).name === 'CorruptFrameError')
  );
}
