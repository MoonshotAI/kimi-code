import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATE_HEADLESS_EXIT, runHeadlessMigrate } from '#/migration/run-headless';

let home: string;
let target: string;
let lines: string[];

const write = (line: string): void => {
  lines.push(line);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'migrate-headless-home-'));
  target = await mkdtemp(join(tmpdir(), 'migrate-headless-target-'));
  lines = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

function sourceHome(): string {
  return join(home, '.kimi');
}

async function writeLegacyConfig(): Promise<void> {
  await mkdir(sourceHome(), { recursive: true });
  await writeFile(join(sourceHome(), 'config.toml'), 'default_thinking = true\n', 'utf-8');
}

async function writeRealSession(workdir: string, uuid: string): Promise<void> {
  await mkdir(workdir, { recursive: true });
  const bucket = createHash('md5').update(workdir).digest('hex');
  const sessionDir = join(sourceHome(), 'sessions', bucket, uuid);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sourceHome(), 'kimi.json'),
    JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local', last_session_id: uuid }] }),
    'utf-8',
  );
  await writeFile(
    join(sessionDir, 'context.jsonl'),
    '{"role":"_system_prompt","content":"hi"}\n{"role":"user","content":"hello"}\n',
    'utf-8',
  );
}

describe('runHeadlessMigrate', () => {
  it('reports nothing to migrate for an empty source', async () => {
    await mkdir(sourceHome(), { recursive: true });
    const code = await runHeadlessMigrate(
      { configOnly: false },
      { env: {}, userHome: home, targetHome: target, write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.success);
    expect(lines.join('\n')).toContain('nothing to migrate');
  });

  it('refuses when source and target are the same directory', async () => {
    const code = await runHeadlessMigrate(
      { configOnly: false },
      { env: {}, userHome: home, targetHome: sourceHome(), write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.error);
    expect(lines.join('\n')).toContain('refusing to migrate');
  });

  it('migrates config and sessions, writes the report and the completion marker', async () => {
    await writeLegacyConfig();
    await writeRealSession(join(home, 'proj'), '11111111-aaaa-4bbb-8ccc-111111111111');
    const code = await runHeadlessMigrate(
      { configOnly: false },
      { env: {}, userHome: home, targetHome: target, write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.success);
    const out = lines.join('\n');
    expect(out).toContain('detected: 1 sessions');
    expect(out).toContain('step: config done');
    expect(out).toContain('sessions: translating 1/1');
    expect(out).toContain('migrated=1');
    expect(out).toContain('result: complete');
    const report = JSON.parse(await readFile(join(target, 'migration-report.json'), 'utf-8'));
    expect(report.summary.sessions.sessionsMigrated).toBe(1);
    expect(report.summary.config.migrated).toBe(true);
    const marker = JSON.parse(
      await readFile(join(sourceHome(), '.migrated-to-kimi-code'), 'utf-8'),
    );
    expect(marker.target_path).toBe(target);
  });

  it('skips sessions in config-only mode', async () => {
    await writeLegacyConfig();
    await writeRealSession(join(home, 'proj'), '11111111-aaaa-4bbb-8ccc-111111111111');
    const code = await runHeadlessMigrate(
      { configOnly: true },
      { env: {}, userHome: home, targetHome: target, write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.success);
    expect(lines.join('\n')).toContain('scope: config-only');
    const report = JSON.parse(await readFile(join(target, 'migration-report.json'), 'utf-8'));
    expect(report.summary.sessions.scope).toBe('config-only');
    expect(report.summary.sessions.sessionsMigrated).toBe(0);
    expect(report.summary.config.migrated).toBe(true);
  });

  it('exits incomplete and writes no marker when a session fails', async () => {
    await writeLegacyConfig();
    const workdir = join(home, 'proj');
    await writeRealSession(workdir, '11111111-aaaa-4bbb-8ccc-111111111111');
    const bucket = createHash('md5').update(workdir).digest('hex');
    await writeFile(
      join(sourceHome(), 'sessions', bucket, '11111111-aaaa-4bbb-8ccc-111111111111', 'context.jsonl'),
      '"broken\x00line\nnot json at all\n',
      'utf-8',
    );
    const code = await runHeadlessMigrate(
      { configOnly: false },
      { env: {}, userHome: home, targetHome: target, write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.incomplete);
    const out = lines.join('\n');
    expect(out).toContain('failed=');
    expect(out).toContain('result: incomplete');
    await expect(
      readFile(join(sourceHome(), '.migrated-to-kimi-code'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('honors KIMI_SHARE_DIR as the source and keeps skills on the default home', async () => {
    const shareDir = join(home, 'share');
    await mkdir(join(shareDir), { recursive: true });
    await writeFile(join(shareDir, 'config.toml'), 'default_thinking = true\n', 'utf-8');
    await mkdir(join(sourceHome(), 'skills', 'mine'), { recursive: true });
    await writeFile(join(sourceHome(), 'skills', 'mine', 'SKILL.md'), '# skill', 'utf-8');
    const code = await runHeadlessMigrate(
      { configOnly: false },
      { env: { KIMI_SHARE_DIR: shareDir }, userHome: home, targetHome: target, write },
    );
    expect(code).toBe(MIGRATE_HEADLESS_EXIT.success);
    const out = lines.join('\n');
    expect(out).toContain(`source: ${shareDir} (KIMI_SHARE_DIR)`);
    expect(out).toContain('skills: copied=1');
    const report = JSON.parse(await readFile(join(target, 'migration-report.json'), 'utf-8'));
    expect(report.summary.config.migrated).toBe(true);
  });
});
