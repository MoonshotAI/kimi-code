import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { OldKimiJsonSchema } from './kimi-cli-schema.js';
import { readSourceConfig } from './source-config.js';
import { defaultPlansSourceDir } from './steps/plans.js';
import {
  sourceMcpJson,
  sourceCredentialsDir,
  sourceUserHistoryDir,
  sourcePluginsDir,
  sourceSessionsDir,
  sourceKimiJson,
  sourceSkillsDir,
} from './paths.js';
import type {
  MigrationPlan,
  SessionEntry,
  SessionMigrationFailure,
  WorkDirEntry,
} from './types.js';
import { classifyLegacySession } from './sessions/classify.js';
import {
  listBucketSessions,
  readMergedSessionState,
  type LegacySessionRef,
} from './sessions/source.js';
import { oldMd5BucketName } from './sessions/workdir-bucket.js';

const MD5_HEX_RE = /^[0-9a-f]{32}$/;

interface WorkdirMeta {
  readonly path: string;
  readonly kaos: string;
}

export async function detectMigration(opts: { sourcePath: string; skillsSourcePath?: string; plansSourcePath?: string }): Promise<MigrationPlan> {
  const src = opts.sourcePath;

  const sourceConfig = await readSourceConfig(src);
  const hasConfig = sourceConfig.kind !== 'missing';
  const hasMcp = existsSync(sourceMcpJson(src));
  const hasUserHistory = existsSync(sourceUserHistoryDir(src));
  const hasSkills = await dirHasEntries(opts.skillsSourcePath ?? sourceSkillsDir(src));
  const hasPlans = await dirHasEntries(opts.plansSourcePath ?? defaultPlansSourceDir());

  const credentialFiles = await listDirSafe(sourceCredentialsDir(src), (n) =>
    n.endsWith('.json'),
  );
  const oauthCredentials = new Set<string>(
    credentialFiles.map((n) => n.slice(0, -'.json'.length)).filter((n) => n.length > 0),
  );
  if (sourceConfig.kind === 'toml' || sourceConfig.kind === 'json') {
    const providers = sourceConfig.parsed['providers'];
    if (isRecord(providers)) {
      for (const prov of Object.values(providers)) {
        if (!isRecord(prov)) continue;
        const oauth = prov['oauth'];
        if (!isRecord(oauth)) continue;
        const key = oauth['key'];
        if (typeof key !== 'string' || key === '') continue;
        const name = key.split('/').pop();
        if (name !== undefined && name !== '') oauthCredentials.add(name);
      }
    }
  }

  const detectedPlugins = await listDirSafe(sourcePluginsDir(src), () => true);
  const detectedMcpOauthServers = await detectMcpOauthServers(src);

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

      let refs;
      try {
        refs = await listBucketSessions(bucketPath);
      } catch (error) {
        sessionScanFailures.push({
          sourcePath: bucketPath,
          reason: `Legacy session bucket could not be read: ${formatError(error)}`,
        });
        continue;
      }

      const sessions: SessionEntry[] = [];
      for (const ref of refs) {
        const cls = await classifyLegacySession(ref);
        if (cls === 'malformed') {
          sessionScanFailures.push({
            sourcePath: ref.sessionDir ?? ref.flatContextFile ?? join(bucketPath, ref.uuid),
            reason: unreadableSessionReason(),
          });
          continue;
        }
        if (cls !== 'real') continue;
        const wireMtime = await readWireMtime(ref);
        sessions.push({
          uuid: ref.uuid,
          oldDir: ref.sessionDir ?? ref.flatContextFile ?? join(bucketPath, ref.uuid),
          wireMtime,
        });
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
    hasSkills,
    hasPlans,
    skillsSourceHome: opts.skillsSourcePath,
    oauthCredentials: [...oauthCredentials],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function detectMcpOauthServers(src: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(sourceMcpJson(src), 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return [];
    const servers = parsed['mcpServers'];
    if (!isRecord(servers)) return [];
    const out: string[] = [];
    for (const [name, server] of Object.entries(servers)) {
      if (isRecord(server) && server['auth'] === 'oauth') out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

function unreadableSessionReason(): string {
  return 'Legacy session could not be inspected because its context is missing or unreadable.';
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

async function readWireMtime(ref: LegacySessionRef): Promise<number> {
  const state = await readMergedSessionState(ref.sessionDir);
  if (state.wire_mtime !== null && state.wire_mtime !== undefined) {
    return state.wire_mtime * 1000;
  }
  if (ref.sessionDir !== undefined) {
    try {
      return (await stat(join(ref.sessionDir, 'wire.jsonl'))).mtimeMs;
    } catch {
      // fall through to the context payload's mtime
    }
  }
  if (ref.contextPath !== undefined) {
    try {
      return (await stat(ref.contextPath)).mtimeMs;
    } catch {
      // fall through
    }
  }
  return 0;
}
