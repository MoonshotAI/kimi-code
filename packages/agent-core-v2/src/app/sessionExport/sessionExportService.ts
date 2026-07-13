/**
 * `sessionExport` domain (L6) — `ISessionExportService` implementation.
 *
 * Coordinates live session flushing through `sessionLifecycle`, derives session
 * paths from `bootstrap`, reads persisted summaries through `sessionIndex`, and
 * packages diagnostic files through the local zip writer. Bound at App scope.
 */

import { readFile } from 'node:fs/promises';

import { resolve } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { resolveGlobalLogPath } from '#/_base/log/logConfig';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { buildExportManifest, type ExportSessionManifestSummary } from './manifest';
import {
  type ExportSessionPayload,
  type ExportSessionResult,
  ISessionExportService,
} from './sessionExport';
import { scanSessionWire } from './wire-scan';
import {
  type ExtraZipEntry,
  collectFilesRecursive,
  writeExportZip,
} from './zip';

const SESSION_LOG_REL = 'logs/kimi-code.log';
const GLOBAL_LOG_REL = 'logs/global/kimi-code.log';

export class SessionExportService implements ISessionExportService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @IWorkspaceRegistry private readonly workspaces: IWorkspaceRegistry,
    @ILogService private readonly log: ILogService,
  ) {}

  async export(input: ExportSessionPayload): Promise<ExportSessionResult> {
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
    if (input.includeGlobalLog === true) {
      await this.warnIfFails('export global log flush failed', () => this.log.flush(), {
        retry: true,
      });
    }

    return exportSessionDirectory({
      request: input,
      summary: liveSummary,
      globalLogPath: resolveGlobalLogPath(this.bootstrap.homeDir),
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
        agent.accessor.get(IAgentWireRecordService).flush(),
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
}): Promise<ExportSessionResult> {
  const sessionDir = input.summary.sessionDir;
  const sessionFiles = await collectFilesRecursive(sessionDir);
  if (sessionFiles.length === 0) {
    throw new Error2(
      ErrorCodes.SESSION_EXPORT_NOT_FOUND,
      `Session "${input.summary.id}" has no exportable directory at "${sessionDir}"`,
      { details: { sessionId: input.summary.id, sessionDir } },
    );
  }

  const sessionScan = await scanSessionWire(sessionDir);
  const hasSessionLog = sessionFiles.some((f) =>
    f.endsWith(`/${SESSION_LOG_REL}`) || f.endsWith(`\\${SESSION_LOG_REL.replaceAll('/', '\\')}`),
  );

  const extras: ExtraZipEntry[] = [];
  let bundledGlobal = false;
  if (input.request.includeGlobalLog === true && input.globalLogPath !== undefined) {
    const data = await readOptionalFile(input.globalLogPath);
    if (data !== undefined) {
      extras.push({ data, target: GLOBAL_LOG_REL });
      bundledGlobal = true;
    }
  }

  const manifest = buildExportManifest({
    summary: input.summary,
    now: new Date(),
    version: input.request.version,
    sessionScan,
    sessionLogPath: hasSessionLog ? SESSION_LOG_REL : undefined,
    globalLogPath: bundledGlobal ? GLOBAL_LOG_REL : undefined,
    installSource: input.request.installSource,
    shellEnv: input.request.shellEnv,
  });

  const outputPath =
    input.request.outputPath !== undefined
      ? resolve(input.request.outputPath)
      : resolve(`${input.summary.id}.zip`);

  const entries = await writeExportZip({
    outputPath,
    manifest,
    sessionDir,
    sessionFiles,
    extraEntries: extras,
  });

  return {
    zipPath: outputPath,
    entries,
    sessionDir,
    manifest,
  };
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionExportService,
  SessionExportService,
  InstantiationType.Delayed,
  'sessionExport',
);
