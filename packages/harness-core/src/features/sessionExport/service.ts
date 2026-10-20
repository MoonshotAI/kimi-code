import type { Journal } from '@moonshot-ai/agent-core/store/index';

import { resolve } from 'pathe';

import { SessionExportError } from './errors';
import { openZipSource, type ZipSource } from './file-source';
import { buildExportManifest, type ExportSessionManifestSummary } from './manifest';
import { readSessionLogs, scanSessionLogs } from './scan';
import type { ExportSessionInput, ExportSessionResult } from './sessionExport';
import { writeExportZip, type ExtraZipEntry } from './zip';

const GLOBAL_LOG_REL = 'logs/global/kimi-code.log';
const WEB_LOG_REL = 'logs/kimi-web.jsonl';
const DESKTOP_LOG_REL = 'logs/kimi-desktop.log';

export async function exportSessionJournal(input: {
  readonly request: ExportSessionInput;
  readonly summary: ExportSessionManifestSummary;
  readonly version: string;
  readonly wireProtocolVersion?: string;
  readonly journal: Journal;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
}): Promise<ExportSessionResult> {
  const signal = input.request.signal;
  signal?.throwIfAborted();
  let globalSource: ZipSource | undefined;
  let globalSourceTransferred = false;
  let desktopSource: ZipSource | undefined;
  let desktopSourceTransferred = false;

  try {
    if (input.globalLogPath !== undefined) {
      globalSource = await openOptionalZipSource(input.globalLogPath, signal);
    }
    if (input.desktopLogPath !== undefined) {
      desktopSource = await openOptionalZipSource(input.desktopLogPath, signal);
    }
    const logs = await readSessionLogs(input.journal, signal);
    if (logs.length === 0) {
      throw new SessionExportError(
        'session.export_not_found',
        `Session "${input.summary.id}" has no exportable journal.`,
        { details: { sessionId: input.summary.id } },
      );
    }

    const sessionScan = scanSessionLogs(logs);
    const now = new Date();
    const manifest = buildExportManifest({
      summary: input.summary,
      now,
      version: input.version,
      wireProtocolVersion: input.wireProtocolVersion,
      sessionScan,
      globalLogPath: globalSource === undefined ? undefined : GLOBAL_LOG_REL,
      desktopLogPath: desktopSource === undefined ? undefined : DESKTOP_LOG_REL,
      webLogPath: input.request.webLog === undefined ? undefined : WEB_LOG_REL,
      desktopVersion: input.request.desktopVersion,
      installSource: input.request.installSource,
      shellEnv: input.request.shellEnv,
    });
    const outputPath =
      input.request.outputPath !== undefined
        ? resolve(input.request.outputPath)
        : resolve(defaultExportZipName(input.summary.id, now));
    const extras: ExtraZipEntry[] = [];
    if (input.request.webLog !== undefined) {
      extras.push({ data: Buffer.from(input.request.webLog, 'utf8'), target: WEB_LOG_REL });
    }
    if (globalSource !== undefined) {
      extras.push({ source: globalSource, target: GLOBAL_LOG_REL });
    }
    if (desktopSource !== undefined) {
      extras.push({ source: desktopSource, target: DESKTOP_LOG_REL });
    }

    const writing = writeExportZip({
      outputPath,
      manifest,
      logs: logs.map((log) => ({
        name: log.name,
        data: Buffer.from(log.lines.map((line) => `${line}\n`).join(''), 'utf8'),
      })),
      extraEntries: extras,
      signal,
    });
    globalSourceTransferred = globalSource !== undefined;
    desktopSourceTransferred = desktopSource !== undefined;
    const entries = await writing;

    return {
      zipPath: outputPath,
      entries,
      manifest,
    };
  } finally {
    if (globalSource !== undefined && !globalSourceTransferred) {
      await globalSource.close().catch(() => {});
    }
    if (desktopSource !== undefined && !desktopSourceTransferred) {
      await desktopSource.close().catch(() => {});
    }
  }
}

export function defaultExportZipName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
}

async function openOptionalZipSource(
  path: string,
  signal: AbortSignal | undefined,
): Promise<ZipSource | undefined> {
  try {
    return await openZipSource(path, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
