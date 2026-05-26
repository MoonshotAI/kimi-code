import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPendingMigration } from '#/migration/detect-pending';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'detect-pending-src-'));
  tgt = await mkdtemp(join(tmpdir(), 'detect-pending-tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('detectPendingMigration', () => {
  it('returns null when source dir does not exist', async () => {
    const plan = await detectPendingMigration({ sourceHome: join(src, 'nope'), targetHome: tgt });
    expect(plan).toBeNull();
  });

  it('returns null when the migrated marker exists', async () => {
    await writeFile(join(src, '.migrated-to-kimi-code'), '{}', 'utf-8');
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).toBeNull();
  });

  it('returns null when the skip marker exists in target', async () => {
    await writeFile(join(src, 'config.toml'), '', 'utf-8');
    await writeFile(join(tgt, '.skip-migration-from-kimi-cli'), '', 'utf-8');
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).toBeNull();
  });

  it('returns null when source has nothing worth migrating', async () => {
    // empty source dir, no config/mcp/credentials/sessions
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).toBeNull();
  });

  it('returns null when the only source data is OAuth credentials', async () => {
    // OAuth credentials are deliberately never migrated. An install whose
    // only legacy data is `credentials/*.json` therefore has nothing to
    // offer the migration screen — kimi-code's own /login flow handles
    // re-auth on first use.
    await mkdir(join(src, 'credentials'), { recursive: true });
    await writeFile(
      join(src, 'credentials', 'kimi-code.json'),
      JSON.stringify({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: 1,
        scope: 's',
        token_type: 'Bearer',
      }),
      'utf-8',
    );
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).toBeNull();
  });

  it('returns a MigrationPlan when source has migratable data', async () => {
    await writeFile(join(src, 'config.toml'), 'default_thinking = true\n', 'utf-8');
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).not.toBeNull();
    expect(plan?.hasConfig).toBe(true);
  });

  it('returns a MigrationPlan when source has only user-history', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    await writeFile(join(src, 'user-history', 'shell.txt'), 'ls\n', 'utf-8');
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).not.toBeNull();
    expect(plan?.hasUserHistory).toBe(true);
  });

  it('does not suppress when the marker targeted a different home', async () => {
    await writeFile(join(src, 'config.toml'), 'default_thinking = true\n', 'utf-8');
    await writeFile(
      join(src, '.migrated-to-kimi-code'),
      JSON.stringify({ version: 1, target_path: '/some/other/home' }),
      'utf-8',
    );
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).not.toBeNull(); // this target was never migrated → still offer
  });

  it('suppresses when the marker targeted this home', async () => {
    await writeFile(join(src, 'config.toml'), 'default_thinking = true\n', 'utf-8');
    await writeFile(
      join(src, '.migrated-to-kimi-code'),
      JSON.stringify({ version: 1, target_path: tgt }),
      'utf-8',
    );
    const plan = await detectPendingMigration({ sourceHome: src, targetHome: tgt });
    expect(plan).toBeNull();
  });
});
