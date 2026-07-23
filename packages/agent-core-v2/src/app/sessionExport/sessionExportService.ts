/**
 * `sessionExport` domain (L6) — `ISessionExportService` implementation.
 *
 * Coordinates live session flushing through `sessionLifecycle`, derives session
 * paths from `bootstrap`, reads persisted summaries through `sessionIndex`, and
 * packages diagnostic files through the local zip writer. Bound at App scope.
 */

import { join, resolve } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { resolveGlobalLogPath } from '#/_base/log/logConfig';
import { IWireService } from '#/wire/wire';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { buildExportManifest, type ExportSessionManifestSummary } from './manifest';
import {
  type ExportSessionPayload,
  type ExportSessionResult,
  type ExportSessionOptions,
  ISessionExportService,
} from './sessionExport';
import { scanSessionWire } from './wire-scan';
import {
  type ExtraZipEntry,
  type SessionZipEntry,
  collectFilesRecursive,
  writeExportZip,
} from './zip';
import { openZipSource, type ZipSource } from './file-source';

const SESSION_LOG_REL = 'logs/kimi-code.log';
const GLOBAL_LOG_REL = 'logs/global/kimi-code.log';
const WEB_LOG_REL = 'logs/kimi-web.jsonl';

export class SessionExportService implements ISessionExportService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @ILogService private readonly log: ILogService,
  ) {}

  async export(
    input: ExportSessionPayload,
    options: ExportSessionOptions = {},
  ): Promise<ExportSessionResult> {
    options.signal?.throwIfAborted();
    if (input.version.trim().length === 0) {
      throw new Error2(
        ErrorCodes.SESSION_EXPORT_MISSING_VERSION,
        'Session export requires a host version.',
        { details: { sessionId: input.sessionId } },
      );
    }

    const summary = await this.index.get(input.sessionId);
    if (summary === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${input.sessionId}" does not exist`,
        { details: { sessionId: input.sessionId } },
      );
    }

    const liveSummary = await this.flushLiveSession(summary);
    options.signal?.throwIfAborted();
    if (input.includeGlobalLog === true) {
      await this.warnIfFails('export global log flush failed', () => this.log.flush(), {
        retry: true,
      });
    }

    return exportSessionDirectory({
      request: input,
      summary: liveSummary,
      globalLogPath: resolveGlobalLogPath(this.bootstrap.homeDir),
      webLog: options.webLog,
      signal: options.signal,
      maxArchiveBytes: options.maxArchiveBytes,
    });
  }

  private async flushLiveSession(summary: SessionSummary): Promise<ExportSessionDirectorySummary> {
    const workspace = await this.workspaces.get(summary.workspaceId);
    const sessionDir = this.bootstrap.sessionDir(summary.workspaceId, summary.id);
    let exportSummary: ExportSessionDirectorySummary = {
      id: summary.id,
      title: summary.title,
      workspaceDir: workspace?.root,
      sessionDir,
    };
    const handle = this.lifecycle.get(summary.id);
    if (handle === undefined) {
      return exportSummary;
    }

    try {
      const metadata = handle.accessor.get(ISessionMetadata);
      await metadata.ready;
      const meta = await metadata.read();
      exportSummary = {
        id: meta.id,
        title: meta.title,
        workspaceDir: workspace?.root,
        sessionDir,
      };
    } catch (error) {
      this.log.warn('flushMetadata failed before export', { error });
    }

    await this.warnIfFails('export session log flush failed', () =>
      handle.accessor.get(ILogService).flush(),
    );
    const agents = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      await this.warnIfFails('export agent wire flush failed', () =>
        agent.accessor.get(IWireService).flush(),
      );
    }

    return exportSummary;
  }

  private async warnIfFails(
    message: string,
    operation: () => Promise<void>,
    options: { readonly retry?: boolean } = {},
  ): Promise<void> {
    try {
      await operation();
      return;
    } catch (error) {
      this.log.warn(message, { error });
    }
    if (options.retry !== true) return;
    try {
      await operation();
    } catch {}
  }
}

