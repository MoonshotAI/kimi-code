import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { migratedMarker, skipMarker } from './paths.js';

export interface MarkerRun {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly migratorVersion: string;
  readonly summary: Record<string, unknown>;
}

export interface MarkerData {
  readonly version: 1;
  readonly first_migrated_at: string;
  readonly last_migrated_at: string;
  readonly migrator_version: string;
  readonly target_path: string;
  /** All target homes covered by this marker. Absent in legacy markers. */
  readonly target_paths?: readonly string[];
  readonly runs: readonly MarkerRun[];
}

export interface MigrationSuppressionInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

/**
 * Decide whether a migration prompt should be suppressed for one target home.
 *
 * A completed marker covers every target recorded in `target_paths`; the
 * legacy `target_path` field remains authoritative when that list is absent.
 * Unreadable markers are treated conservatively as completed so upgrading does
 * not start prompting users who had already dismissed the migration.
 */
export function shouldSuppressMigration(input: MigrationSuppressionInput): boolean {
  if (existsSync(skipMarker(input.targetHome))) return true;

  const markerPath = migratedMarker(input.sourceHome);
  if (!existsSync(markerPath)) return false;

  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      readonly target_path?: unknown;
      readonly target_paths?: unknown;
    };
    const targetPaths = markerTargetPaths(parsed);
    if (targetPaths.length === 0) return true;
    return targetPaths.some((targetPath) => sameTargetPath(targetPath, input.targetHome));
  } catch {
    return true;
  }
}

export async function readMarker(sourceHome: string): Promise<MarkerData | undefined> {
  try {
    const text = await readFile(migratedMarker(sourceHome), 'utf-8');
    const parsed = JSON.parse(text) as Partial<MarkerData>;
    if (parsed.version !== 1) return undefined;
    // A partially-written or hand-edited marker may keep `version` but lack a
    // valid `runs` array; treating it as absent avoids `appendMarkerRun`
    // throwing on `[...existing.runs, run]` and aborting a healthy rerun.
    if (!Array.isArray(parsed.runs)) return undefined;
    return parsed as MarkerData;
  } catch {
    return undefined;
  }
}

export async function writeMarker(
  sourceHome: string,
  run: MarkerRun & { readonly targetPath: string },
): Promise<void> {
  const data: MarkerData = {
    version: 1,
    first_migrated_at: run.startedAt,
    last_migrated_at: run.completedAt,
    migrator_version: run.migratorVersion,
    target_path: run.targetPath,
    target_paths: [run.targetPath],
    runs: [
      {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        migratorVersion: run.migratorVersion,
        summary: run.summary,
      },
    ],
  };
  await writeFile(migratedMarker(sourceHome), JSON.stringify(data, null, 2), 'utf-8');
}

export async function appendMarkerRun(
  sourceHome: string,
  run: MarkerRun & { readonly targetPath: string },
): Promise<void> {
  const existing = await readMarker(sourceHome);
  if (existing === undefined) throw new Error('appendMarkerRun: no existing marker');
  const updated: MarkerData = {
    ...existing,
    last_migrated_at: run.completedAt,
    migrator_version: run.migratorVersion,
    // Record the latest run's target so a rerun to a different KIMI_CODE_HOME
    // updates the marker — otherwise `detectPendingMigration` keeps prompting
    // for the new target even though it was just migrated.
    target_path: run.targetPath,
    target_paths: appendTargetPath(markerTargetPaths(existing), run.targetPath),
    runs: [
      ...existing.runs,
      {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        migratorVersion: run.migratorVersion,
        summary: run.summary,
      },
    ],
  };
  await writeFile(migratedMarker(sourceHome), JSON.stringify(updated, null, 2), 'utf-8');
}

function markerTargetPaths(marker: {
  readonly target_path?: unknown;
  readonly target_paths?: unknown;
}): string[] {
  const targetPaths = Array.isArray(marker.target_paths)
    ? marker.target_paths.filter((targetPath): targetPath is string => typeof targetPath === 'string')
    : [];
  if (typeof marker.target_path === 'string') {
    return appendTargetPath(targetPaths, marker.target_path);
  }
  return targetPaths;
}

function appendTargetPath(targetPaths: readonly string[], targetPath: string): string[] {
  if (targetPaths.some((existing) => sameTargetPath(existing, targetPath))) {
    return [...targetPaths];
  }
  return [...targetPaths, targetPath];
}

function sameTargetPath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }

  const leftIsWindowsAbsolute = win32.isAbsolute(left);
  const rightIsWindowsAbsolute = win32.isAbsolute(right);
  if (leftIsWindowsAbsolute || rightIsWindowsAbsolute) {
    if (!leftIsWindowsAbsolute || !rightIsWindowsAbsolute) return false;
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }

  return resolve(left) === resolve(right);
}
