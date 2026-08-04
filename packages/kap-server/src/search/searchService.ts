/**
 * `search` module — `IGlobalSearchService` implementation (temporary feature,
 * lives in kap-server until it graduates into agent-core-v2).
 *
 * Cross-session full-text search over user messages, assistant text and
 * session titles, backed by a single minidb database at
 * `<homeDir>/search-index`.
 *
 * Request/sync split — "requests serve a published generation, never wait":
 *   - A search request reads the currently published index generation and
 *     returns immediately — with `building` semantics when no generation has
 *     been published yet. It may KICK a background sync/refresh but never
 *     awaits one.
 *   - The background coordinator (single-flight + debounce + one queued
 *     follow-up) detects authoritative changes (session/wire enumeration),
 *     projects them incrementally, and publishes new checkpoints; a sync
 *     that REPLACED indexed documents (shrink rescan, title overwrite) also
 *     bumps the generation, invalidating older page tokens.
 *   - Refresh/sync failures are recorded in `lastRefreshError` and surface
 *     as `indexState.degraded` while the previous generation keeps serving.
 *
 * Concurrency model — "the lock is the election":
 *   - `MiniDb.open({ onLockFail: 'readonly' })`: the process that grabs the
 *     exclusive write lock becomes the indexer (build + incremental sync);
 *     every other process opens read-only and never rescans wire files.
 *   - A read-only instance checks a cheap file fingerprint (db.wal /
 *     db.snapshot / db.textindexes.json) per search: unchanged → serve the
 *     in-memory view; changed → refresh in the BACKGROUND (WAL pure-append →
 *     `MiniDb.catchUpFromWal` incremental replay; anything else → open the
 *     replacement db first, then swap — a failed reopen keeps the stale
 *     generation servable). When the indexer dies, the next opener takes the
 *     lock and becomes the new indexer.
 *   - In-process, syncs are serialized behind a single-flight promise.
 *
 * Incremental indexing anchors on wire.jsonl byte offsets (the files are
 * append-only JSONL): a `\0meta\file\<sessionId>\<pathHash>` key per wire
 * file records how far it has been indexed plus the file's size/mtime/inode;
 * growth re-reads only the new byte range (in bounded chunks), shrinkage or
 * an inode/mtime change drops the file's docs and rescans. Session title
 * docs (`<sid>/$title`) are overwritten each sync; disappeared sessions are
 * dropped by key prefix. Pre-v2 hash-only file-meta keys
 * (`\0meta\file\<pathHash>`) are migrated to the session-scoped format by a
 * one-time background pass (`migrateFileMetaKeys`) and opportunistically on
 * per-file lookup; readers never enumerate the global meta namespace per
 * session, so one session's sync touches only that session's metas.
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
import { LockError, MiniDb, OpTracker, TextIndexBuildingError, normalizeLiteral, tokenize, type BatchInputOp } from '@moonshot-ai/minidb';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import type {
  GlobalSearchHit,
  GlobalSearchIndexState,
  GlobalSearchIncomplete,
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

// -- query budgets (service knobs; the defaults are the production values) ----

/** Max distinct query terms in terms mode. */
const MAX_QUERY_TERMS = 32;
/** Max literal-query length in normalized code points (bounds n-gram terms). */
const MAX_LITERAL_QUERY_CHARS = 1_024;
/**
 * Max posting entries the index may visit for one query (both modes). A hot
 * term/n-gram whose postings overflow the budget contributes a prefix and
 * the page is flagged `incomplete: 'postings_budget'` — the budget applies
 * at the postings/score stage, not just at final confirmation.
 */
const MAX_POSTINGS_VISITS = 250_000;
/** Wall-clock budget for the in-memory match/confirm phase of one query. */
const QUERY_DEADLINE_MS = 500;
/** Max document text processed by literal confirmation per query (UTF-16
 *  code units) — the backstop for pathological huge-document corpora. */
const QUERY_TEXT_BUDGET_CHARS = 16_000_000;
/** How often the match loop re-checks the deadline (candidate iterations). */
const DEADLINE_CHECK_STRIDE = 64;

/** One wire-delta read slice: growth is consumed in bounded chunks instead
 *  of one `size - offset` allocation. */