export interface ExportSessionDirectorySummary extends ExportSessionManifestSummary {
  readonly sessionDir: string;
}

export async function exportSessionDirectory(input: {
  readonly request: ExportSessionPayload;
  readonly summary: ExportSessionDirectorySummary;
  readonly globalLogPath?: string | undefined;
  readonly webLog?: string;
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
}): Promise<ExportSessionResult> {
  input.signal?.throwIfAborted();
  const sessionDir = input.summary.sessionDir;
  const sessionLogPath = join(sessionDir, SESSION_LOG_REL);
  let sessionLogSource: ZipSource | undefined;
  let sessionLogSourceTransferred = false;
  let globalSource: ZipSource | undefined;
  let globalSourceTransferred = false;

  try {
    sessionLogSource = await openOptionalZipSource(sessionLogPath, input.signal);
    if (input.request.includeGlobalLog === true && input.globalLogPath !== undefined) {
      globalSource = await openOptionalZipSource(input.globalLogPath, input.signal);
    }
    const sessionFiles = await collectFilesRecursive(sessionDir);
    if (sessionFiles.length === 0 && sessionLogSource === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_EXPORT_NOT_FOUND,
        `Session "${input.summary.id}" has no exportable directory at "${sessionDir}"`,
        { details: { sessionId: input.summary.id, sessionDir } },
      );
    }

    const sessionScan = await scanSessionWire(sessionDir, input.signal);
    const stableSessionLog = sessionLogSource;
    const selectedSessionFiles: SessionZipEntry[] = sessionFiles.filter(
      (file) => file !== sessionLogPath,
    );
    if (stableSessionLog !== undefined) {
      selectedSessionFiles.push({ path: sessionLogPath, source: stableSessionLog });
      selectedSessionFiles.sort((left, right) =>
        sessionZipEntryPath(left).localeCompare(sessionZipEntryPath(right)),
      );
    }
    const bundledWebLog = input.webLog !== undefined;
    const now = new Date();
    const baseManifest = buildExportManifest({
      summary: input.summary,
      now,
      version: input.request.version,
      sessionScan,
      sessionLogPath: stableSessionLog === undefined ? undefined : SESSION_LOG_REL,
      webLogPath: bundledWebLog ? WEB_LOG_REL : undefined,
      installSource: input.request.installSource,
      shellEnv: input.request.shellEnv,
    });
    const outputPath =
      input.request.outputPath !== undefined
        ? resolve(input.request.outputPath)
        : resolve(defaultExportZipName(input.summary.id, now));
    const extras: ExtraZipEntry[] = [];
    if (input.webLog !== undefined) {
      extras.push({ data: Buffer.from(input.webLog, 'utf8'), target: WEB_LOG_REL });
    }
    if (globalSource !== undefined) {
      extras.push({ source: globalSource, target: GLOBAL_LOG_REL });
    }
    const manifest =
      globalSource === undefined
        ? baseManifest
        : { ...baseManifest, globalLogPath: GLOBAL_LOG_REL };

    const writing = writeExportZip({
      outputPath,
      manifest,
      sessionDir,
      sessionFiles: selectedSessionFiles,
      extraEntries: extras,
      signal: input.signal,
      maxArchiveBytes: input.maxArchiveBytes,
    });
    sessionLogSourceTransferred = sessionLogSource !== undefined;
    globalSourceTransferred = globalSource !== undefined;
    const entries = await writing;

    return {
      zipPath: outputPath,
      entries,
      sessionDir,
      manifest,
    };
  } finally {
    if (sessionLogSource !== undefined && !sessionLogSourceTransferred) {
      await sessionLogSource.close().catch(() => {});
    }
    if (globalSource !== undefined && !globalSourceTransferred) {
      await globalSource.close().catch(() => {});
    }
  }
}

function defaultExportZipName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
}

function sessionZipEntryPath(entry: SessionZipEntry): string {
  return typeof entry === 'string' ? entry : entry.path;
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

registerScopedService(
  LifecycleScope.App,
  ISessionExportService,
  SessionExportService,
  InstantiationType.Eager,
  'sessionExport',
);
