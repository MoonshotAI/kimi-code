import { readFile } from 'node:fs/promises';
import { resolve } from 'pathe';

import { ErrorCodes, KimiError } from '#/errors';
import { resolveGlobalLogPath } from '#/logging/logger';
import { buildExportManifest } from '#/session/export/manifest';
import { scanSessionWire } from '#/session/export/wire-scan';
import {
  type ExtraZipEntry,
  collectFilesRecursive,
  writeExportZip,
} from '#/session/export/zip';
import type { ExportSessionPayload, ExportSessionResult, SessionSummary } from '#/rpc/core-api';

const SESSION_LOG_REL = 'logs/kimi-code.log';
const GLOBAL_LOG_REL = 'logs/global/kimi-code.log';

export async function exportSessionDirectory(input: {
  readonly request: ExportSessionPayload;
  readonly summary: SessionSummary;
  readonly homeDir?: string | undefined;
  readonly globalLogPath?: string | undefined;
}): Promise<ExportSessionResult> {
  const sessionDir = input.summary.sessionDir;
  const sessionFiles = await collectFilesRecursive(sessionDir);
  if (sessionFiles.length === 0) {
    throw new KimiError(ErrorCodes.SESSION_EXPORT_NOT_FOUND, `Session "${input.summary.id}" has no exportable directory at "${sessionDir}"`, {
      details: { sessionId: input.summary.id, sessionDir },
    });
  }

  const sessionScan = await scanSessionWire(sessionDir);
  const hasSessionLog = sessionFiles.some((f) =>
    f.endsWith(`/${SESSION_LOG_REL}`) || f.endsWith(`\\${SESSION_LOG_REL.replaceAll('/', '\\')}`),
  );

  const extras: ExtraZipEntry[] = [];
  let bundledGlobal = false;
  const globalPath =
    input.globalLogPath ??
    (input.homeDir === undefined ? undefined : resolveGlobalLogPath(input.homeDir));
  if (input.request.includeGlobalLog === true && globalPath !== undefined) {
    const data = await readOptionalFile(globalPath);
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