const WIRE_READ_CHUNK_BYTES = 1 << 20;
/** Flush doc ops to the db in batches of this size while scanning a delta. */
const WIRE_BATCH_OPS = 1_000;
const EMPTY_BUFFER = Buffer.alloc(0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  /** Absolute wire path (debugging aid; the key is its session + hash). */
  readonly path: string;
  /** Byte offset up to which the wire file has been indexed. */
  readonly offset: number;
  readonly size: number;
  /**
   * File mtime/inode at the last sync pass. A changed inode (atomic
   * replacement) or a bumped mtime at an unchanged size (in-place rewrite)
   * forces a rescan even when `size === offset`. Absent in metas written
   * before change tracking — such metas are simply refreshed with the
   * current stat on the next pass, without a rescan.
   */
  readonly mtimeMs?: number;
  readonly ino?: number;
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
  // Fixpoint loop (review #21): awaiting a batch of disposals can trigger
  // further dispose() calls — an embedder tearing down scopes concurrently —
  // which register NEW pending promises a one-shot Promise.all snapshot
  // would not wait for. Keep draining until the set is still empty at the
  // end of a wait.
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
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
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    /** Identity of the published base; bumps invalidate v2 page tokens. */
    generation: number;
    /** Last background refresh/sync/reindex failure, if serving stale. */
    degraded?: string;
  }>;
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

