/**
 * `search` module — `IGlobalSearchService` implementation (temporary feature,
 * lives in kap-server until it graduates into agent-core-v2).
 *
 * Cross-session full-text search over user messages, assistant text and
 * session titles, backed by a single minidb database at
 * `<homeDir>/search-index`.
 *
 * Concurrency model — "the lock is the election":
 *   - `MiniDb.open({ onLockFail: 'readonly' })`: the process that grabs the
 *     exclusive write lock becomes the indexer (build + incremental sync);
 *     every other process opens read-only and never rescans wire files.
 *   - A read-only instance refreshes before each search via a cheap file
 *     fingerprint (db.wal / db.snapshot / db.textindexes.json): unchanged →
 *     serve the in-memory view; WAL pure-append on the same inode →
 *     `MiniDb.catchUpFromWal` incremental replay; anything else → close +
 *     full reopen. When the indexer dies, the next opener takes the lock and
 *     becomes the new indexer.
 *   - In-process, syncs are serialized behind a single-flight promise.
 *
 * Incremental indexing anchors on wire.jsonl byte offsets (the files are
 * append-only JSONL): a `\0meta\file\<path>` key per wire file records how
 * far it has been indexed; growth re-reads only the new byte range, shrinkage
 * drops the file's docs and rescans. Session title docs (`<sid>/$title`) are
 * overwritten each sync; disappeared sessions are dropped by key prefix.
 *
 * Registration: this module is side-effect-imported by `start.ts` BEFORE
 * `bootstrap()` runs, so the module-level `registerScopedService` below lands
 * in the DI registry in time and the service is instantiated (App scope,
 * OnScopeCreated) with the rest — which also exposes it on the `/api/v1/debug`
 * reflection surface as `globalSearch` with zero extra code.
 */

import { createHash } from 'node:crypto';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  createDecorator,
  IBootstrapService,
  ILogService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  sessionDirOf,
  workspacePersistenceScope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { LockError, MiniDb, normalizeLiteral, tokenize, type BatchInputOp } from '@moonshot-ai/minidb';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import type {
  GlobalSearchHit,
  GlobalSearchIndexState,
  GlobalSearchPage,
  GlobalSearchQuery,
  GlobalSearchSource,
} from './contract';
import { makeSnippet } from './snippet';
import { analyzeWireLine, type StepEffect, type TurnEffect } from './wireExtract';

// ---------------------------------------------------------------------------
// Constants & stored document shapes
// ---------------------------------------------------------------------------

const INDEX_DIR_NAME = 'search-index';
const TEXT_INDEX_NAME = 'body';
/** n-gram substring index backing literal mode, alongside 'body'. */
const TRI_INDEX_NAME = 'tri';
const WIRE_FILENAME = 'wire.jsonl';

/** Key namespaces inside the single db. */
const FILE_META_PREFIX = '\0meta\\file\\';
const SESSION_META_PREFIX = '\0meta\\session\\';
const STATS_KEY = '\0meta\\stats';

/**
 * minidb keys are limited to 128 bytes, far shorter than an absolute wire
 * path — the file meta key is a hash of the path (the path itself, and the
 * owning session, live in the value).
 */
function fileMetaKey(filePath: string): string {
  return FILE_META_PREFIX + createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}

/** Cap one indexed document's text so huge pastes do not bloat the index. */
const MAX_DOC_TEXT_CHARS = 20_000;
/** Upper bound for text-index candidates handed to the scoring map / query. */
const MAX_TEXT_HITS = 100_000;
/**
 * Upper bound for literal-mode n-gram candidates handed to the confirmation
 * pass (a store `get` plus a substring scan each — pure CPU). Beyond the cap
 * the page is truncated and flagged `incomplete: 'candidate_cap'`.
 */
const LITERAL_CANDIDATE_CAP = 10_000;
/** Sessions are listed in pages of this size. */
const SESSION_PAGE_SIZE = 500;

interface MessageDoc {
  readonly kind: 'message';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly time: number;
  /**
   * 0-based turn ordinal in the transcript view (groupTurns numbering). Absent
   * for docs indexed before turn tracking existed.
   */
  readonly turn?: number;
  /**
   * Transcript step id (`t<turn>.<step>`, engine live numbering from the wire
   * record's `step` field) of the step that produced this assistant text.
   * Absent for user docs and docs indexed before step tracking existed.
   */
  readonly stepId?: string;
}

interface TitleDoc {
  readonly kind: 'title';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** Titles belong to the session, not an agent — always ''. */
  readonly agentId: '';
  readonly role: 'title';
  readonly text: string;
  readonly time: number;
}

