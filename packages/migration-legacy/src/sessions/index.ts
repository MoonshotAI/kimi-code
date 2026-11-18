import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { OldKimiJsonSchema } from '../kimi-cli-schema.js';
import { ensureSessionIndexEntry } from '../session-index.js';
import { sourceKimiJson, sourceSessionsDir } from '../paths.js';
import type { SessionsSummary } from '../types.js';
import { classifyLegacySession } from './classify.js';
import { migrateOneSession } from './migrate-one.js';
import { listBucketSessions, readMergedSessionState, type LegacySessionRef } from './source.js';
import { oldMd5BucketName } from './workdir-bucket.js';

export interface SessionsStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly onSessionProgress?: (done: number, total: number) => void;
}

interface WorkdirMeta {
  readonly path: string;
  readonly kaos: string;
}

interface SessionCandidate {
  readonly source: LegacySessionRef;
  readonly workdirPath: string;
  readonly wireMtime: number;
}

const MD5_HEX_RE = /^[0-9a-f]{32}$/;

export async function migrateSessionsStep(
  input: SessionsStepInput,
): Promise<SessionsSummary> {
  const workdirs = await loadWorkdirs(input.sourceHome);
  const md5ToWorkdir = new Map<string, WorkdirMeta>();
  for (const wd of workdirs) {
    md5ToWorkdir.set(oldMd5BucketName(wd.path), { path: wd.path, kaos: wd.kaos });
  }

  let bucketsScanned = 0;
  let bucketsSkippedNonlocalKaos = 0;
  let bucketsSkippedNoWorkdirFound = 0;
  let sessionsSkippedPlaceholder = 0;
  let sessionsSkippedEmpty = 0;
  let sessionsSkippedMalformed = 0;
  const sessionsFailed: Array<{ sourcePath: string; reason: string }> = [];
  const sessionsConflicts: Array<{ sourcePath: string; targetPath: string }> = [];

  const sessionsDir = sourceSessionsDir(input.sourceHome);
  let bucketDirs: string[];
  try {
    bucketDirs = await readdir(sessionsDir);
  } catch (error) {
    if (isMissingError(error)) return emptySummary();
    return {
      ...emptySummary(),
      sessionsFailed: [
        {
          sourcePath: sessionsDir,
          reason: `Legacy sessions directory could not be read: ${formatError(error)}`,
        },
      ],
    };
  }

  const candidates: SessionCandidate[] = [];

  for (const bucketName of bucketDirs) {
    bucketsScanned++;
    const bucketPath = join(sessionsDir, bucketName);
    const workdir = resolveBucket(bucketName, md5ToWorkdir);
    if (workdir.kind === 'nonlocal-kaos') {
      bucketsSkippedNonlocalKaos++;
      continue;
    }
    if (workdir.kind === 'no-workdir-found') {
      bucketsSkippedNoWorkdirFound++;
      sessionsFailed.push({
        sourcePath: bucketPath,
        reason: unknownWorkdirReason(),
      });
      continue;
    }
    let refs: LegacySessionRef[];
    try {
      refs = await listBucketSessions(bucketPath);
    } catch (error) {
      sessionsFailed.push({
        sourcePath: bucketPath,
        reason: `Legacy session bucket could not be read: ${formatError(error)}`,
      });
      continue;
    }
    for (const ref of refs) {
      const cls = await classifyLegacySession(ref);
      if (cls === 'placeholder') {
        sessionsSkippedPlaceholder++;
        continue;
      }
      if (cls === 'empty') {
        sessionsSkippedEmpty++;
        continue;
      }
      if (cls === 'malformed') {
        sessionsFailed.push({
          sourcePath: sessionReportPath(ref, bucketPath),
          reason: unreadableSessionReason(),
        });
        continue;
      }
      const wireMtime = await readWireMtime(ref);
      candidates.push({
        source: ref,
        workdirPath: workdir.path,
        wireMtime,
      });
    }
  }

  candidates.sort((a, b) => b.wireMtime - a.wireMtime);

  let migrated = 0;
  let alreadyMigrated = 0;
  let processedCount = 0;
  for (const c of candidates) {
    const result = await migrateOneSession({
      source: c.source,
      workdirPath: c.workdirPath,
      targetHome: input.targetHome,
    });
    processedCount += 1;
    input.onSessionProgress?.(processedCount, candidates.length);
    if (result.outcome === 'migrated') {
      try {
        await ensureSessionIndexEntry(input.targetHome, {
          sessionId: `ses_${c.source.uuid}`,
          sessionDir: result.targetDir,
          workDir: c.workdirPath,
        });
        migrated++;
      } catch (error) {
        sessionsFailed.push({
          sourcePath: sessionReportPath(c.source, ''),
          reason: `session migrated but index append failed: ${String(error)}`,
        });
      }
    } else if (result.outcome === 'already-migrated') {
      try {
        await ensureSessionIndexEntry(input.targetHome, {
          sessionId: `ses_${c.source.uuid}`,
          sessionDir: result.targetDir,
          workDir: c.workdirPath,
        });
        alreadyMigrated++;
      } catch (error) {
        sessionsFailed.push({
          sourcePath: sessionReportPath(c.source, ''),
          reason: `session already migrated but index entry could not be ensured: ${String(error)}`,
        });
      }
    } else if (result.outcome === 'conflict') {
      sessionsConflicts.push({
        sourcePath: sessionReportPath(c.source, ''),
        targetPath: result.targetDir,
      });
    } else if (result.outcome === 'empty') {
      sessionsSkippedEmpty++;
    } else {
      sessionsFailed.push({
        sourcePath: sessionReportPath(c.source, ''),
        reason: result.reason,
      });
    }
  }

  return {
    scope: 'all',
    bucketsScanned,
    bucketsSkippedNonlocalKaos,
    bucketsSkippedNoWorkdirFound,
    sessionsAttempted: candidates.length,
    sessionsMigrated: migrated,
    sessionsAlreadyMigrated: alreadyMigrated,
    sessionsSkippedPlaceholder,
    sessionsSkippedEmpty,
    sessionsSkippedMalformed,
    sessionsFailed,
    sessionsConflicts,
  };
}

