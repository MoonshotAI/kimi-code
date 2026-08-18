import type { GlobalSearchErrorReason } from '../contract.ts';
import type {
  CoreLifecycleReport,
  CoreSearchParams,
  CoreSearchResult,
  CoreStatus,
  CoreSyncOutcome,
  SyncSessionInput,
} from '../indexCore.ts';

export const SEARCH_WORKER_PROTOCOL_VERSION = 1;

/** `workerData` payload for the search worker. */
export interface SearchWorkerData {
  /** Absolute path of the search-index database directory. */
  readonly dir: string;
  /**
   * Unique-per-spawn boot identifier, mixed into the index generation the
   * worker reports: page tokens issued before a worker restart NEVER
   * validate against the respawned worker (its local generation counter
   * restarts from 0), so mid-pagination clients get `invalid_page_token`
   * and restart the search instead of drifting across two generations that
   * happen to share a number.
   */
  readonly bootSalt: string;
  /**
   * Packaged (SEA-extracted) minidb text-build worker file. The main process
   * already extracted it for its own minidb; the search worker configures
   * its own copy of the runtime so full-text generation builds triggered by
   * the search-index MiniDb keep running in a nested worker instead of
   * inline in the search worker. Absent in dev (minidb resolves its own
   * sibling .ts entry) and in plain bundles (inline-in-worker fallback).
   */
  readonly textBuildWorkerPath?: string;
}

/** RPC calls: carry a request id and always produce a response. */
export type SearchWorkerCall =
  | { readonly id: number; readonly v: number; readonly type: 'open' }
  | { readonly id: number; readonly v: number; readonly type: 'search'; readonly params: CoreSearchParams }
  | { readonly id: number; readonly v: number; readonly type: 'sync'; readonly params: { readonly sessions: readonly SyncSessionInput[] } }
  | { readonly id: number; readonly v: number; readonly type: 'refresh' }
  | { readonly id: number; readonly v: number; readonly type: 'reindex' }
  | { readonly id: number; readonly v: number; readonly type: 'status' }
  | { readonly id: number; readonly v: number; readonly type: 'close' };

export type SearchWorkerCallType = SearchWorkerCall['type'];

/**
 * Control message (no id, no response): flip the worker-side core into
 * closing state NOW so an in-flight sync abandons its remaining work at the
 * next checkpoint — the host's beginClose()/dispose() must never be wedged
 * behind a running pass.
 */
export interface SearchWorkerControlMessage {
  readonly v: number;
  readonly type: 'beginClose';
}

/** Everything the host may post to the worker. */
export type SearchWorkerRequest = SearchWorkerCall | SearchWorkerControlMessage;

/** Response payload of the `open` / `refresh` / `reindex` requests. */
export interface SearchWorkerOpenResult {
  readonly readOnly: boolean;
  readonly lockToken?: string;
  /**
   * The core's lifecycle right after the call (stage 5): lets the host keep
   * its cached aggregate state exact across worker (re)opens — an open that
   * published a still-building text base reports 'building', not 'ready'.
   */
  readonly lifecycle: CoreLifecycleReport;
}

export interface SearchWorkerResultMap {
  readonly open: SearchWorkerOpenResult;
  readonly search: CoreSearchResult;
  readonly sync: CoreSyncOutcome;
  readonly refresh: SearchWorkerOpenResult;
  readonly reindex: SearchWorkerOpenResult;
  readonly status: CoreStatus;
  readonly close: null;
}

/** Serializable failure: typed search errors keep their reason. */
export interface SearchWorkerErrorPayload {
  readonly message: string;
  readonly reason?: GlobalSearchErrorReason;
}

export type SearchWorkerEvent =
  | { readonly type: 'ready'; readonly v: number }
  | {
      readonly type: 'log';
      readonly level: 'info' | 'warn';
      readonly message: string;
      readonly meta?: Record<string, unknown>;
    }
  | {
      /**
       * Fired the moment the worker's MiniDb acquires the write lock —
       * BEFORE the heavy open work (WAL replay / generation load) runs. The
       * host needs the token up front: a worker that dies mid-open
       * otherwise leaves a lock line carrying this process's (still alive)
       * pid, which minidb's pid-liveness rule can never reclaim.
       */
      readonly type: 'lockToken';
      readonly token: string;
    }
  | { readonly id: number; readonly type: 'result'; readonly result: unknown }
  | { readonly id: number; readonly type: 'error'; readonly error: SearchWorkerErrorPayload };
