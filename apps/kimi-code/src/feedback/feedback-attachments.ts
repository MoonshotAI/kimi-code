import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { detectInstallSource } from '#/cli/update/source';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { FeedbackAttachmentLevel } from '#/tui/commands/prompts';
import { getLogDir } from '#/utils/paths';
import { detectShellEnvironment } from '#/utils/process/shell-env';

import { createFeedbackArchivePath, type FeedbackArchive } from './archive';
import { packageCodebase, scanCodebase, type FeedbackCodebaseScanResult } from './codebase';
import { uploadArchive, type FeedbackUploadUrlApi } from './upload';

export const CODEBASE_ARCHIVE_FILENAME = 'repo.zip';
export const SESSION_ARCHIVE_FILENAME = 'session.zip';

const CODEBASE_SCAN_TIMEOUT_MS = 3000;

/**
 * Stage 3 of the `/feedback` flow: prepare and upload each requested attachment
 * independently. Attachment failures are non-fatal because the text feedback
 * already exists, but any requested artifact that cannot be prepared/uploaded
 * is reported as a partial attachment failure instead of silently downgrading
 * the request.
 *
 * Returns `true` when at least one requested attachment failed so the caller
 * can surface a partial-failure status.
 */
export async function submitFeedbackWithAttachments(
  host: SlashCommandHost,
  feedbackId: number,
  level: FeedbackAttachmentLevel,
): Promise<boolean> {
  const api = createFeedbackUploadApi(host);

  if (level === 'logs') {
    const uploaded = await prepareAndUploadSessionArchive(host, api, feedbackId);
    return !uploaded;
  }
  if (level === 'logs+codebase') {
    const [sessionDir, scan] = await Promise.all([
      resolveCurrentSessionDir(host),
      scanCodebaseForFeedback(host.state.appState.workDir),
    ]);
    const [uploadedSession, uploadedCodebase] = await Promise.all([
      prepareAndUploadSessionArchive(host, api, feedbackId, sessionDir),
      prepareAndUploadCodebaseArchive(api, feedbackId, scan),
    ]);
    return !uploadedSession || !uploadedCodebase;
  }
  return false;
}

async function prepareAndUploadSessionArchive(
  host: SlashCommandHost,
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  knownSessionDir?: string,
): Promise<boolean> {
  const sessionDir = knownSessionDir ?? (await resolveCurrentSessionDir(host));
  if (sessionDir === undefined) {
    await logFeedbackUploadError(new Error('cannot locate the current session directory'));
    return false;
  }
  return uploadProducedArchive(api, feedbackId, SESSION_ARCHIVE_FILENAME, async (archivePath) => {
    const exported = await host.harness.exportSession({
      id: host.state.appState.sessionId,
      outputPath: archivePath,
      includeGlobalLog: true,
      version: host.state.appState.version,
      installSource: await detectInstallSource(),
      shellEnv: detectShellEnvironment(),
    });
    return archiveFromExportedSession(exported.zipPath);
  });
}

async function prepareAndUploadCodebaseArchive(
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  scan: FeedbackCodebaseScanResult | undefined,
): Promise<boolean> {
  if (scan === undefined) return false;
  return uploadProducedArchive(api, feedbackId, CODEBASE_ARCHIVE_FILENAME, (archivePath) =>
    packageCodebase(scan, archivePath),
  );
}

/**
 * Shared lifecycle for a single attachment: create a temp archive path, let
 * `produce` write the archive to it, upload it, then always remove the temp
 * directory — even when `produce` or the upload throws. Both the session log
 * archive and the codebase archive flow through here so their cleanup and
 * error handling cannot drift apart.
 */
async function uploadProducedArchive(
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  filename: string,
  produce: (archivePath: string) => Promise<FeedbackArchive>,
): Promise<boolean> {
  const { archivePath, cleanupDir } = await createFeedbackArchivePath(filename);
  try {
    const archive = await produce(archivePath);
    await uploadArchive(api, { ...archive, cleanupDir }, feedbackId, { filename });
    return true;
  } catch (error) {
    await logFeedbackUploadError(error);
    return false;
  } finally {
    await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function archiveFromExportedSession(zipPath: string): Promise<FeedbackArchive> {
  const data = await readFile(zipPath);
  const archiveStat = await stat(zipPath);
  return {
    path: zipPath,
    size: archiveStat.size,
    sha256: createHash('sha256').update(data).digest('hex'),
    fingerprint: createHash('sha256').update(data).digest('hex'),
    fileCount: 1,
  };
}

async function resolveCurrentSessionDir(host: SlashCommandHost): Promise<string | undefined> {
  try {
    const sessions = await host.harness.listSessions({ workDir: host.state.appState.workDir });
    return sessions.find((session) => session.id === host.state.appState.sessionId)?.sessionDir;
  } catch {
    return undefined;
  }
}

async function scanCodebaseForFeedback(
  workDir: string,
): Promise<FeedbackCodebaseScanResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CODEBASE_SCAN_TIMEOUT_MS);
  try {
    return await scanCodebase(workDir, { signal: controller.signal });
  } catch (error) {
    await logFeedbackUploadError(error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function logFeedbackUploadError(error: unknown): Promise<void> {
  try {
    const logDir = getLogDir();
    await mkdir(logDir, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await appendFile(join(logDir, 'feedback-upload.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best-effort logging only
  }
}

function createFeedbackUploadApi(host: SlashCommandHost): FeedbackUploadUrlApi {
  return {
    async createUploadUrl(input) {
      const res = await host.harness.auth.createFeedbackUploadUrl(input);
      if (res.kind !== 'ok') throw new Error(res.message);
      return {
        uploadId: res.uploadId,
        parts: res.parts,
      };
    },
    async completeUpload(input) {
      const res = await host.harness.auth.completeFeedbackUpload({
        uploadId: input.uploadId,
        parts: input.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      });
      if (res.kind !== 'ok') throw new Error(res.message);
    },
  };
}
