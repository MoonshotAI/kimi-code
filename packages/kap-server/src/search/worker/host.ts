/**
 * `search/worker` — the main-process host for the search worker thread.
 *
 * The host owns the worker lifecycle and speaks the request/response
 * protocol (`protocol.ts`); to the search service it presents the same
 * surface as the inline core (`SearchIndexCore`), so the service's
 * coordinator / live route / page assembly never care which host runs the
 * index.
 *
 * Lifecycle semantics (stage 4 work items 3, 6 and 7):
 *   - lazy spawn with single-flight + backoff: the first RPC spawns the
 *     worker; spawn failures and dirty exits back off exponentially
 *     (500ms → 10s cap) instead of hot-looping, and RPCs during the backoff
 *     window fail fast with a recognizable SearchWorkerError — nothing
 *     ever falls back to running the index on the main thread implicitly
 *     (the explicit rollback switch is the `search_worker` flag);
 *   - a dirty exit rejects every in-flight request (no dangling promises),
 *     records the failure for the service's degraded state, and reaps the
 *     search-index `db.lock` — but ONLY when the lock line still carries
 *     the dead worker's own token, so a live owner's lock is never deleted
 *     (the lock file's pid is unusable for this judgment because worker
 *     threads share the main process pid);
 *   - dispose() sends `close` (the worker drains in-flight requests and
 *     tracked background ops, closes the db and exits) with terminate() as
 *     the bounded backstop.
 *
 * Entry resolution: the configured packaged asset (SEA) → the sibling
 * `entry.ts` source (dev/tests, run under Node's native type stripping plus
 * the repo-local `.js` → `.ts` resolve hook) → the bundled
 * `search-worker.mjs` sibling (packaged npm layout).
 */

import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { getTextBuildWorkerRuntimeState } from '@moonshot-ai/minidb/worker-runtime';

import { GlobalSearchError } from '../contract';
import type {
  CoreIndexView,
  CoreLifecycleReport,
  CoreSearchParams,
  CoreSearchResult,
  CoreStatus,
  CoreSyncOutcome,
  SearchCoreLog,
  SyncSessionInput,
} from '../indexCore';
import {
  SEARCH_WORKER_PROTOCOL_VERSION,
  type SearchWorkerData,
  type SearchWorkerEvent,
  type SearchWorkerOpenResult,
  type SearchWorkerCallType,
  type SearchWorkerResultMap,
} from './protocol';
import { getSearchWorkerRuntimeState } from './runtime';

export type SearchWorkerErrorCode =
  /** No worker entry file could be resolved in this installation. */
  | 'runtime-unavailable'
  /** Constructor/bootstrap/handshake failure (incl. protocol mismatch). */
  | 'spawn-failed'
  /** The worker died after a successful handshake (crash / OOM / kill). */
  | 'crashed'
  /** A restart is backing off; the RPC failed fast without spawning. */
  | 'backoff'
  /** The host is disposed. */
  | 'disposed';

/**
 * Recognizable worker-availability failure. The service maps it to a
 * building/degraded response (searches) or the degraded state (background
 * ops) — it is never swallowed silently.
 */
export class SearchWorkerError extends Error {
  constructor(
    readonly code: SearchWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SearchWorkerError';
  }
}

export interface SearchWorkerHostOptions {
  /** Absolute path of the search-index database directory. */
  readonly dir: string;
  readonly log: SearchCoreLog;
  /** Ready-handshake budget (ms). Default 15_000. */
  readonly readyTimeoutMs?: number;
  /** Grace period for the drain-on-close before terminate() (ms). Default 30_000. */
  readonly closeTimeoutMs?: number;
  /** Watchdog budget per query/lifecycle request (ms). Default 60_000. */
  readonly requestTimeoutMs?: number;
  /** Watchdog budget per sync/reindex request (ms). Default 30 min. */
  readonly syncTimeoutMs?: number;
  /** Worker heap cap, mirroring the text-build worker. Default 1024. */
  readonly maxOldSpaceMb?: number;
  /** Test hook: worker factory override. */
  readonly workerFactory?: (entry: { url: URL; data: SearchWorkerData; execArgv: string[] }) => Worker;
}

