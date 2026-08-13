// app-core api — daemon REST + WS client and its supporting types.
//
// The transport (DaemonHttpClient / DaemonEventSocket) and the high-level client
// (DaemonKimiWebApi) are constructed with an injected Tracer + CredentialStore;
// createKimiWebApi is the composition root, wiring the in-package agent event
// projector with an injected translator, so this package never imports a
// consumer's tracer, credential store, or i18n runtime.

export { DaemonKimiWebApi } from './daemon/client';
export type { DaemonKimiWebApiOptions } from './daemon/client';
export { createKimiWebApi } from './createKimiWebApi';
export type { CreateKimiWebApiDeps } from './createKimiWebApi';
export { createAgentProjector, subagentProgressText } from './daemon/agentEventProjector';
export { DaemonHttpClient, SERVER_AUTH_UNAUTHORIZED_CODE } from './daemon/http';
export type { DaemonHttpClientOptions } from './daemon/http';
export { DaemonEventSocket } from './daemon/ws';
export type { DaemonEventSocketHandlers, DaemonEventSocketOptions } from './daemon/ws';
export { classifyFrame } from './daemon/frameClassifier';
export type { FrameRoute } from './daemon/frameClassifier';
export type { AgentProjector, ProjectMeta } from './daemon/projector';
export { toAppEvent, toAppMessageContent, toAppSessionFromV2, isPlaceholderSessionUsage, mergeSnapshotSession } from './daemon/mappers';
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
  SESSION_EXPORT_TOO_LARGE_CODE,
  V2_PAGE_TOKEN_MISMATCH_CODE,
} from './errors';
export * from './types';