function normalizeQuery(input: GlobalSearchQuery, maxQueryTerms: number): NormalizedQuery {
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
  const termsQuery = mode === 'terms' ? [...new Set(tokenize(query))] : undefined;
  if (termsQuery !== undefined && termsQuery.length > maxQueryTerms) {
    throw new GlobalSearchError(
      'invalid_query',
      `query has too many terms (${termsQuery.length} > ${maxQueryTerms}); narrow it down`,
    );
  }
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new GlobalSearchError('invalid_query', 'pageSize must be an integer between 1 and 50');
  }
  return {
    query,
    mode,
    literalQuery,
    termsQuery,
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
 * The page token encodes a fingerprint of the query conditions — changing
 * conditions mid-pagination invalidates the token (same rule as Lark's
 * search API). The serving route (`source`) is part of the fingerprint: a
 * route flip mid-pagination (e.g. the container session closed and the live
 * route fell away) invalidates the token too, so the client restarts the
 * search instead of silently switching result sets.
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

// ---------------------------------------------------------------------------
// Page tokens v2 — keyset cursor + generation, legacy v1 offset compat
// ---------------------------------------------------------------------------

const PAGE_TOKEN_VERSION = 2;

/**
 * Sort boundary of the last returned hit — the keyset cursor:
 *   - literal mode / `time_desc` / `time_asc`: `[time, key]`;
 *   - `score` (terms mode): `[score, time, key]`.
 * The key is the doc's stable identity: the minidb key on the index route, a
 * synthetic per-frame key on the live route.
 */
type SortBoundary = readonly (number | string)[];

type DecodedPage =
  | { readonly kind: 'first' }
  | { readonly kind: 'keyset'; readonly boundary: SortBoundary }
  /** Legacy v1 offset token, accepted during the transition window. */
  | { readonly kind: 'legacy'; readonly skip: number };

/** Boundary tuple width for the query's effective sort order. */
function boundaryWidth(q: NormalizedQuery): 2 | 3 {
  return q.mode !== 'literal' && q.sort === 'score' ? 3 : 2;
}

function encodePageToken(
  q: NormalizedQuery,
  source: GlobalSearchSource,
  boundary: SortBoundary,
  generation: number | undefined,
): string {
  return Buffer.from(
    JSON.stringify({ v: PAGE_TOKEN_VERSION, f: tokenFingerprint(q, source), g: generation, b: boundary }),
  ).toString('base64url');
}

function decodePageToken(
  q: NormalizedQuery,
  source: GlobalSearchSource,
  token: string | undefined,
  generation: number | undefined,
): DecodedPage {
  if (token === undefined) return { kind: 'first' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  const p = parsed as { v?: unknown; f?: unknown; s?: unknown; g?: unknown; b?: unknown };
  if (p.f !== tokenFingerprint(q, source)) {
    throw new GlobalSearchError(
      'invalid_page_token',
      'pageToken does not match the query conditions; query conditions must not change mid-pagination',
    );
  }
  if (p.v === undefined) {
    // Legacy v1 offset token (`{f, s}`) — transition window: answer it with
    // offset semantics; the response issues a v2 keyset token back.
    if (typeof p.s !== 'number' || !Number.isInteger(p.s) || p.s < 0) {
      throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
    }
    return { kind: 'legacy', skip: p.s };
  }
  if (p.v !== PAGE_TOKEN_VERSION) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken has an unsupported version');
  }
  if (generation !== undefined && p.g !== generation) {
    throw new GlobalSearchError(
      'invalid_page_token',
      'pageToken was issued by an older index generation (the index was rebuilt, reopened or rescanned); restart the search',
    );
  }
  const width = boundaryWidth(q);
  if (
    !Array.isArray(p.b) ||
    p.b.length !== width ||
    typeof p.b[0] !== 'number' ||
    typeof p.b[width - 1] !== 'string' ||
    (width === 3 && typeof p.b[1] !== 'number')
  ) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  return { kind: 'keyset', boundary: p.b as SortBoundary };
}

// ---------------------------------------------------------------------------
// Sort order, boundary filtering and bounded collection (both routes)
// ---------------------------------------------------------------------------

/** One matched document with its stable key and match context. */
interface MatchedRow {
  readonly key: string;
  readonly value: MessageDoc | TitleDoc;
  readonly score: number;
  /** Literal mode: offset of the confirmed match, reused as snippet anchor. */
  readonly anchor?: number;
}

/** Per-query work budget for the match/confirm phase (both routes). */
interface MatchBudget {
  /** Date.now() timestamp after which matching stops with 'deadline'. */
  readonly deadlineAt: number;
  /** Remaining document text (UTF-16 code units) literal confirmation may
   *  process before stopping with 'deadline'. */
  textCharsLeft: number;
}

function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The query's total order (negative = `a` ranks before `b`):
 *   - literal mode (sort is a terms-mode concept) and `time_desc`:
 *     (time desc, key asc);
 *   - `time_asc`: (time asc, key asc);
 *   - `score`: (score desc, time desc, key asc).
 */
function compareRows(q: NormalizedQuery, a: MatchedRow, b: MatchedRow): number {
  if (q.mode !== 'literal' && q.sort === 'score') {
    return b.score - a.score || b.value.time - a.value.time || cmpKey(a.key, b.key);
  }
  if (q.mode !== 'literal' && q.sort === 'time_asc') {
    return a.value.time - b.value.time || cmpKey(a.key, b.key);
  }
  return b.value.time - a.value.time || cmpKey(a.key, b.key);
}

/** The boundary tuple of a row — the keyset cursor payload. */
function boundaryOf(q: NormalizedQuery, row: MatchedRow): SortBoundary {
  return boundaryWidth(q) === 3 ? [row.score, row.value.time, row.key] : [row.value.time, row.key];
}

/** Whether the row ranks strictly AFTER the boundary in the sort order. */
function rowAfterBoundary(q: NormalizedQuery, row: MatchedRow, boundary: SortBoundary): boolean {
  let cmp: number;
  if (boundary.length === 3) {
    const [bs, bt, bk] = boundary as readonly [number, number, string];
    cmp = bs - row.score || bt - row.value.time || cmpKey(row.key, bk);
  } else {
    const [bt, bk] = boundary as readonly [number, string];
    cmp =
      q.mode !== 'literal' && q.sort === 'time_asc'
        ? row.value.time - bt || cmpKey(row.key, bk)
        : bt - row.value.time || cmpKey(row.key, bk);
  }
  return cmp > 0;
}

/**
 * Bounded collector for the K best rows in the query's sort order — same
 * worst-at-root heap shape as minidb's TopK: O(log K) per row and K rows in
 * memory instead of an O(E log E) sort over every eligible row. Deep pages
 * stay proportional to pageSize.
 */
class RowTopK {
  private readonly a: MatchedRow[] = [];

  constructor(
    private readonly q: NormalizedQuery,
    private readonly k: number,
  ) {}

  private worse(x: MatchedRow, y: MatchedRow): boolean {
    return compareRows(this.q, x, y) > 0; // x ranks after y
  }

  offer(row: MatchedRow): void {
    const a = this.a;
    if (a.length < this.k) {
      a.push(row);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.worse(a[i]!, a[p]!)) break;
        [a[p], a[i]] = [a[i]!, a[p]!];
        i = p;
      }
      return;
    }
    if (this.k === 0 || !this.worse(a[0]!, row)) return; // must beat the worst kept
    a[0] = row;
    let i = 0;
    for (;;) {
      let w = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < a.length && this.worse(a[l]!, a[w]!)) w = l;
      if (r < a.length && this.worse(a[r]!, a[w]!)) w = r;
      if (w === i) break;
      [a[w], a[i]] = [a[i]!, a[w]!];
      i = w;
    }
  }

  /** The kept rows in final rank order. */
  sorted(): MatchedRow[] {
    return this.a.sort((x, y) => compareRows(this.q, x, y));
  }
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

  /** Terms-mode candidate cap (test knob, see MAX_TEXT_HITS). */
  maxTextHits = MAX_TEXT_HITS;

  /** Postings-visit budget per query (test knob, see MAX_POSTINGS_VISITS). */
  postingsVisitBudget = MAX_POSTINGS_VISITS;

  /** Match/confirm wall-clock budget per query (test knob). */
  queryDeadlineMs = QUERY_DEADLINE_MS;

  /** Literal-confirmation text-volume budget per query (test knob). */
  queryTextBudgetChars = QUERY_TEXT_BUDGET_CHARS;

  /** Max distinct query terms in terms mode (test knob). */
  maxQueryTerms = MAX_QUERY_TERMS;

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
  /**
   * Dispose drain gate (plan 12's OpTracker primitive, consumed per plan
   * 13): every lifecycle-managed background op (sync pass, read-only
   * refresh) enters it; dispose() closes the gate (new ops skip) and drains
   * the in-flight ones BEFORE closing the db, so no background task ever
   * touches a closed handle (review #20).
   */
  private readonly ops = new OpTracker();
  /** Set while `reindex()` swaps the db — syncs started meanwhile are no-ops. */
  private reindexing = false;
  /** Live-transcript source for the in-memory route; null until start.ts wires it. */
  private liveSource: LiveTranscriptSource | null = null;
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
  /** One queued follow-up pass behind the in-flight one (backpressure). */
  private syncQueued = false;
  /** Trailing-pass timer behind the debounce window. */
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last background refresh/sync/reindex failure — surfaced as degraded. */
  private lastRefreshError: { at: number; message: string } | null = null;
  /** Last open failure — a search with no published generation fails fast. */
  private openError: string | null = null;
  /** One-time per-process migration flag for pre-v2 file-meta keys. */
  private fileMetaMigrated = false;

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    // App-scope OnScopeCreated activation: kick the first full sync off in the
    // background so server bootstrap never blocks on indexing.
    this.requestSync();
  }

  setLiveTranscriptSource(source: LiveTranscriptSource): void {
    this.liveSource = source;
  }

  // -- lifecycle ---------------------------------------------------------------

  private get indexDir(): string {
    return join(this.bootstrap.homeDir, INDEX_DIR_NAME);
  }

  private ensureOpen(): Promise<void> {
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
    // The scope may have been disposed while the (slow) open was in flight —
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
    if (prev !== null) await prev.close().catch(() => {});
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
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    // DI disposal is synchronous, but draining background work and closing a
    // MiniDb are not: close the op gate SYNCHRONOUSLY (new syncs/refreshes
    // skip at enter()), wait for every in-flight op and the in-flight open
    // to settle, then release and close the handle — no background task can
    // touch a closed db (review #20). The promise is registered module-level
    // so the server shutdown path (`drainGlobalSearchDisposals` in start.ts)
    // can await it before the homeDir is torn down — otherwise teardown rm()
    // races the close and fails with ENOTEMPTY.
    const pending = (async () => {
      await this.ops.close();
      await this.openPromise?.catch(() => {});
      const db = this.db;
      this.db = null;
      if (db) await db.close().catch(() => {});
    })();
    pendingDisposals.add(pending);
    void pending.finally(() => pendingDisposals.delete(pending));
  }

  /**
   * Run one lifecycle-managed background op under the dispose drain gate:
   * skipped once dispose has started, and dispose waits for every op that
   * already entered before it closes the db (review #20).
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
  private refreshReadonly(): Promise<void> {
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

  // -- sync coordinator (indexer only) -------------------------------------------
  //
  // Requests never await a sync; they ask the coordinator to schedule one.
  // Single-flight serializes passes, the debounce window coalesces bursts,
  // and backpressure is one queued follow-up behind the in-flight pass.

  private requestSync(): void {
    if (this.disposed || this.reindexing) return;
    if (this.syncPromise !== null) {
      // A pass is already running: queue exactly one follow-up.
      this.syncQueued = true;
      return;
    }
    const wait = this.syncDebounceMs - (Date.now() - this.lastSyncStartedAt);
    if (wait > 0) {
      // Inside the debounce window: coalesce requests into one trailing pass.
      if (this.syncTimer === null) {
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          this.requestSync();
        }, wait);
        this.syncTimer.unref?.();
      }
      return;
    }
    this.startSyncPass();
  }

  private startSyncPass(): void {
    this.syncQueued = false;
    void this.ensureSyncStarted().then(
      () => {
        this.lastRefreshError = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          this.requestSync();
        }
      },
      (error: unknown) => {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
        this.log.warn('global search: background sync failed', { error: errorMessage(error) });
      },
    );
  }

  /** Single-flight: concurrent callers share the in-flight sync. */
  private ensureSyncStarted(): Promise<void> {
    if (this.syncPromise === null) {
      const p = this.tracked(() => this.runSync()).finally(() => {
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
    this.syncReplaced = false;
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

    // One-time rewrite of pre-v2 hash-only file-meta keys, inside the
    // background pass — never in the query path. After it, every per-session
    // lookup below scans only that session's meta prefix.
    await this.migrateFileMetaKeys(db);

    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    const currentIds = new Set(sessions.map((s) => s.id));

    // Drop sessions whose directory disappeared since the last sync. The
    // disposed gate covers this loop and the trailing stats write (review
    // #20): once dispose starts, the pass skips them instead of writing into
    // a db whose close is already draining.
    for (const row of db.query({ key: { prefix: SESSION_META_PREFIX }, project: [] })) {
      if (this.disposed) return;
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

    if (this.disposed) return; // dispose started mid-pass: skip the trailing write (review #20)
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

  private async listAllSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sessionIndex.listRecent({ before: cursor, limit: SESSION_PAGE_SIZE });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
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
    summary: SessionSummary,
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
    summary: SessionSummary,
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

  // -- public API ---------------------------------------------------------------

  /**
   * Route: a container-scoped query on a session that is live in this process
   * scans the in-memory transcript store instead of the index, in both terms
   * and literal mode. Anything else takes the index route. The live route
   * never falls back on error — the store being in hand means the session is
   * alive, so a scan failure is a real error, not a degradation signal.
   */
  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const q = normalizeQuery(input, this.maxQueryTerms);
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
    // The live route has no published generations — the store mutates
    // continuously — so its keyset tokens carry no `g` and no generation
    // check applies; the (time, key) cursor itself is what keeps pages
    // consistent under concurrent appends.
    const page = decodePageToken(q, 'live', pageToken, undefined);
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
    const budget: MatchBudget = {
      deadlineAt: Date.now() + this.queryDeadlineMs,
      textCharsLeft: this.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    // Literal mode needs no candidate index: every in-memory document is a
    // candidate and the shared confirmation pass decides. Terms mode runs the
    // in-memory AND match first, scoring each hit.
    const matched =
      q.mode === 'literal'
        ? this.matchDocs(
            q,
            docs.map(({ key, value }) => ({ key, value, score: 0 })),
            boundary,
            budget,
          )
        : this.matchDocs(q, matchLiveTerms(q.termsQuery ?? [], docs), boundary, budget);
    return this.toPage(q, 'live', page, matched.rows, matched.incomplete, {
      state: 'ready',
      indexedSessions: 1,
      totalSessions: 1,
      documents: docs.length,
    });
  }

  /**
   * Flatten the live transcript store into the same document shape the index
   * route searches (`MessageDoc` / `TitleDoc`), each with a stable synthetic
   * key for keyset pagination:
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
  ): Promise<{ key: string; value: MessageDoc | TitleDoc }[]> {
    const summary = await this.sessionIndex.get(sessionId);
    const workspaceId = summary?.workspaceId ?? '';
    const sessionTitle = summary?.title ?? '';
    const fallbackTime = summary?.updatedAt ?? 0;
    const parseTime = (iso: string | undefined): number => {
      if (iso === undefined) return fallbackTime;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? fallbackTime : ms;
    };
    const docs: { key: string; value: MessageDoc | TitleDoc }[] = [];
    for (const agentId of agentIds) {
      const transcript = store.getAgent(agentId);
      if (transcript === undefined) continue;
      for (const item of transcript.snapshot().items) {
        if (item.kind !== 'turn') continue;
        const turnTime = parseTime(item.startedAt);
        const prompt = item.prompt?.trim() ?? '';
        if (prompt.length > 0) {
          docs.push({
            key: `${sessionId}/${agentId}/live/u/t${item.ordinal}`,
            value: {
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
            },
          });
        }
        for (const step of item.steps) {
          const stepTime = parseTime(step.endedAt ?? step.startedAt ?? item.startedAt);
          for (const frame of step.frames) {
            if (frame.kind !== 'text' || frame.role !== 'assistant') continue;
            const text = frame.text.trim();
            if (text.length === 0) continue;
            docs.push({
              key: `${sessionId}/${agentId}/live/a/${frame.frameId}`,
              value: {
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
              },
            });
          }
        }
      }
    }
    if (sessionTitle.length > 0) {
      docs.push({
        key: `${sessionId}/$title`,
        value: {
          kind: 'title',
          sessionId,
          workspaceId,
          sessionTitle,
          agentId: '',
          role: 'title',
          text: sessionTitle,
          time: fallbackTime,
        },
      });
    }
    return docs;
  }

  // -- index route (minidb) -------------------------------------------------------

  private async searchIndex(
    q: NormalizedQuery,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    // Query validation comes before any index-state handling: an invalid
    // query must fail the same way whether or not a generation is published.
    if (q.mode === 'literal') {
      // The n-gram index cannot confirm queries shorter than 2 normalized
      // code points. Judged AFTER normalization on purpose: NFKC can change
      // the length (the ligature 'ﬀ' folds to 'ff' and becomes legal). The
      // live route has no such constraint — it never reaches this branch.
      const literalLength = Array.from(q.literalQuery ?? '').length;
      if (literalLength < 2) {
        throw new GlobalSearchError(
          'invalid_query',
          'literal queries need at least 2 characters (after Unicode normalization)',
        );
      }
      if (literalLength > MAX_LITERAL_QUERY_CHARS) {
        throw new GlobalSearchError(
          'invalid_query',
          `literal queries are limited to ${MAX_LITERAL_QUERY_CHARS} characters`,
        );
      }
    }

    // The request path serves the currently published generation and never
    // waits for an open, sync, reopen or reindex: with no published base yet
    // it answers with `building` semantics and lets the background
    // coordinator catch up.
    const db = this.db;
    if (db === null) {
      if (this.disposed) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      if (this.openError !== null) {
        // The last open failed (e.g. a read-only open racing a writer's
        // compaction): surface the failure, but ALSO kick a background retry
        // (runSync → ensureOpen), so search traffic self-heals the index once
        // the transient cause goes away — a successful retry clears openError.
        this.requestSync();
        throw new GlobalSearchError(
          'index_unavailable',
          `search index failed to open: ${this.openError}`,
        );
      }
      if (pageToken !== undefined) {
        // No generation to validate the token against — the client restarts
        // the search once a base is published.
        throw new GlobalSearchError(
          'invalid_page_token',
          'the search index is not ready yet; restart the search',
        );
      }
      this.requestSync(); // kicks the open + first sync if nothing is running
      return this.buildingPage(null);
    }

    let stale: boolean;
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
      // (The stage-6 async query path awaits again below, so a later swap
      // can still close it mid-query — the bounded pass retries once on the
      // fresh handle for exactly that race.)
      if (this.db === null) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      serveDb = this.db;
      if (serveDb.readOnly) {
        stale = fp === null || fp !== this.fingerprint || this.refreshPromise !== null;
        if (fp !== null && fp !== this.fingerprint) void this.refreshReadonly();
      } else {
        // The reopen promoted this process to writer (the old writer's lock
        // was gone): serve from it and kick the coordinator like a writer.
        this.requestSync();
        stale = this.syncPromise !== null || this.syncQueued || this.syncTimer !== null;
      }
    } else {
      // Writer: kick the coordinator (never awaited); the served generation
      // is the one published by the last completed pass.
      this.requestSync();
      stale = this.syncPromise !== null || this.syncQueued || this.syncTimer !== null;
    }
    const generation = this.generation;
    const page = decodePageToken(q, 'index', pageToken, generation);

    // The served handle's text base is still (re)building — the deferred
    // open-time build on the no-generation fallback path has not committed (or
    // finally failed). Answer with the building page instead of running a
    // pass that would raise TextIndexBuildingError; the background build
    // commits and a later search serves real hits. Tokens from an older
    // generation already failed validation above, so reaching here with a
    // building handle is always a first-page situation.
    if (serveDb.textIndexBuilding(q.mode === 'literal' ? TRI_INDEX_NAME : TEXT_INDEX_NAME)) {
      return this.buildingPage(serveDb);
    }

    // One bounded text-index pass: db.searchBoundedAsync returns at most the
    // budgeted candidates with their scores (stage 6: the async variant —
    // postings reads and disk-mode value reads run off the event loop);
    // container/role/time filters and the requested sort are applied in
    // memory. (A separate db.query({text}) for pagination would scan the
    // same postings a second time.)
    let candidates: { key: string; value: SearchDoc | undefined; score: number }[];
    let incomplete: GlobalSearchIncomplete | undefined;
    const runBounded = (db2: MiniDb<SearchDoc>): Promise<{ hits: { key: string; value: SearchDoc; score: number }[]; visits: number; truncated: boolean }> => {
      if (q.mode === 'literal') {
        // Ask for one past the cap so an over-cap candidate set is
        // detectable; the postings budget bounds the index-side work before
        // confirmation even starts.
        return db2.searchBoundedAsync(TRI_INDEX_NAME, q.query, {
          op: 'AND',
          limit: this.literalCandidateCap + 1,
          maxVisits: this.postingsVisitBudget,
        });
      }
      return db2.searchBoundedAsync(TEXT_INDEX_NAME, q.query, {
        op: q.op,
        limit: this.maxTextHits + 1,
        maxVisits: this.postingsVisitBudget,
      });
    };
    try {
      let res: { hits: { key: string; value: SearchDoc; score: number }[]; visits: number; truncated: boolean };
      try {
        res = await runBounded(serveDb);
      } catch (error) {
        // The async query path awaits: a background read-only refresh may
        // have swapped (and closed) the pinned handle mid-query. Re-pin the
        // currently published handle and retry ONCE — anything else is a
        // real failure.
        const msg = error instanceof Error ? error.message : String(error);
        const closedRace = msg.includes('postings file is closed') || msg.includes('MiniDb is closed') || msg.includes('ValueReader is not open');
        if (!closedRace || this.db === null || this.db === serveDb) throw error;
        serveDb = this.db;
        res = await runBounded(serveDb);
      }
      if (q.mode === 'literal') {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > this.literalCandidateCap) {
          candidates.length = this.literalCandidateCap;
          incomplete ??= 'candidate_cap';
        }
      } else {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > this.maxTextHits) {
          candidates.length = this.maxTextHits;
          incomplete ??= 'candidate_cap';
        }
      }
    } catch (error) {
      // The base build's state flipped between the early check and the pass
      // (or a read-only refresh swapped in a still-building handle mid-page):
      // serve the same building page the early check produces.
      if (error instanceof TextIndexBuildingError) {
        return this.buildingPage(serveDb);
      }
      // A read-only instance can open before the writer has created the text
      // index — serve an empty page instead of failing the search.
      if (error instanceof Error && error.message.includes('no such text index')) {
        return {
          items: [],
          hasMore: false,
          pageToken: undefined,
          incomplete: undefined,
          indexState: this.readIndexState(serveDb, stale),
          source: 'index',
        };
      }
      throw error;
    }

    const budget: MatchBudget = {
      deadlineAt: Date.now() + this.queryDeadlineMs,
      textCharsLeft: this.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    const matched = this.matchDocs(q, candidates, boundary, budget);
    incomplete ??= matched.incomplete;
    return this.toPage(
      q,
      'index',
      page,
      matched.rows,
      incomplete,
      this.readIndexState(serveDb, stale),
      generation,
    );
  }

  // -- shared match & page assembly (both routes) --------------------------------

  /**
   * Container/role/time filtering, keyset-boundary filtering and literal
   * confirmation — one implementation shared by the index route (confirming
   * n-gram candidates) and the live route (scanning every in-memory
   * document). The query work budgets apply at this match stage: the
   * wall-clock deadline is re-checked every DEADLINE_CHECK_STRIDE candidates
   * and literal confirmation additionally charges each processed document's
   * text against `budget.textCharsLeft`. A budget stop is reported as
   * `incomplete: 'deadline'`, never a silent truncation.
   */
  private matchDocs(
    q: NormalizedQuery,
    docs: Iterable<{ key: string; value: SearchDoc | undefined; score: number }>,
    boundary: SortBoundary | undefined,
    budget: MatchBudget,
  ): { rows: MatchedRow[]; incomplete?: GlobalSearchIncomplete } {
    const literalQuery = q.literalQuery;
    const rows: MatchedRow[] = [];
    let i = 0;
    for (const { key, value: doc, score } of docs) {
      if ((i++ & (DEADLINE_CHECK_STRIDE - 1)) === 0 && Date.now() > budget.deadlineAt) {
        return { rows, incomplete: 'deadline' };
      }
      if (doc === undefined || (doc.kind !== 'message' && doc.kind !== 'title')) continue;
      if (q.container?.sessionId !== undefined && doc.sessionId !== q.container.sessionId) continue;
      if (q.container?.agentId !== undefined && doc.agentId !== q.container.agentId) continue;
      if (q.role !== undefined && doc.role !== q.role) continue;
      if (q.startTime !== undefined && doc.time < q.startTime) continue;
      if (q.endTime !== undefined && doc.time > q.endTime) continue;
      // The boundary check only needs the sort key (score/time/key), so it
      // runs BEFORE the expensive literal confirmation.
      if (boundary !== undefined && !rowAfterBoundary(q, { key, value: doc, score }, boundary)) {
        continue;
      }
      if (literalQuery !== undefined) {
        budget.textCharsLeft -= doc.text.length;
        if (budget.textCharsLeft < 0) return { rows, incomplete: 'deadline' };
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
        rows.push({ key, value: doc, score: 0, anchor: at });
      } else {
        rows.push({ key, value: doc, score });
      }
    }
    return { rows };
  }

  /**
   * Sort, paginate and project the matched docs into a page (both routes).
   * Keyset pages collect the best `pageSize + 1` rows past the boundary in a
   * bounded heap; legacy v1 offset tokens get one last offset slice and are
   * answered with a v2 keyset token.
   */
  private toPage(
    q: NormalizedQuery,
    source: GlobalSearchSource,
    page: DecodedPage,
    rows: MatchedRow[],
    incomplete: GlobalSearchIncomplete | undefined,
    indexState: GlobalSearchIndexState,
    generation?: number,
  ): GlobalSearchPage {
    // Literal mode: the normalized query (computed in normalizeQuery), reused
    // by confirmation and the snippet anchor.
    const literalQuery = q.literalQuery;
    let pageRows: MatchedRow[];
    let hasMore: boolean;
    if (page.kind === 'legacy') {
      rows.sort((a, b) => compareRows(q, a, b));
      const slice = rows.slice(page.skip, page.skip + q.pageSize + 1);
      hasMore = slice.length > q.pageSize;
      pageRows = slice.slice(0, q.pageSize);
    } else {
      const top = new RowTopK(q, q.pageSize + 1);
      for (const row of rows) top.offer(row);
      const slice = top.sorted();
      hasMore = slice.length > q.pageSize;
      pageRows = slice.slice(0, q.pageSize);
    }
    const items: GlobalSearchHit[] = pageRows.map((row) => {
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
      pageToken: hasMore
        ? encodePageToken(q, source, boundaryOf(q, pageRows[pageRows.length - 1]!), generation)
        : undefined,
      incomplete,
      indexState,
      source,
    };
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    try {
      // Block new background passes BEFORE the first await, so no sync can
      // start writing into the db this rebuild is about to swap out.
      this.reindexing = true;
      await this.ensureOpen();
      if (this.db?.readOnly === true) {
        throw new GlobalSearchError(
          'readonly_index',
          'another process holds the search-index write lock; reindex from that process',
        );
      }
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
      // The rebuild runs the authoritative sync itself — an explicit
      // maintenance operation, never ordinary in-request work.
      this.reindexing = false;
      await this.ensureSyncStarted();
      this.lastRefreshError = null;
    } catch (error) {
      this.reindexing = false;
      this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      throw error;
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
    };
  }

  async status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
  }> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      // An explicit status call may wait for the refresh; searches may not.
      await this.refreshReadonly();
    } else {
      this.requestSync();
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      lastIndexedAt: stats?.kind === 'stats' ? stats.lastIndexedAt : null,
      generation: this.generation,
      degraded: this.lastRefreshError?.message,
    };
  }

  /**
   * The page served while the index base is unavailable: the first full sync
   * has not finished (no db yet), or a deferred open-time base build is
   * still running / finally failed on the served handle. Same "never wait"
   * rule as every other request path — the background coordinator/build
   * catches up and a later search serves real hits.
   */
  private buildingPage(db: MiniDb<SearchDoc> | null): GlobalSearchPage {
    const stats = db?.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    return {
      items: [],
      hasMore: false,
      pageToken: undefined,
      incomplete: undefined,
      indexState: {
        state: 'building',
        indexedSessions: indexed,
        totalSessions: db === null ? this.summaries.size : db.readOnly ? indexed : Math.max(indexed, this.summaries.size),
        documents: stats?.kind === 'stats' ? stats.documents : 0,
        stale: true,
        degraded: this.lastRefreshError?.message,
      },
      source: 'index',
    };
  }

  private readIndexState(db: MiniDb<SearchDoc>, stale: boolean): GlobalSearchIndexState {
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
      totalSessions: db.readOnly ? indexed : Math.max(indexed, this.summaries.size),
      documents,
      stale: stale || undefined,
      degraded: this.lastRefreshError?.message,
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
 * `GlobalSearchSource` contract comment says the same). The shared `toPage`
 * applies the final (score, time, key) order over the returned rows.
 */
function matchLiveTerms(
  terms: readonly string[],
  docs: readonly { key: string; value: MessageDoc | TitleDoc }[],
): { key: string; value: MessageDoc | TitleDoc; score: number }[] {
  // A query that tokenizes to nothing matches zero docs, same as the index.
  if (terms.length === 0) return [];
  const matched: { key: string; value: MessageDoc | TitleDoc; score: number }[] = [];
  for (const { key, value: doc } of docs) {
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
    if (hit) matched.push({ key, value: doc, score });
  }
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