interface WorkerEntryResolution {
  readonly url: URL;
  /** File-system path for packaged entries (stat-able, absolute). */
  readonly execArgv: string[];
}

type PendingRequest = {
  readonly method: SearchWorkerCallType;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Absent for `close` — doDispose races it against closeTimeoutMs itself. */
  readonly watchdog?: ReturnType<typeof setTimeout>;
};

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OLD_SPACE_MB = 1024;
/** A worker session that survived this long resets the crash backoff. */
const STABLE_SESSION_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
/**
 * Watchdog budgets per request. Queries and lifecycle calls are expected to
 * be bounded (the query path carries its own work budgets); sync/reindex of
 * a large corpus legitimately takes minutes, so their leash is long — the
 * watchdog exists to catch a WEDGED worker, not to police slow work.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SYNC_TIMEOUT_MS = 30 * 60_000;
/**
 * Grace window before treating a lock line carrying THIS process's pid but
 * an unknown token as an orphan: a live sibling worker's token event rides
 * the same-process port and lands within milliseconds, so a token still
 * unknown after the window belongs to a dead worker.
 */
const ORPHAN_LOCK_GRACE_MS = 250;

/**
 * Lock tokens held by LIVE search-index holders of this process (worker
 * threads share the process pid, so the pid in a lock line cannot
 * distinguish a live holder from a dead one). Fed by the workers'
 * `lockToken` events (and by the inline backend's core) and pruned on
 * worker exit / backend dispose; the orphan-lock detector reaps a same-pid
 * lock line only when its token is NOT in this set.
 */
const liveLockTokens = new Set<string>();

/** Register a held search-index lock token (inline backend's core). */
export function noteLiveLockToken(token: string): void {
  liveLockTokens.add(token);
}

/** Drop a previously registered token (inline backend close/dispose). */
export function dropLiveLockToken(token: string | undefined): void {
  if (token !== undefined) liveLockTokens.delete(token);
}

export class SearchWorkerHost {
  private worker: Worker | null = null;
  private spawnPromise: Promise<void> | null = null;
  private reapPromise: Promise<void> | null = null;
  private readonly requests = new Map<number, PendingRequest>();
  private nextId = 1;
  /** Token of the db.lock line the current/last worker published. */
  private lockToken: string | undefined;
  private failures = 0;
  private nextRetryAfter = 0;
  private lastFailure: string | null = null;
  private readyAt = 0;
  private exiting = false;
  private exitResolve: (() => void) | null = null;
  private orphanCheckScheduled = false;
  /**
   * The worker-side core's lifecycle as of the last RPC response that carried
   * it (every response shape does: status/open/refresh/reindex directly,
   * search via its index view). Feeds `lifecycleSnapshot` — the local,
   * round-trip-free answer for the service's status surface.
   */
  private lastCoreLifecycle: CoreLifecycleReport | null = null;

  constructor(private readonly options: SearchWorkerHostOptions) {}

  private get log(): SearchCoreLog {
    return this.options.log;
  }

  private get dir(): string {
    return this.options.dir;
  }

  /** Test/diagnostic: the lock token the current/last worker reported. */
  get reportedLockToken(): string | undefined {
    return this.lockToken;
  }

