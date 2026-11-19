import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CRASH_DUMPS_DIR, INCIDENTS_DIR, MAIN_LOG_FILE, MAX_ROTATED_LOGS, diagnosticRoots, log } from './log';

const DAY_MS = 86_400_000;
export const DIAGNOSTICS_RETENTION_MS = 30 * DAY_MS;
export const MAX_INCIDENT_FILES = 20;
export const MAX_CRASH_DUMPS = 10;
export const MAX_CRASH_DUMP_BYTES = 50 * 1024 * 1024;
const FIRST_PRUNE_DELAY_MS = 60_000;
const PRUNE_INTERVAL_MS = DAY_MS;
const CRASH_DUMP_SCAN_DEPTH = 3;

export interface DiagnosticFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface RetentionLimits {
  maxAgeMs: number;
  maxFiles?: number;
  maxTotalBytes?: number;
}

export function selectExpiredFiles(
  files: readonly DiagnosticFile[],
  now: number,
  limits: RetentionLimits,
): string[] {
  const expired: string[] = [];
  let keptFiles = 0;
  let keptBytes = 0;
  for (const file of [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const tooOld = now - file.mtimeMs > limits.maxAgeMs;
    const tooMany = limits.maxFiles !== undefined && keptFiles >= limits.maxFiles;
    const tooLarge =
      limits.maxTotalBytes !== undefined && keptFiles > 0 && keptBytes + file.size > limits.maxTotalBytes;
    if (tooOld || tooMany || tooLarge) {
      expired.push(file.path);
    } else {
      keptFiles += 1;
      keptBytes += file.size;
    }
  }
  return expired;
}

export function rotatedLogIndex(name: string): number | null {
  const prefix = `${MAIN_LOG_FILE}.`;
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

async function statFiles(dir: string, accept: (name: string) => boolean): Promise<DiagnosticFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.filter(accept).map(async (name): Promise<DiagnosticFile | null> => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, mtimeMs: info.mtimeMs, size: info.size } : null;
      } catch {
        return null;
      }
    }),
  );
  return files.filter((file): file is DiagnosticFile => file !== null);
}

export async function listCrashDumps(root: string, depth = CRASH_DUMP_SCAN_DEPTH): Promise<DiagnosticFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry): Promise<DiagnosticFile[]> => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return depth > 0 ? listCrashDumps(path, depth - 1) : [];
      if (!entry.isFile() || !entry.name.endsWith('.dmp')) return [];
      try {
        const info = await stat(path);
        return [{ path, mtimeMs: info.mtimeMs, size: info.size }];
      } catch {
        return [];
      }
    }),
  );
  return nested.flat();
}

export async function pruneDiagnosticFiles(
  now: number = Date.now(),
  roots: readonly string[] = diagnosticRoots(),
): Promise<number> {
  const perRoot = await Promise.all(
    [...new Set(roots)].map(async (root) => ({
      rotatedLogs: await statFiles(root, (name) => rotatedLogIndex(name) !== null),
      incidents: await statFiles(join(root, INCIDENTS_DIR), (name) => name.endsWith('.json')),
      dumps: await listCrashDumps(join(root, CRASH_DUMPS_DIR)),
    })),
  );
  const rotatedLogs = perRoot.flatMap((entry) => entry.rotatedLogs);
  const incidents = perRoot.flatMap((entry) => entry.incidents);
  const dumps = perRoot.flatMap((entry) => entry.dumps);
  const surplusLogs = rotatedLogs
    .filter((file) => (rotatedLogIndex(basename(file.path)) ?? 0) > MAX_ROTATED_LOGS)
    .map((file) => file.path);
  const removals = [
    ...new Set([
      ...surplusLogs,
      ...selectExpiredFiles(rotatedLogs, now, { maxAgeMs: DIAGNOSTICS_RETENTION_MS }),
      ...selectExpiredFiles(incidents, now, {
        maxAgeMs: DIAGNOSTICS_RETENTION_MS,
        maxFiles: MAX_INCIDENT_FILES,
      }),
      ...selectExpiredFiles(dumps, now, {
        maxAgeMs: DIAGNOSTICS_RETENTION_MS,
        maxFiles: MAX_CRASH_DUMPS,
        maxTotalBytes: MAX_CRASH_DUMP_BYTES,
      }),
    ]),
  ];
  await Promise.all(removals.map((path) => rm(path, { force: true }).catch(() => undefined)));
  if (removals.length > 0) {
    log.info(`[retention] removed ${removals.length} expired diagnostic file(s)`);
  }
  return removals.length;
}

let pruneScheduled = false;

export function scheduleDiagnosticPruning(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  const run = (): void => {
    void pruneDiagnosticFiles().catch((error: unknown) => {
      log.warn(`[retention] prune failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const first = setTimeout(() => {
    run();
    const interval = setInterval(run, PRUNE_INTERVAL_MS);
    interval.unref?.();
  }, FIRST_PRUNE_DELAY_MS);
  first.unref?.();
}
