/**
 * `@moonshot-ai/daemon-e2e` — wire-level test client for the kimi-code daemon.
 *
 * Use this package from scenarios (`scenarios/*.ts`) and vitest e2e tests
 * to drive a real daemon process at `http://127.0.0.1:7878` (or any baseUrl
 * you pass via `DaemonClientOptions.baseUrl`).
 *
 * Public surface:
 *   - `DaemonClient`           — main facade (HTTP + WS lifecycle)
 *   - `HttpClient`             — REST helpers only (typed, envelope-unwrap)
 *   - `WsClient`               — raw WS wrapper (queue + waiters + acks)
 *   - `EnvelopeError`          — thrown on `code !== 0`
 *   - `fetchWithReport` / `writeHtmlReport` — report capture + rendering
 *   - `installReverseRpcHandler` — uniform helper for approval/question
 *   - `waitForFrame` / `waitForSessionStatus` — standalone wait helpers
 *
 * Re-exports `@moonshot-ai/protocol` types are NOT bundled here — scenarios
 * that want them import from `@moonshot-ai/protocol` directly.
 */
export { DaemonClient } from './client.js';
export type {
  DaemonClientOptions,
  SubmitAndWaitOptions,
} from './client.js';

export { HttpClient } from './http.js';
export type { HttpClientOptions } from './http.js';

export { WsClient } from './ws.js';
export type { AnyFrame, WsClientOptions } from './ws.js';

export { EnvelopeError, unwrap } from './envelope.js';

export {
  defaultReportDir,
  fetchWithReport,
  getActiveReportCase,
  readReportEvents,
  recordReportEvent,
  resetReportDir,
  setActiveReportCase,
  writeHtmlReport,
} from './report.js';
export type {
  FetchWithReportOptions,
  HtmlReportOptions,
  HttpReportEvent,
  LogReportEvent,
  ReportEvent,
  ReportEventBase,
  ReportEventKind,
  ReportOptions,
  StoredReportEvent,
  TestResultReportEvent,
  WsDirection,
  WsReportEvent,
} from './report.js';

export { installReverseRpcHandler } from './reverse-rpc.js';
export type { ReverseRpcOptions } from './reverse-rpc.js';

export { DEFAULT_FRAME_TIMEOUT_MS, waitForFrame, waitForSessionStatus } from './wait.js';