interface FileMetaDoc {
  readonly kind: 'fileMeta';
  /** Owning session, used to drop metas when a session disappears. */
  readonly sessionId: string;
  /** Doc-key coordinates of this file's documents (see `docKeyPrefix`). */
  readonly agentId: string;
  readonly source: 'root' | 'agents';
  /** Absolute wire path (debugging aid; the key is its hash). */
  readonly path: string;
  /** Byte offset up to which the wire file has been indexed. */
  readonly offset: number;
  readonly size: number;
  /**
   * Turn counter state at `offset` — persisted with the watermark so an
   * incremental pass resumes counting instead of restarting at turn 0.
   * Absent in metas written before turn tracking; treated as the initial
   * state, which makes a legacy meta resume mid-file with a zeroed counter —
   * an accepted one-time drift, self-healing on the next shrink/rescan.
   */
  readonly turnState?: TurnCounterState;
  /**
   * Step tracker state at `offset` — persisted with the watermark for the
   * same resume reason as `turnState`. Absent in metas written before step
   * tracking: such a file is RESCANNED from scratch (docs dropped, offset
   * reset) so stepIds are all-or-nothing per file instead of drifting.
   */
  readonly stepState?: StepTrackerState;
}

interface SessionMetaDoc {
  readonly kind: 'sessionMeta';
}

// ---------------------------------------------------------------------------
// Turn counter (transcript groupTurns numbering, replayed over the wire file)
// ---------------------------------------------------------------------------

interface TurnOpener {
  readonly turn: number;
  readonly anchor: boolean;
}

interface TurnCounterState {
  /** Ordinal the next opened turn will get (0-based). */
  readonly next: number;
  /** Whether a turn is currently open (groupTurns' `ensureTurn` gate). */
  readonly hasTurn: boolean;
  /** Turn openers, in order — the replay stack for `context.undo`. */
  readonly openers: readonly TurnOpener[];
}

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

// ---------------------------------------------------------------------------
// Step tracker (transcript step ids `t<turn>.<step>`, per-turn uuid → ordinal)
// ---------------------------------------------------------------------------

interface StepTrackerState {
  /** Current turn's step uuid → ordinal (the wire `step` field, else the fallback counter). */
  readonly byUuid: Record<string, number>;
  /** `step.begin` count within the current turn — the fallback ordinal source. */
  readonly begins: number;
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

interface StatsDoc {
  readonly kind: 'stats';
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number;
}

type SearchDoc = MessageDoc | TitleDoc | FileMetaDoc | SessionMetaDoc | StatsDoc;

/**
 * Fire-and-forget close promises produced by `dispose()` (DI disposal is
 * synchronous). The server shutdown path awaits these via
 * `drainGlobalSearchDisposals()` before the homeDir is released, so a
 * teardown `rm()` never races an in-flight minidb open/close.
 */
const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  await Promise.all(pendingDisposals);
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type GlobalSearchErrorReason =
  | 'invalid_query'
  | 'invalid_page_token'
  | 'readonly_index'
  | 'index_unavailable';

export class GlobalSearchError extends Error {
  constructor(
    readonly reason: GlobalSearchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalSearchError';
  }
}

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  /** Full rebuild: wipe the index and rescan every wire file. */
  reindex(): Promise<{ sessions: number; documents: number }>;
  status(): Promise<{ sessions: number; documents: number; lastIndexedAt: number | null }>;
  /**
   * Wire the live-transcript source for the in-memory search route. Called
   * once from the composition root (start.ts) after `TranscriptService` is
   * constructed; until then every search takes the index route.
   */
  setLiveTranscriptSource(source: LiveTranscriptSource): void;
}

export const IGlobalSearchService = createDecorator<IGlobalSearchService>('globalSearch');

/**
 * Live-transcript access behind the in-memory (live) search route.
 * Implemented by `TranscriptService` (`src/services/transcript/`); declared
 * here with only the three methods the route needs, so the search module
 * does not import the transcript service's dependency stack.
 */
