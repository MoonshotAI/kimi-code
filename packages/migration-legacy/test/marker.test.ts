/**
 * Scenario: legacy migration marker persistence and prompt suppression.
 * Responsibilities: preserve run history and decide whether one target still needs migration.
 * Wiring: real temporary filesystem; no stubbed collaborators.
 * Run: pnpm --filter @moonshot-ai/migration-legacy test -- marker.test.ts
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMarker,
  writeMarker,
  appendMarkerRun,
  type MarkerData,
} from '../src/marker.js';
import { runMigration, shouldSuppressMigration } from '../src/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'migration-marker-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('marker', () => {
  it('readMarker returns undefined when file does not exist', async () => {
    expect(await readMarker(dir)).toBeUndefined();
  });

  it('writeMarker creates a new marker file with first_migrated_at = last_migrated_at', async () => {
    const summaryStub = { sessionsAttempted: 5 } as MarkerData['runs'][number]['summary'];
    await writeMarker(dir, {
      migratorVersion: '0.1.1',
      targetPath: '/foo',
      startedAt: '2026-05-16T10:00:00Z',
      completedAt: '2026-05-16T10:00:42Z',
      summary: summaryStub,
    });
    const data = await readMarker(dir);
    expect(data?.first_migrated_at).toBe('2026-05-16T10:00:00Z');
    expect(data?.last_migrated_at).toBe('2026-05-16T10:00:42Z');
    expect(data?.target_paths).toEqual(['/foo']);
    expect(data?.runs).toHaveLength(1);
  });

  it('appendMarkerRun appends to existing marker without losing history', async () => {
    await writeMarker(dir, {
      migratorVersion: '0.1.1',
      targetPath: '/foo',
      startedAt: '2026-05-16T10:00:00Z',
      completedAt: '2026-05-16T10:00:42Z',
      summary: {} as any,
    });
    await appendMarkerRun(dir, {
      migratorVersion: '0.2.0',
      startedAt: '2026-05-17T10:00:00Z',
      completedAt: '2026-05-17T10:00:30Z',
      summary: {} as any,
      targetPath: '/bar',
    });
    const data = await readMarker(dir);
    expect(data?.first_migrated_at).toBe('2026-05-16T10:00:00Z');
    expect(data?.last_migrated_at).toBe('2026-05-17T10:00:30Z');
    expect(data?.runs).toHaveLength(2);
    // A rerun to a different target updates target_path so the marker
    // reflects the home it most recently migrated to.
    expect(data?.target_path).toBe('/bar');
  });

  it('suppresses migration for both targets when appending a run to a legacy marker', async () => {
    const firstTarget = join(dir, 'first-target');
    const secondTarget = join(dir, 'second-target');
    await writeFile(
      join(dir, '.migrated-to-kimi-code'),
      JSON.stringify({
        version: 1,
        first_migrated_at: '2026-05-16T10:00:00Z',
        last_migrated_at: '2026-05-16T10:00:42Z',
        migrator_version: '0.1.1',
        target_path: firstTarget,
        runs: [
          {
            startedAt: '2026-05-16T10:00:00Z',
            completedAt: '2026-05-16T10:00:42Z',
            migratorVersion: '0.1.1',
            summary: {},
          },
        ],
      }),
      'utf-8',
    );
    const plan = {
      sourceHome: dir,
      hasConfig: false,
      hasMcp: false,
      hasUserHistory: false,
      oauthCredentials: [],
      workdirs: [],
      detectedPlugins: [],
      detectedMcpOauthServers: [],
      totalSessions: 0,
    };
    const scope = {
      config: false,
      mcp: false,
      userHistory: false,
      skills: false,
      sessions: false,
    };
    await runMigration({ plan, scope, source: dir, target: secondTarget });

    expect(shouldSuppressMigration({ sourceHome: dir, targetHome: firstTarget })).toBe(true);
    expect(shouldSuppressMigration({ sourceHome: dir, targetHome: secondTarget })).toBe(true);
  });

  it('readMarker returns undefined when file is corrupt', async () => {
    await writeFile(join(dir, '.migrated-to-kimi-code'), 'not-json', 'utf-8');
    expect(await readMarker(dir)).toBeUndefined();
  });

  it('readMarker returns undefined when version is kept but runs is missing', async () => {
    // A partially-written/hand-edited marker: treating it as absent avoids
    // appendMarkerRun throwing on `[...existing.runs, run]`.
    await writeFile(
      join(dir, '.migrated-to-kimi-code'),
      JSON.stringify({ version: 1, target_path: '/foo' }),
      'utf-8',
    );
    expect(await readMarker(dir)).toBeUndefined();
  });

  it('does not suppress migration when no marker exists for the target', () => {
    expect(
      shouldSuppressMigration({ sourceHome: dir, targetHome: join(dir, 'target') }),
    ).toBe(false);
  });

  it('suppresses migration when the completed marker names the same target', async () => {
    const targetHome = join(dir, 'target');
    await writeFile(
      join(dir, '.migrated-to-kimi-code'),
      JSON.stringify({ target_path: targetHome }),
      'utf-8',
    );

    expect(shouldSuppressMigration({ sourceHome: dir, targetHome })).toBe(true);
  });

  it('does not suppress migration when the completed marker names another target', async () => {
    await writeFile(
      join(dir, '.migrated-to-kimi-code'),
      JSON.stringify({ target_path: join(dir, 'first-target') }),
      'utf-8',
    );

    expect(
      shouldSuppressMigration({ sourceHome: dir, targetHome: join(dir, 'second-target') }),
    ).toBe(false);
  });

  it('suppresses migration when an old marker has no target path', async () => {
    await writeFile(join(dir, '.migrated-to-kimi-code'), '{}', 'utf-8');

    expect(
      shouldSuppressMigration({ sourceHome: dir, targetHome: join(dir, 'target') }),
    ).toBe(true);
  });

  it('suppresses migration when the completed marker is corrupt', async () => {
    await writeFile(join(dir, '.migrated-to-kimi-code'), 'not-json', 'utf-8');

    expect(
      shouldSuppressMigration({ sourceHome: dir, targetHome: join(dir, 'target') }),
    ).toBe(true);
  });

  it('suppresses migration when the target contains the skip marker', async () => {
    const targetHome = join(dir, 'target');
    await mkdir(targetHome, { recursive: true });
    await writeFile(join(targetHome, '.skip-migration-from-kimi-cli'), '', 'utf-8');

    expect(shouldSuppressMigration({ sourceHome: dir, targetHome })).toBe(true);
  });

  it('suppresses migration when Windows drive letters differ only by case', async () => {
    await writeFile(
      join(dir, '.migrated-to-kimi-code'),
      JSON.stringify({ target_path: 'C:\\Users\\Example\\.kimi-code' }),
      'utf-8',
    );

    expect(
      shouldSuppressMigration({
        sourceHome: dir,
        targetHome: 'c:\\Users\\Example\\.kimi-code',
      }),
    ).toBe(true);
  });
});
