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

export interface SearchWorkerData {
  readonly dir: string;
  readonly bootSalt: string;
  readonly textBuildWorkerPath?: string;
}

export type SearchWorkerCall =
  | { readonly id: number; readonly v: number; readonly type: 'open' }
  | { readonly id: number; readonly v: number; readonly type: 'search'; readonly params: CoreSearchParams }
  | { readonly id: number; readonly v: number; readonly type: 'sync'; readonly params: { readonly sessions: readonly SyncSessionInput[] } }
  | { readonly id: number; readonly v: number; readonly type: 'refresh' }
  | { readonly id: number; readonly v: number; readonly type: 'reindex' }
  | { readonly id: number; readonly v: number; readonly type: 'status' }
  | { readonly id: number; readonly v: number; readonly type: 'close' };

export type SearchWorkerCallType = SearchWorkerCall['type'];

export interface SearchWorkerControlMessage {
  readonly v: number;
  readonly type: 'beginClose';
}

export type SearchWorkerRequest = SearchWorkerCall | SearchWorkerControlMessage;

export interface SearchWorkerOpenResult {
  readonly readOnly: boolean;
  readonly lockToken?: string;
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
      readonly type: 'lockToken';
      readonly token: string;
    }
  | { readonly id: number; readonly type: 'result'; readonly result: unknown }
  | { readonly id: number; readonly type: 'error'; readonly error: SearchWorkerErrorPayload };
