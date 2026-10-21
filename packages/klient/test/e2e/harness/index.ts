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

