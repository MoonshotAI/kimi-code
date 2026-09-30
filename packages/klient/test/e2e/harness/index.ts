/**
 * `@moonshot-ai/server-e2e` — wire-level test client for the kimi-code server.
 *
 * Use this package from scenarios (`scenarios/*.ts`) and vitest e2e tests
 * to drive a real server process at `http://127.0.0.1:58627` (or any baseUrl
 * you pass via `DaemonClientOptions.baseUrl`).
 *
 * Public surface:
 *   - `DaemonClient`           — main facade (HTTP + WS lifecycle)
 *   - `HttpClient`             — REST helpers only (typed, envelope-unwrap)
 *   - `WsClient`               — raw WS wrapper (queue + waiters + acks)
 *   - `EnvelopeError`          — thrown on `code !== 0`
 *   - `fetchWithReport` / `writeHtmlReport` — report capture + rendering
 *   - `installReverseRpcHandler` — uniform helper for approval/question
 *   - `waitForFrame` / `waitForSessionBusy` — standalone wait helpers
 *
 * Wire DTO types are NOT re-exported here — scenarios import them from
 * `@moonshot-ai/kap-server/protocol/*` or agent-core-v2 directly.
 */
export { DaemonClient } from './client.js';
export type {
  DaemonClientOptions,
  SubmitAndWaitOptions,
  TerminalAttachOptions,
  TerminalAttachResult,
  TerminalCloseResult,
  TerminalControlOptions,
  TerminalDetachResult,
  TerminalInputResult,
  TerminalResizeResult,
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

export { DEFAULT_FRAME_TIMEOUT_MS, waitForFrame, waitForSessionBusy } from './wait.js';

