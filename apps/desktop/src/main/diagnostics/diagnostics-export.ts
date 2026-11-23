import { constants, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { app, dialog, shell } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { ZipFile } from 'yazl';

import { collectDiagnosticsSnapshot } from './collector';
import { CRASH_DUMPS_DIR, INCIDENTS_DIR, MAIN_LOG_FILE, diagnosticRoots, log, logsDir, systemVersion, tildify } from './log';
import { DIAGNOSTICS_RETENTION_MS, listCrashDumps, rotatedLogIndex } from './log-retention';
import type { TrayLocale } from '../shell/tray';
import { getMainWindow, showMainWindow } from '../window/main-window';
import type { FeedbackDiagnosticsArchive } from '../../shared/feedback-diagnostics';

const CORE_LOG_PATTERN = /^kimi-code\.log(\.\d+)?$/;
const LAUNCH_STATE_PATTERN = /^desktop-launch-[a-z]+\.json$/;
const FEEDBACK_ARCHIVE_LIMIT_BYTES = 100 * 1024 * 1024;

interface ExportStrings {
  exportedTitle: string;
  exportedDetail: (path: string) => string;
  showInFolder: string;
  ok: string;
  failedTitle: string;
  manualHint: (folders: number) => string;
  openLogsFolder: string;
}

const EXPORT_STRINGS: Record<TrayLocale, ExportStrings> = {
  zh: {
    exportedTitle: '诊断信息已导出',
    exportedDetail: (path) =>
      `已保存到：\n${path}\n\n其中包含应用日志、崩溃报告和运行环境信息。日志里可能有文件路径，崩溃报告可能带有少量内存数据，请只发送给 Kimi Code 团队。`,
    showInFolder: '在文件夹中显示',
    ok: '好',
    failedTitle: '诊断信息导出失败',
    manualHint: (folders) => `也可以直接把下面${folders > 1 ? '这些' : '这个'}文件夹压缩后发给我们：`,
    openLogsFolder: '打开日志文件夹',
  },
  en: {
    exportedTitle: 'Diagnostics exported',
    exportedDetail: (path) =>
      `Saved to:\n${path}\n\nIt contains app logs, crash reports and environment details. Logs may include file paths and crash reports may carry small amounts of memory data, so only share it with the Kimi Code team.`,
    showInFolder: 'Show in Folder',
    ok: 'OK',
    failedTitle: 'Could not export diagnostics',
    manualHint: (folders) =>
      folders > 1
        ? 'You can also compress these folders and send them to us:'
        : 'You can also compress this folder and send it to us:',
    openLogsFolder: 'Open Logs Folder',
  },
};

export interface DiagnosticsEntry {
  source: string;
  name: string;
}

function isRuntimeLogName(name: string): boolean {
  return (
    name === MAIN_LOG_FILE ||
    rotatedLogIndex(name) !== null ||
    CORE_LOG_PATTERN.test(name)
  );
}

async function sortedNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

export async function collectDiagnosticsEntries(
  logDirs: readonly string[],
  now: number = Date.now(),
): Promise<DiagnosticsEntry[]> {
  const entries: DiagnosticsEntry[] = [];
  const dirs = [...new Set(logDirs)];
  for (const [index, dir] of dirs.entries()) {
    const prefix = index === 0 ? '' : `extra-${index}/`;
    for (const name of await sortedNames(dir)) {
      if (isRuntimeLogName(name) || LAUNCH_STATE_PATTERN.test(name)) {
        entries.push({ source: join(dir, name), name: `${prefix}logs/${name}` });
      }
    }
    for (const name of await sortedNames(join(dir, INCIDENTS_DIR))) {
      if (name.endsWith('.json')) {
        entries.push({ source: join(dir, INCIDENTS_DIR, name), name: `${prefix}incidents/${name}` });
      }
    }
    const crashRoot = join(dir, CRASH_DUMPS_DIR);
    for (const dump of await listCrashDumps(crashRoot)) {
      if (now - dump.mtimeMs > DIAGNOSTICS_RETENTION_MS) continue;
      entries.push({ source: dump.path, name: `${prefix}crashes/${relative(crashRoot, dump.path).split(sep).join('/')}` });
    }
  }
  return entries;
}

export async function writeDiagnosticsZip(
  target: string,
  entries: readonly DiagnosticsEntry[],
  snapshot: unknown,
  scratchDir: string,
  copyEntry = (source: string, dest: string) => copyFile(source, dest, constants.COPYFILE_FICLONE),
): Promise<{ files: number; bytes: number }> {
  const zip = new ZipFile();
  let files = 0;
  for (const [index, entry] of entries.entries()) {
    const copy = join(scratchDir, String(index));
    try {
      await copyEntry(entry.source, copy);
    } catch {
      continue;
    }
    zip.addFile(copy, entry.name);
    files += 1;
  }
  zip.addBuffer(Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`), 'diagnostics.json');
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(target);
    zip.on('error', reject);
    output.on('error', reject);
    output.on('close', () => resolve());
    zip.outputStream.pipe(output);
    zip.end();
  });
  return { files, bytes: (await stat(target)).size };
}

export function diagnosticsFileName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `kimi-code-diagnostics-${stamp}.zip`;
}

async function copyFeedbackLog(source: string, dest: string): Promise<void> {
  const parent = dirname(source);
  const directory = await lstat(parent, { bigint: true });
  const expected = await lstat(source, { bigint: true });
  if (!directory.isDirectory() || !expected.isFile()) throw new Error('Not a regular feedback log');
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(source, flags);
  try {
    const actual = await handle.stat({ bigint: true });
    const currentParent = await lstat(parent, { bigint: true });
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
      || currentParent.dev !== directory.dev || currentParent.ino !== directory.ino) {
      throw new Error('Feedback log changed before it could be read');
    }
    await pipeline(handle.createReadStream(), createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  } finally {
    await handle.close();
  }
}

export async function collectFeedbackDiagnosticsArchive(): Promise<FeedbackDiagnosticsArchive> {
  const scratch = await mkdtemp(join(app.getPath('temp'), 'kimi-feedback-diagnostics-'));
  const fileName = diagnosticsFileName();
  const target = join(scratch, fileName);
  try {
    const dir = logsDir();
    const entries = (await sortedNames(dir)).filter(isRuntimeLogName).map((name) => ({ source: join(dir, name), name: `logs/${name}` }));
    const snapshot = { version: app.getVersion(), os: systemVersion(), platform: process.platform, arch: process.arch };
    const archive = await writeDiagnosticsZip(target, entries, snapshot, scratch, copyFeedbackLog);
    if (archive.bytes > FEEDBACK_ARCHIVE_LIMIT_BYTES) throw new Error('Feedback diagnostics archive is too large');
    const bytes = Uint8Array.from(await readFile(target)).buffer;
    return { fileName, bytes };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function showMessage(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = getMainWindow();
  if (win === null || win.isDestroyed()) return dialog.showMessageBox(options);
  showMainWindow();
  return dialog.showMessageBox(win, options);
}

export async function openLogsFolder(): Promise<void> {
  const dir = logsDir();
  try {
    await mkdir(dir, { recursive: true });
    const failure = await shell.openPath(dir);
    if (failure !== '') log.warn(`[diag] open logs folder failed: ${failure}`);
  } catch (error) {
    log.warn(`[diag] open logs folder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type ExportOutcome = { ok: true; target: string } | { ok: false; error: unknown };

async function buildDiagnosticsArchive(): Promise<ExportOutcome> {
  const startedAt = Date.now();
  let target: string | null = null;
  let scratch: string | null = null;
  try {
    log.info('[diag] export requested');
    target = join(app.getPath('downloads'), diagnosticsFileName());
    const [entries, snapshot] = await Promise.all([
      collectDiagnosticsEntries(diagnosticRoots()),
      collectDiagnosticsSnapshot(),
    ]);
    scratch = await mkdtemp(join(app.getPath('temp'), 'kimi-code-diagnostics-'));
    const result = await writeDiagnosticsZip(target, entries, snapshot, scratch);
    log.info(
      `[diag] exported ${tildify(target)} files=${result.files} bytes=${result.bytes} took=${Date.now() - startedAt}ms`,
    );
    return { ok: true, target };
  } catch (error) {
    log.error('[diag] export failed', error);
    if (target !== null) await rm(target, { force: true }).catch(() => undefined);
    return { ok: false, error };
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function reportExport(locale: TrayLocale, outcome: ExportOutcome): Promise<void> {
  const strings = EXPORT_STRINGS[locale];
  if (outcome.ok) {
    const { response } = await showMessage({
      type: 'info',
      message: strings.exportedTitle,
      detail: strings.exportedDetail(outcome.target),
      buttons: [strings.showInFolder, strings.ok],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.showItemInFolder(outcome.target);
    return;
  }
  const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  const folders = diagnosticRoots();
  const { response } = await showMessage({
    type: 'warning',
    message: strings.failedTitle,
    detail: `${reason}\n\n${strings.manualHint(folders.length)}\n${folders.join('\n')}`,
    buttons: [strings.openLogsFolder, strings.ok],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await openLogsFolder();
}

let exportInFlight = false;

export async function exportDiagnostics(locale: TrayLocale): Promise<void> {
  if (exportInFlight) return;
  exportInFlight = true;
  try {
    await reportExport(locale, await buildDiagnosticsArchive());
  } catch (error) {
    log.warn(`[diag] export dialog failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    exportInFlight = false;
  }
}
