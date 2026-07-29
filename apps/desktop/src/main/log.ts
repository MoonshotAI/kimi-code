// Main-process file logger + crash guards.
//
// Until now the main process wrote straight to stdout/stderr, which packaged
// builds discard — Electron's uncaughtException dialog was the only "log"
// users ever saw. This module appends plain lines to
// `<kimi home>/logs/kimi-code-desktop.log` (size-rotated, one archive), mirrors
// them to stdout/stderr for dev, and installs the process-level handlers so
// uncaught errors land in the file before they surface.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { app, dialog } from 'electron';

// track.ts itself stays cheap to load: its agent-core-v2 import is
// `import type` (erased at build) and the zod schema from shared/track-events
// is a small pure module — this file's load-time graph stays tiny by design.
import { trackDesktopEvent } from './track';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

type Level = 'INFO' | 'WARN' | 'ERROR';

let logFilePath: string | null = null;
let logFileBytes = 0;
let guardsInstalled = false;

// Same resolution as kimi-code-sdk's resolveKimiHome, re-implemented inline so
// this module's import graph stays tiny: index.ts loads it before anything
// else, and every extra dependency is another module whose own load-time
// failure the crash guard could not capture.
function kimiHome(): string {
  return process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function defaultMainLogPath(): string {
  return join(kimiHome(), 'logs', 'kimi-code-desktop.log');
}

/**
 * Strip credentials, query and fragment from a URL before it enters the log
 * file. `KIMI_SERVER_URL` may carry basic-auth userinfo (kept by
 * normalizeServerOrigin because the connection needs it), and the renderer
 * URL carries the server token in `#token=` — neither belongs on disk.
 */
export function redactUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

function rotateIfOversized(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // Missing file (first run) or fs trouble — logging must never break startup.
  }
}

/**
 * Point the logger at `path` (default `<kimi home>/logs/kimi-code-desktop.log`) and
 * install the crash guards (once). Re-calling re-targets the file; used by
 * tests to aim at a temp dir.
 */
export function initMainLogging(path: string = defaultMainLogPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfOversized(path);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // File does not exist yet; first write creates it.
    }
    logFilePath = path;
    logFileBytes = size;
  } catch {
    logFilePath = null;
  }
  installCrashGuards();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function writeLine(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level}  ${message}\n`;
  if (logFilePath !== null) {
    try {
      appendFileSync(logFilePath, line);
      logFileBytes += Buffer.byteLength(line);
      if (logFileBytes > MAX_LOG_BYTES) {
        renameSync(logFilePath, `${logFilePath}.1`);
        logFileBytes = 0;
      }
    } catch {
      // Disk full / permissions: fall through to the console mirror only.
    }
  }
  (level === 'INFO' ? process.stdout : process.stderr).write(line);
}

export const log = {
  info(message: string): void {
    writeLine('INFO', message);
  },
  warn(message: string): void {
    writeLine('WARN', message);
  },
  error(message: string, error?: unknown): void {
    writeLine('ERROR', error === undefined ? message : `${message}  ${formatError(error)}`);
  },
};

/**
 * The one uncaught failure we deliberately swallow: aborting an undici
 * fetch/Response body mid-stream races undici's internal read loop into
 * closing an already-closed controller. It throws inside `node:internal/*`
 * frames, so no try/catch in our code can reach it (electron/electron#48582,
 * vercel/next.js#74237); Electron 43's bundled undici still does this. The
 * request is already dead by then, so it is harmless — log it instead of
 * showing the crash dialog.
 */
export function isUndiciStreamCloseRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE' &&
    error.message.includes('ReadableStream is already closed')
  );
}

function surfaceUncaught(error: unknown): void {
  // Preserve Electron's default visibility for genuinely unexpected errors.
  // The crash guard can fire before the renderer pushed its locale, so the
  // title follows the OS language.
  try {
    const zh = app.getLocale().toLowerCase().startsWith('zh');
    const title = zh ? '主进程发生 JavaScript 错误' : 'A JavaScript error occurred in the main process';
    dialog.showErrorBox(title, formatError(error));
  } catch {
    // App not ready / shutting down — the file log already has it.
  }
}

export function installCrashGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('uncaughtException', (error) => {
    if (isUndiciStreamCloseRace(error)) {
      log.warn('ignored benign undici stream-close race (aborted fetch body)');
      return;
    }
    log.error('uncaughtException', error);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: error.name,
      app_uptime_ms: Math.round(process.uptime() * 1000),
    });
    surfaceUncaught(error);
  });
  process.on('unhandledRejection', (reason) => {
    if (isUndiciStreamCloseRace(reason)) {
      log.warn('ignored benign undici stream-close race (aborted fetch body)');
      return;
    }
    // Installing this listener suppresses Node's default promotion of the
    // rejection to the fatal uncaught-exception path, so route genuinely
    // unexpected rejections through the same surfacing as exceptions.
    log.error('unhandledRejection', reason);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'unhandled_rejection',
      error_name: reason instanceof Error ? reason.name : undefined,
      app_uptime_ms: Math.round(process.uptime() * 1000),
    });
    surfaceUncaught(reason);
  });
}
