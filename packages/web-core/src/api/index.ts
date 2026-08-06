// web-core api — daemon REST + WS client and its supporting types.
//
// The transport (DaemonHttpClient / DaemonEventSocket) and the high-level client
// (DaemonKimiWebApi) are constructed with an injected Tracer + CredentialStore
// (plus a consumer-supplied projector factory), so this package never imports a
// consumer's tracer, credential store, i18n, or tool labeling.

export { DaemonKimiWebApi } from './daemon/client';
export type { DaemonKimiWebApiOptions } from './daemon/client';
export { DaemonHttpClient, SERVER_AUTH_UNAUTHORIZED_CODE } from './daemon/http';
export type { DaemonHttpClientOptions } from './daemon/http';
export { DaemonEventSocket } from './daemon/ws';
export type { DaemonEventSocketHandlers, DaemonEventSocketOptions } from './daemon/ws';
export { classifyFrame } from './daemon/frameClassifier';
export type { FrameRoute } from './daemon/frameClassifier';
export type { AgentProjector, ProjectMeta } from './daemon/projector';
export { toAppEvent, toAppMessageContent, toAppSessionFromV2, isPlaceholderSessionUsage } from './daemon/mappers';
export type { WireMessageContent } from './daemon/wire';
export {
  createInitialState,
  reduceAppEvent,
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
  isDaemonApiError,
  isDaemonNetworkError,
  isFileTooLargeError,
  isPageTokenMismatchError,
  V2_PAGE_TOKEN_MISMATCH_CODE,
} from './errors';
export * from './types';
