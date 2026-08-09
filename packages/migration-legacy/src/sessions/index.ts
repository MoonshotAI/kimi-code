import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { OldKimiJsonSchema, OldSessionStateSchema } from '../kimi-cli-schema.js';
import { ensureSessionIndexEntry } from '../session-index.js';
import { sourceKimiJson, sourceSessionsDir } from '../paths.js';
import type { SessionsSummary } from '../types.js';
import { classifySessionDir } from './classify.js';
import { migrateOneSession } from './migrate-one.js';
import { oldMd5BucketName } from './workdir-bucket.js';

export interface SessionsStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  /** Invoked after each session is processed, with the running count and total. */
  readonly onSessionProgress?: (done: number, total: number) => void;
}

interface WorkdirMeta {
  readonly path: string;
  readonly kaos: string;
}

interface SessionCandidate {
  readonly sourceSessionDir: string;
  readonly oldSessionUuid: string;
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
    // workdir.kind === 'local'
    let sessionUuids: string[];
    try {
      sessionUuids = await readdir(bucketPath);
    } catch (error) {
      sessionsFailed.push({
        sourcePath: bucketPath,
        reason: `Legacy session bucket could not be read: ${formatError(error)}`,
      });
      continue;
    }
    for (const uuid of sessionUuids) {
      const sessionDir = join(bucketPath, uuid);
      const cls = await classifySessionDir(sessionDir);
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
          sourcePath: sessionDir,
          reason: unreadableSessionReason(),
        });
        continue;
      }
      const wireMtime = await readWireMtime(sessionDir);
      candidates.push({
        sourceSessionDir: sessionDir,
        oldSessionUuid: uuid,
        workdirPath: workdir.path,
        wireMtime,
      });
    }
  }

  // Stable, deterministic order so progress events emit "newest first" — the
  // user sees their most recent work move across the counter first.
  candidates.sort((a, b) => b.wireMtime - a.wireMtime);

  let migrated = 0;
  let alreadyMigrated = 0;
  let processedCount = 0;
  for (const c of candidates) {
    const result = await migrateOneSession({
      sourceSessionDir: c.sourceSessionDir,
      oldSessionUuid: c.oldSessionUuid,
      workdirPath: c.workdirPath,
      targetHome: input.targetHome,
    });
    processedCount += 1;
    input.onSessionProgress?.(processedCount, candidates.length);
    if (result.outcome === 'migrated') {
      try {
        // `ensureSessionIndexEntry` is idempotent — if a stale index line for
        // this session survived a deleted target dir, re-migrating it must not
        // append a second line for the same id.
        await ensureSessionIndexEntry(input.targetHome, {
          sessionId: `ses_${c.oldSessionUuid}`,
          sessionDir: result.targetDir,
          workDir: c.workdirPath,
        });
        migrated++;
      } catch (error) {
        // The session dir is written, but resume-by-id needs the index entry —
        // without it the session is unopenable. Record it as failed so the run
        // summary is honest; one bad index write must not abort the batch.
        sessionsFailed.push({
          sourcePath: c.sourceSessionDir,
          reason: `session migrated but index append failed: ${String(error)}`,
        });
      }
    } else if (result.outcome === 'already-migrated') {
      // The session dir exists from a prior run, but that run may have crashed
      // before appending the index entry. `ensureSessionIndexEntry` is
      // idempotent — it adds the entry only when absent — so a rerun
      // self-heals an index that is missing this session.
      try {
        await ensureSessionIndexEntry(input.targetHome, {
          sessionId: `ses_${c.oldSessionUuid}`,
          sessionDir: result.targetDir,
          workDir: c.workdirPath,
        });
        alreadyMigrated++;
      } catch (error) {
        // The index entry is genuinely missing and could not be added — the
        // session stays unreachable by id, so record it as failed.
        sessionsFailed.push({
          sourcePath: c.sourceSessionDir,
          reason: `session already migrated but index entry could not be ensured: ${String(error)}`,
        });
      }
    } else if (result.outcome === 'conflict') {
      sessionsConflicts.push({
        sourcePath: c.sourceSessionDir,
        targetPath: result.targetDir,
      });
    } else if (result.outcome === 'empty') {
      // No migratable conversation (empty or user-cleared session). Counted
      // as skipped, not failed — `classifySessionDir` usually catches these
      // before they become candidates, but a translator/classifier edge can
      // still land one here.
      sessionsSkippedEmpty++;
    } else {
      sessionsFailed.push({
        sourcePath: c.sourceSessionDir,
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
  // Pure md5 hex (32 chars) → look up directly.
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
  // Non-local pattern: `<kaos>_<md5>`. Use the last `_` so kaos names that
  // contain underscores still resolve.
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
