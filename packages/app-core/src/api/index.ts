
export { DaemonKimiWebApi } from './daemon/client';
export type { DaemonKimiWebApiOptions } from './daemon/client';
export { createKimiWebApi } from './createKimiWebApi';
export type { HostRoutingControls } from './hostRouting';
export type { CreateKimiWebApiDeps } from './createKimiWebApi';
export { DaemonHttpClient, SERVER_AUTH_UNAUTHORIZED_CODE } from './daemon/http';
export type { DaemonHttpClientOptions } from './daemon/http';
export { DaemonEventSocket } from './daemon/ws';
export type { DaemonEventSocketHandlers, DaemonEventSocketOptions } from './daemon/ws';
export { toAppEvent, toAppSession, isPlaceholderSessionUsage } from './daemon/mappers';
export type { WireMessageContent } from './daemon/wire';
export {
  createInitialState,
  reduceAppEvent,
  buildAgentErrorNotice,
  isModelTurnErrorNotice,
  type CompactionStatus,
  type EventMeta,
  type KimiClientState,
  type ReduceContext,
} from './daemon/eventReducer';
export { shallowEqualArray, shallowEqualRecord } from './daemon/sliceEquality';
export { buildRestUrl, buildWsUrl } from './config';
export {
  DaemonApiError,
  DaemonNetworkError,
  FileTooLargeError,
  FS_ALREADY_EXISTS_CODE,
  FS_DIRECTORY_NOT_FOUND_CODE,
  FS_GIT_UNAVAILABLE_CODE,
  FS_PATH_NOT_FOUND_CODE,
  FS_PERMISSION_DENIED_CODE,
  FS_VALIDATION_FAILED_CODE,
  isDaemonApiError,
  isDaemonNetworkError,
  isDaemonTimeoutError,
  isFileTooLargeError,
  isPageTokenMismatchError,
  isSessionOccupiedError,
  isSessionStaleError,
  PAGE_TOKEN_MISMATCH_CODE,
  SESSION_BUSY_CODE,
  SESSION_EXPORT_TOO_LARGE_CODE,
  SESSION_OCCUPIED_CODE,
  SESSION_STALE_CODE,
  sessionOccupiedHolderClient,
  sessionOccupiedHolderDisplayName,
  WORKTREE_NOT_FOUND_CODE,
  WORKTREE_REMOVE_FAILED_CODE,
  WORKTREE_STATE_INVALID_CODE,
  WORKTREE_UNSUPPORTED_CODE,
  worktreeRemoveFailure,
} from './errors';
export * from './types';
