
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { cpus, homedir, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';

import { app, dialog } from 'electron';

import { signatureOf } from '../../shared/error-signature';
import { releaseChannelName, type ReleaseChannelName } from '../release/release-channel';
import { trackDesktopEvent } from './track';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_ROTATED_LOGS = 5;
const REPEAT_WINDOW_MS = 60_000;
const RECENT_LINES = 200;
const MAX_TIMELINE_STEPS = 100;

export const MAIN_LOG_FILE = 'kimi-code-desktop.log';
export const INCIDENTS_DIR = 'desktop-incidents';
export const CRASH_DUMPS_DIR = 'desktop-crashes';

export type LogLevel = 'info' | 'warn' | 'error';

const LEVEL_LABELS: Record<LogLevel, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

const MAIN_LOG_SOURCE = `m${process.pid}`;
const LAUNCH_ID = randomUUID().replaceAll('-', '').slice(0, 12);

let logFilePath: string | null = null;
let logFileBytes = 0;
let guardsInstalled = false;
let consoleMirror = true;
let mainWindowCreated = false;
const rememberedDiagnosticRoots = new Set<string>();
const recentLines: string[] = [];
let channel: ReleaseChannelName | null = null;

export function launchId(): string {
  return LAUNCH_ID;
}

export function launchChannel(): ReleaseChannelName {
  channel ??= releaseChannelName(app.getVersion(), app.isPackaged);
  return channel;
}

export function recentLogLines(): string[] {
  return [...recentLines];
}

function kimiHome(): string {
  return process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function logsDir(): string {
  return join(kimiHome(), 'logs');
}

export function defaultMainLogPath(): string {
  return join(logsDir(), MAIN_LOG_FILE);
}

export function addDiagnosticRoot(root: string): void {
  rememberedDiagnosticRoots.add(root);
}

export function diagnosticRoots(): string[] {
  return [...new Set([logsDir(), ...rememberedDiagnosticRoots])];
}

export function tildify(path: string): string {
  const home = homedir();
  if (home === '' || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : path;
}

export function uptimeMs(): number {
  return Math.round(process.uptime() * 1000);
}

export function redactUrlForLog(raw: string): string {
  if (raw.startsWith('data:')) return 'data:(inline page)';
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

export function rotateLogFiles(path: string): void {
  for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

function rotateIfOversized(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      rotateLogFiles(path);
    }
  } catch {}
}

export function initMainLogging(path: string = defaultMainLogPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfOversized(path);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {}
    logFilePath = path;
    logFileBytes = size;
    addDiagnosticRoot(dirname(path));
  } catch {
    logFilePath = null;
  }
  installCrashGuards();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

let lastLineWritten = false;

function rotateAfterGrowth(path: string): void {
  const actualBytes = statSync(path).size;
  if (actualBytes > MAX_LOG_BYTES) {
    rotateLogFiles(path);
    logFileBytes = 0;
  } else {
    logFileBytes = actualBytes;
  }
}

function emitLine(level: LogLevel, source: string, message: string): void {
  const line = `${new Date().toISOString()} ${LEVEL_LABELS[level]}  [${source}] ${message}\n`;
  recentLines.push(line.length > 2_000 ? `${line.slice(0, 2_000)}…\n` : line);
  if (recentLines.length > RECENT_LINES) recentLines.shift();
  lastLineWritten = false;
  if (logFilePath !== null) {
    try {
      appendFileSync(logFilePath, line);
      lastLineWritten = true;
      logFileBytes += Buffer.byteLength(line);
      if (logFileBytes > MAX_LOG_BYTES) rotateAfterGrowth(logFilePath);
    } catch {}
  }
  if (!consoleMirror) return;
  try {
    (level === 'info' ? process.stdout : process.stderr).write(line);
  } catch {
    consoleMirror = false;
  }
}

interface RepeatState {
  key: string;
  level: LogLevel;
  source: string;
  firstAt: number;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let repeat: RepeatState | null = null;

function flushRepeats(): void {
  if (repeat === null) return;
  if (repeat.timer !== null) {
    clearTimeout(repeat.timer);
    repeat.timer = null;
  }
  const { count, level, source } = repeat;
  if (count === 0) return;
  repeat.count = 0;
  emitLine(level, source, `previous line repeated ${count} more time${count === 1 ? '' : 's'}`);
}

export function writeLog(level: LogLevel, message: string, source: string = MAIN_LOG_SOURCE): void {
  const key = `${level}\u0000${source}\u0000${message}`;
  const now = Date.now();
  if (repeat !== null && repeat.key === key && now - repeat.firstAt < REPEAT_WINDOW_MS) {
    repeat.count += 1;
    lastLineWritten = true;
    if (repeat.timer === null) {
      repeat.timer = setTimeout(flushRepeats, repeat.firstAt + REPEAT_WINDOW_MS - now);
      repeat.timer.unref?.();
    }
    return;
  }
  flushRepeats();
  repeat = { key, level, source, firstAt: now, count: 0, timer: null };
  emitLine(level, source, message);
}

export const log = {
  info(message: string): void {
    writeLog('info', message);
  },
  warn(message: string): void {
    writeLog('warn', message);
  },
  error(message: string, error?: unknown): void {
    writeLog('error', error === undefined ? message : `${message}  ${formatError(error)}`);
  },
};

export interface StartupStep {
  step: string;
  atMs: number;
  details?: string;
}

type StartupListener = (entry: StartupStep) => void;

const startupListeners = new Set<StartupListener>();
const timeline: StartupStep[] = [];

export function onStartupStep(listener: StartupListener): () => void {
  startupListeners.add(listener);
  return () => startupListeners.delete(listener);
}

export function startupTimeline(): StartupStep[] {
  return [...timeline];
}

export function logStartup(step: string, details?: string): void {
  if (step === 'window-created') mainWindowCreated = true;
  const entry: StartupStep = { step, atMs: uptimeMs() };
  if (details !== undefined && details !== '') entry.details = details;
  log.info(`[startup] ${step} at=+${entry.atMs}ms${entry.details === undefined ? '' : ` ${entry.details}`}`);
  timeline.push(entry);
  if (timeline.length > MAX_TIMELINE_STEPS) timeline.shift();
  for (const listener of startupListeners) {
    try {
      listener(entry);
    } catch (error) {
      log.warn(`[startup] listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function systemVersion(): string {
  try {
    return typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
  } catch {
    return '';
  }
}

export function logLaunchBanner(): void {
  const version = app.getVersion();
  const cpuList = cpus();
  log.info(
    [
      '[launch]',
      `version=${version}`,
      `channel=${launchChannel()}`,
      `launch=${LAUNCH_ID}`,
      `os=${process.platform} ${systemVersion()} (kernel ${release()})`,
      `arch=${process.arch}`,
      `electron=${process.versions.electron}`,
      `chrome=${process.versions.chrome}`,
      `cpus=${cpuList.length}`,
      `cpu_model="${cpuList[0]?.model.trim() ?? 'unknown'}"`,
      `mem=${Math.round(totalmem() / (1024 * 1024))}MB`,
      `log=${tildify(logFilePath ?? defaultMainLogPath())}`,
    ].join(' '),
  );
}

export function isUndiciStreamCloseRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE' &&
    error.message.includes('ReadableStream is already closed')
  );
}

export interface UncaughtErrorReport {
  title: string;
  detail: string;
}

export type UncaughtErrorNotice = (report: UncaughtErrorReport) => void;

let uncaughtErrorNotice: UncaughtErrorNotice | null = null;
let uncaughtErrorSurfaced = false;

export function setUncaughtErrorNotice(notice: UncaughtErrorNotice | null): void {
  uncaughtErrorNotice = notice;
}

function uncaughtErrorReport(error: unknown): UncaughtErrorReport {
  const zh = app.getLocale().toLowerCase().startsWith('zh');
  const title = zh ? '应用发生内部错误' : 'A JavaScript error occurred in the main process';
  const shownPath =
    logFilePath !== null && !existsSync(logFilePath) ? `${logFilePath}.1` : logFilePath;
  const logLine =
    shownPath === null
      ? zh
        ? '\n\n（日志文件不可用）'
        : '\n\n(log file unavailable)'
      : !lastLineWritten
        ? zh
          ? '\n\n（日志写入失败，本次错误可能未被记录）'
          : '\n\n(log write failed; this error may not be recorded)'
        : zh
          ? `\n\n日志文件：${shownPath}`
          : `\n\nLog file: ${shownPath}`;
  return { title, detail: `${formatError(error)}${logLine}` };
}

function surfaceUncaught(error: unknown): void {
  if (uncaughtErrorSurfaced || (mainWindowCreated && uncaughtErrorNotice === null)) return;
  uncaughtErrorSurfaced = true;
  try {
    const report = uncaughtErrorReport(error);
    if (mainWindowCreated) uncaughtErrorNotice?.(report);
    else dialog.showErrorBox(report.title, report.detail);
  } catch {}
}

export function installCrashGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  for (const stdio of [process.stdout, process.stderr]) {
    stdio.on('error', () => {
      consoleMirror = false;
    });
  }
  process.on('uncaughtException', (error) => {
    if (isUndiciStreamCloseRace(error)) {
      log.warn('ignored benign undici stream-close race (aborted fetch body)');
      return;
    }
    const signature = signatureOf(error);
    log.error(`uncaughtException fingerprint=${signature.fingerprint}`, error);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'uncaught_exception',
      error_name: error.name,
      app_uptime_ms: Math.round(process.uptime() * 1000),
      fingerprint: signature.fingerprint,
      top_frame: signature.topFrame ?? undefined,
    });
    surfaceUncaught(error);
  });
  process.on('unhandledRejection', (reason) => {
    if (isUndiciStreamCloseRace(reason)) {
      log.warn('ignored benign undici stream-close race (aborted fetch body)');
      return;
    }
    const signature = signatureOf(reason);
    log.error(`unhandledRejection fingerprint=${signature.fingerprint}`, reason);
    trackDesktopEvent('app_crashed', {
      process: 'main',
      kind: 'unhandled_rejection',
      error_name: reason instanceof Error ? reason.name : undefined,
      app_uptime_ms: Math.round(process.uptime() * 1000),
      fingerprint: signature.fingerprint,
      top_frame: signature.topFrame ?? undefined,
    });
    surfaceUncaught(reason);
  });
}
