import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport } from '../src/report.js';
import type { MigrationReport } from '../src/types.js';

let tgt: string;
beforeEach(async () => {
  tgt = await mkdtemp(join(tmpdir(), 'rpt-'));
});
afterEach(async () => {
  await rm(tgt, { recursive: true, force: true });
});

describe('writeReport', () => {
  it('serializes the report at <target>/migration-report.json', async () => {
    const report: MigrationReport = {
      startedAt: 's',
      completedAt: 'e',
      migratorVersion: '0.1.1',
      source: '/x',
      target: tgt,
      summary: {
        config: {
          migrated: false,
          tuiExtracted: false,
          droppedProviders: [],
          droppedModels: [],
          droppedKeys: [],
          configConflicts: [],
          wroteSiblingDueToConflict: false,
          wroteTuiSibling: false,
          migratedHooks: 0,
          droppedHooks: 0,
          siblingContents: { providers: [], models: [], hooks: 0 },
        },
        mcp: { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false },
        userHistory: { copied: 0, skippedExisting: 0 },
        skills: { copied: 0, skippedExisting: 0 },
        sessions: {
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
        },
      },
      notices: {
        mcpOauthServersRequiringReauth: [],
        oauthLoginsRequiringRelogin: [],
        detectedPlugins: [],
        configConflictNotice: null,
        tuiConflictNotice: null,
      },
    };
    await writeReport(tgt, report);
    const text = await readFile(join(tgt, 'migration-report.json'), 'utf-8');
    const parsed: unknown = JSON.parse(text);
    expect((parsed as { migratorVersion: string }).migratorVersion).toBe('0.1.1');
  });
});