  /**
   * The aggregate search lifecycle from the host's LOCAL knowledge (stage 5):
   * never spawns the worker, never waits on an RPC — the states a wedged or
   * not-yet-running worker cannot answer for itself are exactly the ones this
   * must report (stopped/opening/degraded-backoff/closing). A live worker's
   * state comes from the cached last response (`lastCoreLifecycle`).
   */
  lifecycleSnapshot(): CoreLifecycleReport {
    if (this.exiting) {
      return this.worker !== null || this.spawnPromise !== null
        ? { state: 'closing' }
        : { state: 'stopped' };
    }
    if (this.spawnPromise !== null) return { state: 'opening' };
    if (this.worker === null) {
      if (this.lastFailure !== null) {
        // Crash/spawn failure with a lazy restart pending on the next RPC
        // (possibly still inside the backoff window): the index is unserved.
        const wait = this.nextRetryAfter - Date.now();
        return {
          state: 'degraded',
          detail:
            wait > 0
              ? `search worker restart backing off for ${wait}ms (last failure: ${this.lastFailure})`
              : `search worker restart pending (last failure: ${this.lastFailure})`,
        };
      }
      // Never spawned: the lazy spawn fires on the first RPC.
      return { state: 'stopped' };
    }
    // The worker is up but no response has landed yet (its first open is
    // still in flight): the core is opening.
    return this.lastCoreLifecycle ?? { state: 'opening' };
  }

  // -- backend surface ------------------------------------------------------------

  async ensureOpen(): Promise<SearchWorkerOpenResult> {
    return this.call('open');
  }

  async search(params: CoreSearchParams): Promise<CoreSearchResult> {
    return this.call('search', params);
  }

  async sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome> {
    return this.call('sync', { sessions });
  }

  async refresh(): Promise<SearchWorkerOpenResult> {
    return this.call('refresh');
  }

  async reindex(): Promise<SearchWorkerOpenResult> {
    return this.call('reindex');
  }

  async status(): Promise<CoreStatus> {
    return this.call('status');
  }

  /** Test hook: hard-kill the worker (crash/restart semantics). */
  async killWorkerForTest(): Promise<void> {
    const worker = this.worker;
    if (worker === null) return;
    await worker.terminate();
    await this.waitForExit();
  }

  // -- RPC --------------------------------------------------------------------------

  private async call<T extends SearchWorkerCallType>(
    type: T,
    params?: unknown,
  ): Promise<SearchWorkerResultMap[T]> {
    await this.ensureWorker();
    const worker = this.worker;
    if (worker === null) {
      throw new SearchWorkerError('crashed', 'search worker is not running');
    }
    return this.sendRequest(worker, type, params) as Promise<SearchWorkerResultMap[T]>;
  }