export interface LiveTranscriptSource {
  /** Transcript store of a session live in this process; undefined when not in memory. */
  forSessionLive(sessionId: string): TranscriptStore | undefined;
  /** Resolves when the session's initial history backfill has landed. */
  whenReady(sessionId: string): Promise<void>;
  /** Replay one agent's persisted history into the live store (idempotent per agent). */
  ensureAgentHistory(sessionId: string, agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query normalization & page tokens
// ---------------------------------------------------------------------------

interface NormalizedQuery {
  readonly query: string;
  readonly mode: 'terms' | 'literal';
  /**
   * Literal mode only: `normalizeLiteral(query)`, computed once here and
   * reused by candidate confirmation and the snippet anchor. The n-gram
   * index's query tokenizer applies the same normalization to the query
   * terms, so index and comparison agree by construction.
   */
  readonly literalQuery?: string;
  /**
   * Terms mode only: the query's deduplicated terms under minidb's default
   * `tokenize` (the same tokenizer the 'body' text index applies to both
   * sides). Computed once here so the live route's in-memory AND match agrees
   * with the index route by construction. Empty when the query tokenizes to
   * nothing (e.g. punctuation only) — both routes then match zero docs,
   * mirroring `TextIndex.search`.
   */
  readonly termsQuery?: readonly string[];
  readonly op: 'AND' | 'OR';
  readonly container?: { readonly sessionId?: string; readonly agentId?: string };
  readonly role?: 'user' | 'assistant' | 'title';
  readonly startTime?: number;
  readonly endTime?: number;
  readonly sort: 'score' | 'time_desc' | 'time_asc';
  readonly pageSize: number;
}

function normalizeQuery(input: GlobalSearchQuery): NormalizedQuery {
  const mode = input.mode ?? 'terms';
  // Literal matching is byte-exact (mod NFKC/case) — whitespace is part of
  // the query, so it is never trimmed.
  const query = mode === 'literal' ? input.query : input.query.trim();
  if (query.length === 0) {
    throw new GlobalSearchError('invalid_query', 'query must be a non-empty string');
  }
  const literalQuery = mode === 'literal' ? normalizeLiteral(query) : undefined;
  // NOTE: the <2-code-point gate for literal queries lives in the INDEX route
  // (`searchIndex`) — it is a constraint of the n-gram candidate index, not of
  // literal matching itself. The live route (pure in-memory scan) accepts any
  // non-empty literal query, down to a single code point.
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new GlobalSearchError('invalid_query', 'pageSize must be an integer between 1 and 50');
  }
  return {
    query,
    mode,
    literalQuery,
    termsQuery: mode === 'terms' ? [...new Set(tokenize(query))] : undefined,
    op: input.op ?? 'AND',
    container: input.container,
    role: input.role,
    startTime: input.startTime,
    endTime: input.endTime,
    sort: input.sort ?? 'score',
    pageSize,
  };
}

/**
 * The page token encodes a fingerprint of the query conditions plus the skip
 * offset — changing conditions mid-pagination invalidates the token (same
 * rule as Lark's search API). The serving route (`source`) is part of the
 * fingerprint: a route flip mid-pagination (e.g. the container session
 * closed and the live route fell away) invalidates the token too, so the
 * client restarts the search instead of silently switching result sets.
 */
function tokenFingerprint(q: NormalizedQuery, source: GlobalSearchSource): string {
  const basis = JSON.stringify([
    q.query,
    q.mode,
    q.op,
    q.container?.sessionId,
    q.container?.agentId,
    q.role,
    q.startTime,
    q.endTime,
    q.sort,
    source,
  ]);
  return createHash('sha256').update(basis).digest('base64url').slice(0, 16);
}

function encodePageToken(q: NormalizedQuery, source: GlobalSearchSource, skip: number): string {
  return Buffer.from(JSON.stringify({ f: tokenFingerprint(q, source), s: skip })).toString(
    'base64url',
  );
}

function decodePageToken(
  q: NormalizedQuery,
  source: GlobalSearchSource,
  token: string | undefined,
): number {
  if (token === undefined) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  const p = parsed as { f?: unknown; s?: unknown };
  if (p.f !== tokenFingerprint(q, source)) {
    throw new GlobalSearchError(
      'invalid_page_token',
      'pageToken does not match the query conditions; query conditions must not change mid-pagination',
    );
  }
  if (typeof p.s !== 'number' || !Number.isInteger(p.s) || p.s < 0) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  return p.s;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GlobalSearchService implements IGlobalSearchService {
  declare readonly _serviceBrand: undefined;

  /** Minimum interval between search-triggered sync passes (test knob). */
  syncDebounceMs = 2_000;

  /** Literal-mode candidate cap (test knob, see LITERAL_CANDIDATE_CAP). */
  literalCandidateCap = LITERAL_CANDIDATE_CAP;

  private db: MiniDb<SearchDoc> | null = null;
  private openPromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private lastSyncStartedAt = 0;
  private fullSyncDone = false;
  /** WAL watermark (bytes applied) for read-only catch-up. */
  private walOffset = 0;
  private fingerprint = '';
  private summaries = new Map<string, SessionSummary>();
  private disposed = false;
  /** Set while `reindex()` swaps the db — syncs started meanwhile are no-ops. */
  private reindexing = false;
  /** Live-transcript source for the in-memory route; null until start.ts wires it. */
  private liveSource: LiveTranscriptSource | null = null;

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    // App-scope OnScopeCreated activation: kick the first full sync off in the
    // background so server bootstrap never blocks on indexing.
    this.kickBackgroundSync();
  }

  setLiveTranscriptSource(source: LiveTranscriptSource): void {
    this.liveSource = source;
  }

  // -- lifecycle ---------------------------------------------------------------

  private get indexDir(): string {
    return join(this.bootstrap.homeDir, INDEX_DIR_NAME);
  }

  private ensureOpen(): Promise<void> {
    this.openPromise ??= this.openDb().catch((error: unknown) => {
      this.openPromise = null;
      throw error;
    });
    return this.openPromise;
  }

  private async openDb(): Promise<void> {
    const db = await this.openSearchDb();
    // The scope may have been disposed while the (slow) open was in flight —
    // close the handle immediately instead of leaking it and writing the
    // text-index definition below into a directory the caller may already be
    // deleting.
    if (this.disposed) {
      await db.close().catch(() => {});
      throw new GlobalSearchError('index_unavailable', 'search service is disposed');
    }
    this.db = db;
    this.walOffset = db.recoveryInfo?.walScanEnd ?? 0;
    if (!db.readOnly) {
      // Both indexes are created here (not at first write) so a pre-existing
      // db gets the tri index built over its current documents on first open
      // after the upgrade, and a read-only peer only ever reopens on the
      // definitions-file fingerprint change.
      for (const [name, options] of [
        [TEXT_INDEX_NAME, { fields: ['text'] }],
        [TRI_INDEX_NAME, { fields: ['text'], tokenizer: 'ngram' }],
      ] as const) {
        try {
          await db.createTextIndex(name, options);
        } catch (error) {
          if (!(error instanceof Error && error.message.includes('already exists'))) throw error;
        }
      }
    }
    this.fingerprint = await this.computeFingerprint();
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
      await rm(this.indexDir, { recursive: true, force: true });
      return MiniDb.open<SearchDoc>(opts);
    }
  }