type BucketResolution =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'nonlocal-kaos' }
  | { readonly kind: 'no-workdir-found' };

function resolveBucket(
  bucketName: string,
  md5ToWorkdir: ReadonlyMap<string, WorkdirMeta>,
): BucketResolution {
  if (MD5_HEX_RE.test(bucketName)) {
    const meta = md5ToWorkdir.get(bucketName);
    if (meta === undefined) {
      return { kind: 'no-workdir-found' };
    }
    if (meta.kaos !== 'local') {
      return { kind: 'nonlocal-kaos' };
    }
    return { kind: 'local', path: meta.path };
  }
  const idx = bucketName.lastIndexOf('_');
  if (idx > 0 && MD5_HEX_RE.test(bucketName.slice(idx + 1))) {
    return { kind: 'nonlocal-kaos' };
  }
  return { kind: 'no-workdir-found' };
}

async function loadWorkdirs(sourceHome: string): Promise<WorkdirMeta[]> {
  try {
    const text = await readFile(sourceKimiJson(sourceHome), 'utf-8');
    const parsed = OldKimiJsonSchema.parse(JSON.parse(text));
    return parsed.work_dirs.map((w) => ({ path: w.path, kaos: w.kaos }));
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
    } catch {}
  }
  if (ref.contextPath !== undefined) {
    try {
      return (await stat(ref.contextPath)).mtimeMs;
    } catch {}
  }
  return 0;
}

function sessionReportPath(ref: LegacySessionRef, fallback: string): string {
  return ref.sessionDir ?? ref.flatContextFile ?? join(fallback, ref.uuid);
}

function emptySummary(): SessionsSummary {
  return {
    scope: 'all',
    bucketsScanned: 0,
    bucketsSkippedNonlocalKaos: 0,
    bucketsSkippedNoWorkdirFound: 0,
    sessionsAttempted: 0,
    sessionsMigrated: 0,
    sessionsAlreadyMigrated: 0,
    sessionsSkippedPlaceholder: 0,
    sessionsSkippedEmpty: 0,
    sessionsSkippedMalformed: 0,
    sessionsFailed: [],
    sessionsConflicts: [],
  };
}

function unknownWorkdirReason(): string {
  return 'No local workdir mapping was found for this legacy session bucket; kimi.json may be missing, unreadable, or not list the workdir.';
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
