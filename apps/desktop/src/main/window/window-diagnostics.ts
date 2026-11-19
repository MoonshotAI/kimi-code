import { basename } from 'node:path';

import type { WebContents } from 'electron';

import { log, redactUrlForLog, uptimeMs } from '../diagnostics/log';
import { sanitizeRendererLogMessage } from '../diagnostics/renderer-log';

const CONSOLE_CAPTURE_AFTER_LOAD_MS = 15_000;
const MAX_CONSOLE_LINES_PER_DOCUMENT = 30;
const ERR_ABORTED = -3;

type DiagnosedContents = Pick<WebContents, 'on' | 'getOSProcessId'>;

function rendererPid(contents: DiagnosedContents): number | null {
  try {
    const pid = contents.getOSProcessId();
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function logLoadFailure(kind: string, code: number, description: string, url: string): void {
  const line = `[nav] ${kind} code=${code} ${description} url=${redactUrlForLog(url)}`;
  if (code === ERR_ABORTED) log.info(line);
  else log.warn(line);
}

export function attachWindowDiagnostics(contents: DiagnosedContents, now: () => number = Date.now): void {
  let consoleDeadline = Number.POSITIVE_INFINITY;
  let consoleLines = 0;
  let unresponsiveSince: number | null = null;
  let lastRendererPid: number | null = null;

  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    consoleDeadline = Number.POSITIVE_INFINITY;
    consoleLines = 0;
    log.info(`[nav] start url=${redactUrlForLog(details.url)} at=+${uptimeMs()}ms`);
  });
  contents.on('did-finish-load', () => {
    consoleDeadline = now() + CONSOLE_CAPTURE_AFTER_LOAD_MS;
    lastRendererPid = rendererPid(contents) ?? lastRendererPid;
    log.info(`[nav] finish at=+${uptimeMs()}ms renderer_pid=${lastRendererPid ?? '?'}`);
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) logLoadFailure('fail', code, description, url);
  });
  contents.on('did-fail-provisional-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) logLoadFailure('fail-provisional', code, description, url);
  });
  contents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`[preload] ${basename(preloadPath)} threw`, error);
  });
  contents.on('unresponsive', () => {
    unresponsiveSince = now();
    log.warn('[proc] renderer unresponsive');
  });
  contents.on('responsive', () => {
    const stalledFor = unresponsiveSince === null ? '' : ` after=${now() - unresponsiveSince}ms`;
    unresponsiveSince = null;
    log.info(`[proc] renderer responsive${stalledFor}`);
  });
  contents.on('render-process-gone', (_event, details) => {
    const line = `[proc] renderer gone reason=${details.reason} exit_code=${details.exitCode} pid=${lastRendererPid ?? '?'}`;
    if (details.reason === 'clean-exit') log.info(line);
    else log.error(line);
  });
  contents.on('console-message', (details) => {
    if (details.level !== 'error') return;
    if (now() > consoleDeadline || consoleLines >= MAX_CONSOLE_LINES_PER_DOCUMENT) return;
    consoleLines += 1;
    const source = details.sourceId === '' ? '' : ` (${redactUrlForLog(details.sourceId)}:${details.lineNumber})`;
    log.error(`[console] ${sanitizeRendererLogMessage(details.message)}${source}`);
  });
}
