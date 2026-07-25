import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { OldKimiJsonSchema, OldSessionStateSchema } from './kimi-cli-schema.js';
import {
  sourceConfigToml,
  sourceMcpJson,
  sourceCredentialsDir,
  sourceUserHistoryDir,
  sourcePluginsDir,
  sourceMcpOauthDir,
  sourceSessionsDir,
  sourceKimiJson,
} from './paths.js';
import type {
  MigrationPlan,
  SessionEntry,
  SessionMigrationFailure,
  WorkDirEntry,
} from './types.js';
import { classifySessionDir } from './sessions/classify.js';
import { oldMd5BucketName } from './sessions/workdir-bucket.js';

const MD5_HEX_RE = /^[0-9a-f]{32}$/;

interface WorkdirMeta {
  readonly path: string;
  readonly kaos: string;
}

export async function detectMigration(opts: { sourcePath: string }): Promise<MigrationPlan> {
  const src = opts.sourcePath;

  const hasConfig = existsSync(sourceConfigToml(src));
  const hasMcp = existsSync(sourceMcpJson(src));
  const hasUserHistory = existsSync(sourceUserHistoryDir(src));

  const oauthCredentials = await listDirSafe(sourceCredentialsDir(src), (n) =>
    n.endsWith('.json'),
  );
  const detectedPlugins = await listDirSafe(sourcePluginsDir(src), () => true);
  const detectedMcpOauthServers = await listDirSafe(sourceMcpOauthDir(src), () => true);

  // Reverse-lookup workdir from kimi.json
  const workdirMap = new Map<string, WorkdirMeta>();
  try {
    const text = await readFile(sourceKimiJson(src), 'utf-8');
    const parsed = OldKimiJsonSchema.parse(JSON.parse(text));
    for (const wd of parsed.work_dirs) {
      workdirMap.set(oldMd5BucketName(wd.path), { path: wd.path, kaos: wd.kaos });
    }
  } catch {
    // no kimi.json or unparseable — sessions list will be empty
  }

  const workdirs: WorkDirEntry[] = [];
  let totalSessions = 0;
  const sessionScanFailures: SessionMigrationFailure[] = [];

  const sessionsRoot = sourceSessionsDir(src);
  try {
    const bucketNames = await readdir(sessionsRoot);
    for (const bucketName of bucketNames) {
      const bucketPath = join(sessionsRoot, bucketName);
      // Skip non-local-kaos buckets (`<kaos>_<md5>`), which cannot be
      // represented by the local Kimi Code runtime. Every other unknown
      // bucket is user data we failed to map and must remain visible.
      if (!MD5_HEX_RE.test(bucketName)) {
        const separator = bucketName.lastIndexOf('_');
        if (separator > 0 && MD5_HEX_RE.test(bucketName.slice(separator + 1))) continue;
        sessionScanFailures.push({
          sourcePath: bucketPath,
          reason: unknownWorkdirReason(),
        });
        continue;
      }
      const wd = workdirMap.get(bucketName);
      if (wd === undefined) {
        sessionScanFailures.push({
          sourcePath: bucketPath,
          reason: unknownWorkdirReason(),
        });
        continue;
      }
      if (wd.kaos !== 'local') continue;

      let uuids: string[];
      try {
        uuids = await readdir(bucketPath);
      } catch (error) {
        sessionScanFailures.push({
          sourcePath: bucketPath,
          reason: `Legacy session bucket could not be read: ${formatError(error)}`,
        });
        continue;
      }

      const sessions: SessionEntry[] = [];
      for (const uuid of uuids) {
        const sessionDir = join(bucketPath, uuid);
        const cls = await classifySessionDir(sessionDir);
        if (cls === 'malformed') {
          sessionScanFailures.push({
            sourcePath: sessionDir,
            reason: unreadableSessionReason(),
          });
          continue;
        }
        if (cls !== 'real') continue;
        const wireMtime = await readWireMtime(sessionDir);
        sessions.push({ uuid, oldDir: sessionDir, wireMtime });
        totalSessions++;
      }

      if (sessions.length > 0) {
        workdirs.push({ oldHashDir: bucketPath, workdirPath: wd.path, sessions });
      }
    }
  } catch (error) {
    if (!isMissingError(error)) {
      sessionScanFailures.push({
        sourcePath: sessionsRoot,
        reason: `Legacy sessions directory could not be read: ${formatError(error)}`,
      });
    }
  }

  return {
    sourceHome: src,
    hasConfig,
    hasMcp,
    hasUserHistory,
    oauthCredentials,
    workdirs,
    detectedPlugins,
    detectedMcpOauthServers,
    totalSessions,
    sessionScanFailures,
  };
}

function unknownWorkdirReason(): string {
  return 'No local workdir mapping was found for this legacy session bucket; kimi.json may be missing, unreadable, or not list the workdir.';
}

function unreadableSessionReason(): string {
  return 'Legacy session could not be inspected because context.jsonl is missing or unreadable.';
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listDirSafe(
  dir: string,
  filter: (name: string) => boolean,
): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter(filter);
  } catch {
    return [];
  }
}

async function readWireMtime(sessionDir: string): Promise<number> {
  try {
    const text = await readFile(join(sessionDir, 'state.json'), 'utf-8');
    const parsed = OldSessionStateSchema.parse(JSON.parse(text));
    if (parsed.wire_mtime !== null && parsed.wire_mtime !== undefined) {
      return parsed.wire_mtime * 1000;
    }
  } catch {
    // fall through to wire.jsonl mtime
  }
  try {
    const st = await stat(join(sessionDir, 'wire.jsonl'));
    return st.mtimeMs;
  } catch {
    return 0;
  }
}