  private sendRequest(
    worker: Worker,
    type: SearchWorkerCallType,
    params?: unknown,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // Watchdog budget: `open` shares the long leash with sync/reindex — a
      // first open over a huge corpus replays the full WAL / runs full
      // recovery with no wall-clock budget of its own, and killing it at
      // the short leash would discard all progress into a backoff loop.
      // `close` gets no watchdog: doDispose races it against closeTimeoutMs,
      // and a shorter request leash would misjudge a legitimate drain as a
      // wedged worker.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      if (type !== 'close') {
        const timeoutMs =
          type === 'sync' || type === 'reindex' || type === 'open'
            ? this.options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
            : this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        watchdog = setTimeout(() => this.onRequestTimeout(id), timeoutMs);
        watchdog.unref?.();
      }
      this.requests.set(id, { method: type, resolve, reject, watchdog });
      try {
        worker.postMessage({ id, v: SEARCH_WORKER_PROTOCOL_VERSION, type, params });
      } catch (error) {
        this.requests.delete(id);
        if (watchdog !== undefined) clearTimeout(watchdog);
        reject(
          new SearchWorkerError(
            'crashed',
            `search worker channel broke: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /**
   * Watchdog: a request outlived its budget — the worker is presumed wedged.
   * Reject the requester and take the crash path (terminate → reject the
   * remaining in-flight requests → reap → backed-off restart).
   */
  private onRequestTimeout(id: number): void {
    const pending = this.requests.get(id);
    if (pending === undefined) return;
    this.requests.delete(id);
    const message = `search worker request '${pending.method}' timed out`;
    this.log.warn(`global search: ${message}; terminating the wedged worker`, { dir: this.dir });
    pending.reject(new SearchWorkerError('crashed', message));
    const worker = this.worker;
    if (worker !== null) {
      void worker.terminate().catch(() => {});
    }
  }

  private settleRequest(id: number, error: Error | null, result: unknown): void {
    const pending = this.requests.get(id);
    if (pending === undefined) return;
    this.requests.delete(id);
    if (pending.watchdog !== undefined) clearTimeout(pending.watchdog);
    if (error !== null) {
      pending.reject(error);
      return;
    }
    this.noteResult(result);
    pending.resolve(result);
  }

  /**
   * Track the worker-published db.lock token and the read-only role from any
   * response carrying them; a read-only answer triggers the orphan-lock
   * detector (see recoverOrphanedLock). Also refreshes the cached core
   * lifecycle (`lastCoreLifecycle`) — every response shape carries it:
   * status/open/refresh/reindex directly, search via its index view.
   */
  private noteResult(result: unknown): void {
    if (result === null || typeof result !== 'object') return;
    const direct = (result as { lockToken?: unknown }).lockToken;
    const nested = (result as { index?: { lockToken?: unknown } }).index?.lockToken;
    const token = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
    if (token !== undefined) this.lockToken = token;
    const readOnly =
      (result as { readOnly?: unknown }).readOnly === true ||
      (result as { index?: { readOnly?: unknown } }).index?.readOnly === true;
    if (readOnly) this.scheduleOrphanCheck();
    const lifecycle = (result as { lifecycle?: CoreLifecycleReport }).lifecycle;
    if (lifecycle !== undefined) {
      this.lastCoreLifecycle = lifecycle;
      return;
    }
    const index = (result as { index?: CoreIndexView }).index;
    if (index !== undefined) {
      // A search response arrived at all, so the worker is serving: the page
      // view's building/ready maps directly; a degraded MESSAGE on a serving
      // page keeps the lifecycle 'ready' (the message rides status()'s
      // degraded field, same as the per-page surface).
      this.lastCoreLifecycle = { state: index.state === 'building' ? 'building' : 'ready' };
    }
  }

  // -- worker lifecycle --------------------------------------------------------------

  private ensureWorker(): Promise<void> {
    if (this.worker !== null) return Promise.resolve();
    if (this.exiting) {
      return Promise.reject(new SearchWorkerError('disposed', 'search worker is disposed'));
    }
    if (this.spawnPromise !== null) return this.spawnPromise;
    const wait = this.nextRetryAfter - Date.now();
    if (wait > 0) {
      return Promise.reject(
        new SearchWorkerError(
          'backoff',
          `search worker restart backing off for ${wait}ms (last failure: ${this.lastFailure ?? 'unknown'})`,
        ),
      );
    }
    this.spawnPromise = this.doSpawn().finally(() => {
      this.spawnPromise = null;
    });
    return this.spawnPromise;
  }

  private resolveEntry(): WorkerEntryResolution {
    const configured = getSearchWorkerRuntimeState();
    if (configured.configured) {
      return { url: pathToFileURL(configured.path), execArgv: [] };
    }
    const source = new URL('./entry.ts', import.meta.url);
    try {
      if (fsSync.statSync(source).isFile()) {
        // Dev/tests: run the TypeScript entry under Node's native type
        // stripping; the repo-local resolve hook maps minidb's internal
        // `.js` specifiers onto the on-disk `.ts` sources.
        return {
          url: source,
          execArgv: [
            '--experimental-transform-types',
            '--disable-warning=ExperimentalWarning',
            '--import',
            new URL('./register-dev-hooks.mjs', import.meta.url).href,
          ],
        };
      }
    } catch {
      // not a source layout — try the bundled sibling
    }
    const bundled = new URL('./search-worker.mjs', import.meta.url);
    try {
      if (fsSync.statSync(bundled).isFile()) {
        return { url: bundled, execArgv: [] };
      }
    } catch {
      // fall through to the explicit failure
    }
    throw new SearchWorkerError(
      'runtime-unavailable',
      'search worker entry not found (no configured packaged asset, no sibling source, no bundled sibling)',
    );
  }

  private async doSpawn(): Promise<void> {
    // A previous worker's lock reaping must land before the new worker's
    // MiniDb open evaluates the lock.
    await this.reapPromise;
    const entry = this.resolveEntry();
    const textBuild = getTextBuildWorkerRuntimeState();
    const data: SearchWorkerData = {
      dir: this.dir,
      bootSalt: randomUUID(),
      textBuildWorkerPath:
        textBuild.configured && textBuild.entry.kind === 'packaged' ? textBuild.entry.path : undefined,
    };
    let worker: Worker;
    try {
      worker =
        this.options.workerFactory?.({
          url: entry.url,
          data,
          execArgv: entry.execArgv,
        }) ??
        new Worker(entry.url, {
          workerData: data,
          execArgv: entry.execArgv,
          resourceLimits: { maxOldGenerationSizeMb: this.options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB },
          name: 'kimi-search-worker',
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteFailure(`spawn failed: ${message}`);
      throw new SearchWorkerError('spawn-failed', `search worker failed to start: ${message}`);
    }
    worker.unref();
    this.attach(worker);
    try {
      await this.awaitReady(worker);
    } catch (error) {
      // Never attached as current: detach without exit handling — the
      // worker's own (late) exit event is stale-guarded in onExit.
      this.detach();
      await worker.terminate().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.noteFailure(`handshake failed: ${message}`);
      throw new SearchWorkerError('spawn-failed', `search worker handshake failed: ${message}`);
    }
    this.readyAt = Date.now();
    this.worker = worker;
    // The failure that armed the backoff is consumed: a fresh worker starts
    // with a clean slate so a LATER dirty exit records its own cause (the
    // backoff counters themselves are kept for the exponential math).
    this.lastFailure = null;
    // The cached core lifecycle belonged to the PREVIOUS worker generation:
    // the new core has not even opened its db yet, and its first open over a
    // large corpus can take minutes — serving the dead worker's 'ready' from
    // the snapshot in that window would misreport the index as servable.
    this.lastCoreLifecycle = null;
    if (this.exiting) {
      // beginClose()/dispose() landed while the handshake was in flight; the
      // control message posted then found no worker and was dropped — forward
      // it now so the worker-side core gates any pass about to start.
      try {
        worker.postMessage({ v: SEARCH_WORKER_PROTOCOL_VERSION, type: 'beginClose' });
      } catch {
        // A broken channel here is settled by the exit path.
      }
    }
    this.log.info('global search: worker started', { dir: this.dir });
  }

  private attach(worker: Worker): void {
    worker.on('message', (event: SearchWorkerEvent) => this.onMessage(worker, event));
    worker.on('error', (error: Error) => this.onError(worker, error));
    worker.on('exit', (code: number) => this.onExit(worker, code));
  }

  private detach(): void {
    this.worker = null;
    this.exitResolve?.();
    this.exitResolve = null;
  }

  private onMessage(worker: Worker, event: SearchWorkerEvent): void {
    // Ignore a stale worker's late messages (it was replaced after a
    // handshake abort; only the current worker's traffic is meaningful).
    if (this.worker !== worker) return;
    if (event === null || typeof event !== 'object') return;
    if (event.type === 'log') {
      this.log[event.level](event.message, event.meta);
      return;
    }
    if (event.type === 'lockToken') {
      // The worker just acquired the write lock (posted before the heavy
      // open work runs). Register it live so a mid-open crash leaves a
      // reapable lock and the orphan detector never touches it.
      this.lockToken = event.token;
      liveLockTokens.add(event.token);
      return;
    }
    if (event.type === 'ready') return; // consumed by awaitReady's one-shot listener
    if (event.type === 'result') {
      this.settleRequest(event.id, null, event.result);
      return;
    }
    if (event.type === 'error') {
      const payload = event.error;
      const error =
        payload.reason !== undefined
          ? new GlobalSearchError(payload.reason, payload.message)
          : new Error(payload.message);
      this.settleRequest(event.id, error, undefined);
    }
  }

  private onError(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    // The 'exit' event follows and performs the teardown; remember the cause.
    this.lastFailure = `worker error: ${error.message}`;
  }

  private onExit(worker: Worker, code: number): void {
    // A stale worker's exit must not tear down its replacement: the
    // handshake-abort path detaches a worker BEFORE its exit event lands.
    if (this.worker !== worker) return;
    const wasExiting = this.exiting;
    const sessionMs = Date.now() - this.readyAt;
    const deadToken = this.lockToken;
    this.detach();
    this.lockToken = undefined;
    if (deadToken !== undefined) liveLockTokens.delete(deadToken);
    if (this.requests.size > 0) {
      // During a clean close the pending requests race the worker's exit —
      // they are disposed, not crashed (the close itself already settled).
      const error = wasExiting
        ? new SearchWorkerError('disposed', 'search worker is disposed')
        : new SearchWorkerError(
            'crashed',
            `search worker exited with in-flight requests (code ${code}${this.lastFailure !== null ? `; ${this.lastFailure}` : ''})`,
          );
      for (const pending of this.requests.values()) {
        if (pending.watchdog !== undefined) clearTimeout(pending.watchdog);
        pending.reject(error);
      }
      this.requests.clear();
    }
    if (wasExiting) return; // clean close / handshake abort — no backoff, no reaping needed
    // Dirty exit. Reap the lock the dead worker published (guarded by its
    // token) so the replacement worker can acquire it — the pid in the lock
    // line is useless here because worker threads share the main process
    // pid and it stays alive.
    // A bare kill leaves no 'error'-event message: record the exit itself so
    // the backoff rejection and the lifecycle report can name the failure.
    this.lastFailure ??= `worker exited with code ${code}`;
    this.reapPromise = this.reapLockFile(deadToken).finally(() => {
      this.reapPromise = null;
    });
    this.failures = sessionMs > STABLE_SESSION_MS ? 1 : this.failures + 1;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_CAP_MS);
    this.nextRetryAfter = Date.now() + backoff;
    this.log.warn('global search: worker exited unexpectedly; restart backed off', {
      code,
      backoffMs: backoff,
      lastFailure: this.lastFailure ?? undefined,
    });
  }

  /** Record a spawn/handshake failure and arm the restart backoff. */
  private noteFailure(message: string): void {
    this.failures += 1;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_CAP_MS);
    this.nextRetryAfter = Date.now() + backoff;
    this.lastFailure = message;
  }

  /**
   * Remove the search-index db.lock ONLY when it still carries the dead
   * worker's own token. A lock line written by anyone else (a live worker of
   * another service instance in this process, another process entirely) is
   * never touched.
   */
  private async reapLockFile(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const lockPath = join(this.dir, 'db.lock');
    try {
      const raw = await readFile(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      if (parsed.pid === process.pid && parsed.token === token) {
        await rm(lockPath, { force: true });
        this.log.warn('global search: reaped the lock left by the dead worker', { dir: this.dir });
      }
    } catch {
      // Unreadable or already gone — the next open re-evaluates from disk.
    }
  }

  private awaitReady(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`ready handshake timed out after ${this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms`));
      }, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      timer.unref?.();
      const onMessage = (event: SearchWorkerEvent): void => {
        if (event?.type !== 'ready') return;
        cleanup();
        if (event.v !== SEARCH_WORKER_PROTOCOL_VERSION) {
          reject(
            new Error(
              `protocol mismatch: host v${SEARCH_WORKER_PROTOCOL_VERSION}, worker v${event.v ?? 'unknown'}`,
            ),
          );
          return;
        }
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(new Error(`worker exited before ready (code ${code})`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
  }

  private waitForExit(): Promise<void> {
    if (this.worker === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const previous = this.exitResolve;
      this.exitResolve = () => {
        previous?.();
        resolve();
      };
    });
  }

  // -- dispose -------------------------------------------------------------------------

  /**
   * Synchronously stop accepting new work (the service's dispose() calls
   * this before any awaiting): every later RPC fails fast with 'disposed',
   * and the worker's core is told NOW (control message) so an in-flight
   * sync abandons its remaining work at the next checkpoint instead of
   * wedging the dispose behind a running pass.
   */
  beginClose(): void {
    this.exiting = true;
    try {
      this.worker?.postMessage({ v: SEARCH_WORKER_PROTOCOL_VERSION, type: 'beginClose' });
    } catch {
      // A broken channel means the worker is already gone — nothing to notify.
    }
  }

  /**
   * A read-only answer while the lock could be an orphaned same-pid line
   * (left by a dead worker whose token event never landed) schedules a
   * re-check after a grace window — see recoverOrphanedLock.
   */
  private scheduleOrphanCheck(): void {
    if (this.orphanCheckScheduled || this.exiting) return;
    this.orphanCheckScheduled = true;
    const timer = setTimeout(() => {
      this.orphanCheckScheduled = false;
      void this.recoverOrphanedLock();
    }, ORPHAN_LOCK_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Safety net behind the `lockToken` event: this instance is being served
   * read-only while the lock line carries THIS process's pid. The line is
   * legitimate only when its token belongs to a live worker of this process
   * (`liveLockTokens`); anything else is an orphan left by a dead worker
   * (its token event was lost with it) — reap it and restart the worker so
   * the next request reopens as the writer instead of silently serving a
   * frozen read-only view until process exit.
   */
  private async recoverOrphanedLock(): Promise<void> {
    if (this.exiting || this.worker === null) return;
    const lockPath = join(this.dir, 'db.lock');
    let token: string;
    try {
      const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as {
        pid?: unknown;
        token?: unknown;
      };
      if (parsed.pid !== process.pid || typeof parsed.token !== 'string') return;
      token = parsed.token;
    } catch {
      return; // gone or unreadable — nothing to reap
    }
    if (liveLockTokens.has(token)) return; // a live worker of this process owns it
    // Compare-then-delete: re-read the line right before removing it — a new
    // owner may have replaced it since the judgment above, and deleting a
    // live owner's lock would admit a second writer.
    try {
      const again = JSON.parse(await readFile(lockPath, 'utf8')) as {
        pid?: unknown;
        token?: unknown;
      };
      if (again.pid !== process.pid || again.token !== token) return;
      if (liveLockTokens.has(token)) return;
    } catch {
      return; // vanished or replaced mid-check — nothing safe to reap
    }
    this.log.warn('global search: reaping an orphaned same-pid lock and restarting the worker', {
      dir: this.dir,
    });
    await rm(lockPath, { force: true }).catch(() => {});
    const worker = this.worker;
    if (worker === null) return;
    // The current worker opened read-only because of the orphan; terminate
    // it — the dirty-exit path (backoff, then a lazy respawn on the next
    // RPC) brings up a writer.
    await worker.terminate().catch(() => {});
  }

  dispose(): Promise<void> {
    this.exiting = true;
    this.disposePromise ??= this.doDispose();
    return this.disposePromise;
  }

  private disposePromise: Promise<void> | null = null;

  private async doDispose(): Promise<void> {
    // A spawn in flight must settle (successfully or not) before the close
    // decision; a spawn that wins the race still gets closed below.
    await this.spawnPromise?.catch(() => {});
    const worker = this.worker;
    if (worker === null) return;
    const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      // The close request bypasses ensureWorker (the host is already marked
      // exiting) but still rides the request multiplexer.
      await Promise.race([
        this.sendRequest(worker, 'close'),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`search worker close timed out after ${closeTimeoutMs}ms`));
          }, closeTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch {
      // Drain failures and timeouts both fall through to the terminate backstop.
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
    if (this.worker !== null) {
      await worker.terminate().catch(() => {});
      await this.waitForExit();
    }
  }
}