  dispose(): void {
    this.disposed = true;
    // DI disposal is synchronous, but closing a MiniDb is not: wait for any
    // in-flight open to settle, then close the handle. The promise is
    // registered module-level so the server shutdown path
    // (`drainGlobalSearchDisposals` in start.ts) can await it before the
    // homeDir is torn down — otherwise teardown rm() races the close and
    // fails with ENOTEMPTY.
    const pending = (async () => {
      await this.openPromise?.catch(() => {});
      const db = this.db;
      this.db = null;
      if (db) await db.close().catch(() => {});
    })();
    pendingDisposals.add(pending);
    void pending.finally(() => pendingDisposals.delete(pending));
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
   * `catchUpFromWal`; anything else → close + full reopen (which may also
   * promote this process to indexer when the old writer's lock is gone).
   */
  private refreshReadonly(): Promise<void> {
    this.refreshPromise ??= this.doRefreshReadonly()
      .catch(() => {
        // A failed refresh must not fail the search — serve the stale view.
      })
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
    // watermark no longer aligns: close and reopen from scratch.
    await db.close().catch(() => {});
    if (this.db === db) {
      this.db = null;
      this.openPromise = null;
      await this.ensureOpen();
    }
  }

  // -- sync (indexer only) --------------------------------------------------------

  private kickBackgroundSync(): void {
    void this.ensureSyncStarted().catch((error: unknown) => {
      this.log.warn('global search: background sync failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Single-flight: concurrent callers share the in-flight sync. */
  private ensureSyncStarted(): Promise<void> {
    if (this.syncPromise === null) {
      const p = this.runSync().finally(() => {
        if (this.syncPromise === p) this.syncPromise = null;
      });
      this.syncPromise = p;
    }
    return this.syncPromise;
  }

  private async runSync(): Promise<void> {
    // `reindexing`: a rebuild is swapping the db out — this pass is a no-op;
    // the rebuild itself runs the authoritative sync when done.
    if (this.disposed || this.reindexing) return;
    const sessions = await this.listAllSessions();
    // Nothing to index and no index on disk yet: don't even create the
    // `<home>/search-index` directory — it would show up in the fs folder
    // picker and cost every server boot a pointless db open.
    if (sessions.length === 0 && !(await pathExists(this.indexDir))) {
      this.summaries = new Map();
      this.lastSyncStartedAt = Date.now();
      this.fullSyncDone = true;
      return;
    }

    await this.ensureOpen();
    const db = this.db;
    if (!db || db.readOnly || this.disposed) return;
    this.lastSyncStartedAt = Date.now();

    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    const currentIds = new Set(sessions.map((s) => s.id));

    // Drop sessions whose directory disappeared since the last sync.
    for (const row of db.query({ key: { prefix: SESSION_META_PREFIX }, project: [] })) {
      const sessionId = row.key.slice(SESSION_META_PREFIX.length);
      if (!currentIds.has(sessionId)) await this.deleteSessionDocs(db, sessionId);
    }

    let indexed = 0;
    for (const summary of sessions) {
      if (this.disposed) return;
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

    const metaCount = db.query({ key: { prefix: '\0meta\\' }, project: [] }).length;
    const stats: StatsDoc = {
      kind: 'stats',
      sessions: indexed,
      documents: db.size - metaCount,
      lastIndexedAt: Date.now(),
    };
    await db.set(STATS_KEY, stats);
    this.fullSyncDone = true;
  }

  private async listAllSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sessionIndex.list({ cursor, limit: SESSION_PAGE_SIZE });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  private async deleteSessionDocs(db: MiniDb<SearchDoc>, sessionId: string): Promise<void> {
    for (const row of db.query({ key: { prefix: `${sessionId}/` }, project: [] })) {
      await db.del(row.key);
    }
    for (const row of db.query({ key: { prefix: FILE_META_PREFIX } })) {
      if (row.value.kind === 'fileMeta' && row.value.sessionId === sessionId) {
        await db.del(row.key);
      }
    }
    await db.del(SESSION_META_PREFIX + sessionId);
  }

  private async syncSession(db: MiniDb<SearchDoc>, summary: SessionSummary): Promise<void> {
    const sessionDir = sessionDirOf(
      this.bootstrap.homeDir,
      workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
      summary.id,
    );
    const wireFiles = await collectWireFiles(sessionDir);
    const seenPaths = new Set(wireFiles.map((file) => file.path));

    // A wire file that vanished on its own (e.g. one agent's log deleted
    // while the session lives on): drop its docs and meta. Session-level
    // disappearance is handled separately in runSync.
    for (const row of db.query({ key: { prefix: FILE_META_PREFIX } })) {
      const meta = row.value;
      if (meta.kind !== 'fileMeta' || meta.sessionId !== summary.id) continue;
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
    summary: SessionSummary,
    file: WireFileRef,
  ): Promise<void> {
    let size: number;
    try {
      size = (await stat(file.path)).size;
    } catch {
      return; // transiently unreadable — retry next pass
    }
    const metaKey = fileMetaKey(file.path);
    const meta = db.get(metaKey);
    let offset = meta?.kind === 'fileMeta' ? meta.offset : 0;
    let turnState: TurnCounterState =
      meta?.kind === 'fileMeta' ? (meta.turnState ?? initialTurnState()) : initialTurnState();
    let stepState: StepTrackerState =
      meta?.kind === 'fileMeta' ? (meta.stepState ?? initialStepState()) : initialStepState();
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
      turnState: turns,
      stepState: steps,
    });
    // Metas written before step tracking carry no `stepState`: rescan the
    // file from scratch so stepIds are all-or-nothing per file rather than
    // drifting mid-file (the shrink path does exactly this).
    const legacyMeta = meta?.kind === 'fileMeta' && meta.stepState === undefined;
    if (size < offset || legacyMeta) {
      // File was rebuilt/truncated: drop its docs and rescan from scratch —
      // the turn counter and step tracker restart with it.
      await this.deleteFileDocs(db, fileMeta(0, initialTurnState(), initialStepState()));
      offset = 0;
      turnState = initialTurnState();
      stepState = initialStepState();
    }
    if (size === offset) {
      await db.set(metaKey, fileMeta(offset, turnState, stepState));
      return;
    }

    // Read only the new byte range; consume up to the last complete line. A
    // short read (the file was truncated between stat and read) just defers
    // the remainder to the next pass — the watermark below never advances
    // past bytes that were actually read.
    const handle = await open(file.path, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.allocUnsafe(size - offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return; // no complete line yet
    const complete = buf.subarray(0, lastNl + 1).toString('utf8');

    const ops: BatchInputOp<SearchDoc>[] = [];
    let byteCursor = offset;
    for (const line of complete.split('\n')) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      const lineOffset = byteCursor;
      byteCursor += lineBytes;
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
    }
    const newOffset = offset + Buffer.byteLength(complete, 'utf8');
    ops.push({ op: 'set', key: metaKey, value: fileMeta(newOffset, turnState, stepState) });
    await db.batch(ops);
  }

  // -- public API ---------------------------------------------------------------

  /**
   * Route: a container-scoped query on a session that is live in this process
   * scans the in-memory transcript store instead of the index, in both terms
   * and literal mode. Anything else takes the index route. The live route
   * never falls back on error — the store being in hand means the session is
   * alive, so a scan failure is a real error, not a degradation signal.
   */
  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const q = normalizeQuery(input);
    const sessionId = q.container?.sessionId;
    const liveStore = sessionId !== undefined ? this.liveSource?.forSessionLive(sessionId) : undefined;
    if (liveStore !== undefined && sessionId !== undefined) {
      return this.searchLive(q, sessionId, liveStore, input.pageToken);
    }
    return this.searchIndex(q, input.pageToken);
  }

  // -- live route (in-memory transcript scan) ------------------------------------

  private async searchLive(
    q: NormalizedQuery,
    sessionId: string,
    store: TranscriptStore,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    const skip = decodePageToken(q, 'live', pageToken);
    const source = this.liveSource;
    if (source === null) {
      // Unreachable (the router only enters with a source-wired store), but a
      // null deref here would mask a wiring bug — fail loudly instead.
      throw new GlobalSearchError('index_unavailable', 'live transcript source is not wired');
    }
    // Backfill gates: the main-agent history, then every agent in scope, so
    // the scan covers full history rather than only post-resume content.
    await source.whenReady(sessionId);
    const agentIds =
      q.container?.agentId !== undefined
        ? [q.container.agentId]
        : store.agents().map((agent) => agent.agentId);
    for (const agentId of agentIds) {
      await source.ensureAgentHistory(sessionId, agentId);
    }
    const docs = await this.collectLiveDocs(sessionId, store, agentIds);
    // Literal mode needs no candidate index: every in-memory document is a
    // candidate and the shared confirmation pass decides. Terms mode runs the
    // in-memory AND match first, scoring each hit.
    const matched =
      q.mode === 'literal'
        ? this.matchDocs(
            q,
            docs.map((value) => ({ value, score: 0 })),
          )
        : this.matchDocs(q, matchLiveTerms(q.termsQuery ?? [], docs));
    return this.toPage(q, 'live', skip, matched, undefined, {
      state: 'ready',
      indexedSessions: 1,
      totalSessions: 1,
      documents: docs.length,
    });
  }

  /**
   * Flatten the live transcript store into the same document shape the index
   * route searches (`MessageDoc` / `TitleDoc`):
   *   - one user doc per non-empty `turn.prompt` (turn ordinal + turn time);
   *   - one assistant doc per assistant-role text frame (turn ordinal +
   *     stepId); thinking / tool / notice frames are skipped;
   *   - one title doc from the session-index summary, same as the sync path.
   * Text is trimmed and empty results skipped, mirroring the index side's
   * `wireExtract` (which trims both user and assistant text).
   */
  private async collectLiveDocs(
    sessionId: string,
    store: TranscriptStore,
    agentIds: readonly string[],
  ): Promise<(MessageDoc | TitleDoc)[]> {
    const summary = await this.sessionIndex.get(sessionId);
    const workspaceId = summary?.workspaceId ?? '';
    const sessionTitle = summary?.title ?? '';
    const fallbackTime = summary?.updatedAt ?? 0;
    const parseTime = (iso: string | undefined): number => {
      if (iso === undefined) return fallbackTime;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? fallbackTime : ms;
    };
    const docs: (MessageDoc | TitleDoc)[] = [];
    for (const agentId of agentIds) {
      const transcript = store.getAgent(agentId);
      if (transcript === undefined) continue;
      for (const item of transcript.snapshot().items) {
        if (item.kind !== 'turn') continue;
        const turnTime = parseTime(item.startedAt);
        const prompt = item.prompt?.trim() ?? '';
        if (prompt.length > 0) {
          docs.push({
            kind: 'message',
            sessionId,
            workspaceId,
            sessionTitle,
            agentId,
            role: 'user',
            text: prompt.length > MAX_DOC_TEXT_CHARS ? prompt.slice(0, MAX_DOC_TEXT_CHARS) : prompt,
            time: turnTime,
            turn: item.ordinal,
            stepId: undefined,
          });
        }
        for (const step of item.steps) {
          const stepTime = parseTime(step.endedAt ?? step.startedAt ?? item.startedAt);
          for (const frame of step.frames) {
            if (frame.kind !== 'text' || frame.role !== 'assistant') continue;
            const text = frame.text.trim();
            if (text.length === 0) continue;
            docs.push({
              kind: 'message',
              sessionId,
              workspaceId,
              sessionTitle,
              agentId,
              role: 'assistant',
              text: text.length > MAX_DOC_TEXT_CHARS ? text.slice(0, MAX_DOC_TEXT_CHARS) : text,
              time: stepTime,
              turn: item.ordinal,
              stepId: step.stepId,
            });
          }
        }
      }
    }
    if (sessionTitle.length > 0) {
      docs.push({
        kind: 'title',
        sessionId,
        workspaceId,
        sessionTitle,
        agentId: '',
        role: 'title',
        text: sessionTitle,
        time: fallbackTime,
      });
    }
    return docs;
  }

  // -- index route (minidb) -------------------------------------------------------

  private async searchIndex(
    q: NormalizedQuery,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    const skip = decodePageToken(q, 'index', pageToken);

    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      await this.refreshReadonly();
    }
    const db = this.db;
    if (db === null) {
      throw new GlobalSearchError('index_unavailable', 'search index is unavailable');
    }

    if (!db.readOnly) {
      if (this.fullSyncDone) {
        // Incremental catch-up before searching, debounced; the first full
        // sync is never awaited (search serves whatever is indexed so far).
        if (Date.now() - this.lastSyncStartedAt >= this.syncDebounceMs) {
          await this.ensureSyncStarted().catch(() => {});
        }
      } else {
        this.kickBackgroundSync();
      }
    }

    // One text-index pass: db.search returns every candidate with its score;
    // container/role/time filters and the requested sort are applied in
    // memory. (A separate db.query({text}) for pagination would scan the same
    // postings a second time.)
    let candidates: { key: string; value: SearchDoc | undefined; score: number }[];
    let incomplete: 'candidate_cap' | undefined;
    try {
      if (q.mode === 'literal') {
        // The n-gram index cannot confirm queries shorter than 2 normalized
        // code points. Judged AFTER normalization on purpose: NFKC can change
        // the length (the ligature 'ﬀ' folds to 'ff' and becomes legal). The
        // live route has no such constraint — it never reaches this branch.
        if (Array.from(q.literalQuery ?? '').length < 2) {
          throw new GlobalSearchError(
            'invalid_query',
            'literal queries need at least 2 characters (after Unicode normalization)',
          );
        }
        // Ask for one past the cap so an over-cap candidate set is detectable.
        candidates = db.search(TRI_INDEX_NAME, q.query, {
          op: 'AND',
          limit: this.literalCandidateCap + 1,
        });
        if (candidates.length > this.literalCandidateCap) {
          candidates.length = this.literalCandidateCap;
          incomplete = 'candidate_cap';
        }
      } else {
        candidates = db.search(TEXT_INDEX_NAME, q.query, { op: q.op, limit: MAX_TEXT_HITS });
      }
    } catch (error) {
      // A read-only instance can open before the writer has created the text
      // index — serve an empty page instead of failing the search.
      if (error instanceof Error && error.message.includes('no such text index')) {
        return {
          items: [],
          hasMore: false,
          pageToken: undefined,
          incomplete: undefined,
          indexState: this.readIndexState(db),
          source: 'index',
        };
      }
      throw error;
    }

    const matched = this.matchDocs(q, candidates);
    return this.toPage(q, 'index', skip, matched, incomplete, this.readIndexState(db));
  }

  // -- shared match & page assembly (both routes) --------------------------------

  /**
   * Container/role/time filtering plus literal confirmation — one
   * implementation shared by the index route (confirming n-gram candidates)
   * and the live route (scanning every in-memory document).
   */
  private matchDocs(
    q: NormalizedQuery,
    docs: Iterable<{ value: SearchDoc | undefined; score: number }>,
  ): { value: MessageDoc | TitleDoc; score: number; anchor?: number }[] {
    const literalQuery = q.literalQuery;
    const matched: { value: MessageDoc | TitleDoc; score: number; anchor?: number }[] = [];
    for (const { value: doc, score } of docs) {
      if (doc === undefined || (doc.kind !== 'message' && doc.kind !== 'title')) continue;
      if (q.container?.sessionId !== undefined && doc.sessionId !== q.container.sessionId) continue;
      if (q.container?.agentId !== undefined && doc.agentId !== q.container.agentId) continue;
      if (q.role !== undefined && doc.role !== q.role) continue;
      if (q.startTime !== undefined && doc.time < q.startTime) continue;
      if (q.endTime !== undefined && doc.time > q.endTime) continue;
      if (literalQuery !== undefined) {
        // Two-phase execution (same model as Elasticsearch's wildcard field):
        // candidates (from the n-gram index, or every in-memory doc on the
        // live route) are confirmed against the document text — hash
        // collisions and non-contiguous n-gram coverage can produce false
        // positives. Zero false positives is the hard guarantee of literal
        // mode. The match offset doubles as the snippet anchor. Deliberate
        // deviation from ES: the comparison is case-insensitive (NFKC +
        // lowercase), aligned with the terms tokenizer.
        const at = normalizeLiteral(doc.text).indexOf(literalQuery);
        if (at === -1) continue;
        matched.push({ value: doc, score: 0, anchor: at });
      } else {
        matched.push({ value: doc, score });
      }
    }
    return matched;
  }

  /** Sort, paginate and project the matched docs into a page (both routes). */
  private toPage(
    q: NormalizedQuery,
    source: GlobalSearchSource,
    skip: number,
    matched: { value: MessageDoc | TitleDoc; score: number; anchor?: number }[],
    incomplete: 'candidate_cap' | undefined,
    indexState: GlobalSearchIndexState,
  ): GlobalSearchPage {
    // Literal mode: the normalized query (computed in normalizeQuery), reused
    // by confirmation and the snippet anchor.
    const literalQuery = q.literalQuery;
    // Literal hits carry no relevance score and always order by time desc
    // (`sort` is a terms-mode concept). 'score' keeps the relevance order the
    // route produced: the text index's on the index route, `matchLiveTerms'`
    // on the live route.
    if (q.mode === 'literal' || q.sort === 'time_desc') {
      matched.sort((a, b) => b.value.time - a.value.time);
    } else if (q.sort === 'time_asc') {
      matched.sort((a, b) => a.value.time - b.value.time);
    }

    const pageRows = matched.slice(skip, skip + q.pageSize + 1);
    const hasMore = pageRows.length > q.pageSize;
    const items: GlobalSearchHit[] = pageRows.slice(0, q.pageSize).map((row) => {
      const doc = row.value;
      return {
        sessionId: doc.sessionId,
        workspaceId: doc.workspaceId,
        sessionTitle: this.summaries.get(doc.sessionId)?.title ?? doc.sessionTitle,
        agentId: doc.agentId,
        role: doc.role,
        snippet:
          doc.kind === 'title'
            ? doc.text
            : row.anchor !== undefined && literalQuery !== undefined
              ? makeSnippet(doc.text, q.query, 80, { at: row.anchor, len: literalQuery.length })
              : makeSnippet(doc.text, q.query),
        time: doc.time,
        turn: doc.kind === 'message' ? doc.turn : undefined,
        stepId: doc.kind === 'message' ? doc.stepId : undefined,
        score: row.score,
      };
    });

    return {
      items,
      hasMore,
      pageToken: hasMore ? encodePageToken(q, source, skip + q.pageSize) : undefined,
      incomplete,
      indexState,
      source,
    };
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      throw new GlobalSearchError(
        'readonly_index',
        'another process holds the search-index write lock; reindex from that process',
      );
    }
    this.reindexing = true;
    try {
      // Let the in-flight sync settle before closing the db it writes into.
      // Syncs triggered while we wait see `reindexing` and return as no-ops,
      // so one await is sufficient — no new writer of the old db can appear.
      await this.syncPromise?.catch(() => {});
      const db = this.db;
      if (db) {
        await db.close().catch(() => {});
        this.db = null;
      }
      this.openPromise = null;
      this.fullSyncDone = false;
      await rm(this.indexDir, { recursive: true, force: true });
      await this.ensureOpen();
    } finally {
      this.reindexing = false;
    }
    await this.ensureSyncStarted();
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
    };
  }

  async status(): Promise<{ sessions: number; documents: number; lastIndexedAt: number | null }> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      await this.refreshReadonly();
    } else {
      this.kickBackgroundSync();
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      lastIndexedAt: stats?.kind === 'stats' ? stats.lastIndexedAt : null,
    };
  }

  private readIndexState(db: MiniDb<SearchDoc>): GlobalSearchIndexState {
    const stats = db.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    const documents = stats?.kind === 'stats' ? stats.documents : 0;
    return {
      state: db.readOnly ? 'readonly' : this.fullSyncDone ? 'ready' : 'building',
      indexedSessions: indexed,
      totalSessions: db.readOnly ? indexed : Math.max(indexed, this.summaries.size),
      documents,
    };
  }
}

// ---------------------------------------------------------------------------
// live-route terms matching
// ---------------------------------------------------------------------------

/**
 * Terms-mode matching for the live route. Both query (already tokenized and
 * deduplicated in `normalizeQuery`) and documents are split with minidb's
 * default `tokenize` — the same tokenizer the index route's 'body' text index
 * uses — so a document matches when EVERY query term appears in its term set
 * (AND). The score is Σ log(1 + tf) per query term: it is only comparable
 * within the live route, since there is no corpus-wide IDF in memory (the
 * `GlobalSearchSource` contract comment says the same). Hits are returned
 * score-sorted, mirroring `TextIndex.search`, because the shared `toPage`
 * keeps the candidate order for `sort: 'score'`.
 */
function matchLiveTerms(
  terms: readonly string[],
  docs: readonly (MessageDoc | TitleDoc)[],
): { value: MessageDoc | TitleDoc; score: number }[] {
  // A query that tokenizes to nothing matches zero docs, same as the index.
  if (terms.length === 0) return [];
  const matched: { value: MessageDoc | TitleDoc; score: number }[] = [];
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const token of tokenize(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    let hit = true;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) {
        hit = false;
        break;
      }
      score += Math.log(1 + tf);
    }
    if (hit) matched.push({ value: doc, score });
  }
  matched.sort((a, b) => b.score - a.score);
  return matched;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  ScopeActivation.OnScopeCreated,
  'globalSearch',
);
