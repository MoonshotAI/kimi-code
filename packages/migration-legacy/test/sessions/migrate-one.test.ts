import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateOneSession, type MigrateOneResult } from '../../src/sessions/migrate-one.js';
import { countImportedSessionsNeedingRepair } from '../../src/sessions/repair-imported.js';
import { computeWorkdirBucket } from '../../src/sessions/workdir-bucket.js';
import { targetSessionsDir } from '../../src/paths.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'migrate-one-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

describe('migrateOneSession (tiny-hello-world fixture)', () => {
  it('produces a valid v1.0 session dir', async () => {
    const result = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.title).toBe('hi');
    expect(state.lastTurnReason).toBe('completed');
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const lines = wire.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toContain('"protocol_version":"1.0"');
    const records = lines.map((l) => JSON.parse(l) as { type: string });
    // metadata + turn.prompt + 2 messages + turn.ended + token_counting.measured
    // (the fixture carries a `_usage` row with token_count 9133)
    expect(records.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'token_counting.measured',
    ]);
  });

  it('reports already-migrated on an idempotent re-run', async () => {
    await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    const second = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    // The dir we wrote carries `imported_from_kimi_cli`, so a re-run is an
    // idempotent skip, not a real collision.
    expect(second.outcome).toBe('already-migrated');
  });

  it('reports conflict when an unrelated kimi-code session occupies the dir', async () => {
    const first = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(first.outcome).toBe('migrated');
    const targetDir = (first as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    // Overwrite state.json with a non-migrated (real) kimi-code session.
    await writeFile(join(targetDir, 'state.json'), JSON.stringify({ title: 'real' }), 'utf-8');
    const second = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(second.outcome).toBe('conflict');
  });

  it('re-migrates a target dir left half-written by an interrupted run', async () => {
    const workdirPath = '/Users/me/proj';
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_tiny-uuid',
    );
    // Simulate a prior run killed after the dir + wire.jsonl were written but
    // before state.json — exactly the debris a hard crash leaves, since a
    // crash bypasses the in-process cleanup. Without state.json this is not a
    // real kimi-code session, so it must be re-migrated, not reported as a
    // permanent conflict that strands the session forever.
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');

    const result = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.custom.imported_from_kimi_cli).toBe(true);
  });

  it('re-migrates a target dir whose state.json is corrupt', async () => {
    const workdirPath = '/Users/me/proj';
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_tiny-uuid',
    );
    // Simulate a crash mid-write of state.json: the dir + wire.jsonl exist and
    // state.json is present but unparseable. It is migration debris (the path
    // is `ses_<uuid>`), not a real kimi-code session, so it must be
    // re-migrated, not reported as a permanent conflict.
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');
    await writeFile(join(targetDir, 'state.json'), '{ "createdAt": "broke');

    const result = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.custom.imported_from_kimi_cli).toBe(true);
  });

  it('stamps written artifacts with the original wire_mtime', async () => {
    // tiny-hello-world/state.json has `wire_mtime: 1772616338.93`.
    // `SessionStore.list()` ranks sessions by filesystem mtime, so the
    // migrated artifacts must carry the original timestamp — not write-time.
    const expectedMs = Math.floor(1772616338.93 * 1000);
    const result = await migrateOneSession({
      source: { uuid: 'tiny-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(join(FIXTURES, 'tiny-hello-world'), 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;

    const stateStat = await stat(join(targetDir, 'state.json'));
    const wireStat = await stat(join(targetDir, 'agents', 'main', 'wire.jsonl'));
    const dirStat = await stat(targetDir);

    // Within one second of the fixture's wire_mtime.
    expect(Math.abs(stateStat.mtimeMs - expectedMs)).toBeLessThan(1000);
    expect(Math.abs(wireStat.mtimeMs - expectedMs)).toBeLessThan(1000);
    expect(Math.abs(dirStat.mtimeMs - expectedMs)).toBeLessThan(1000);
  });

  it('falls back to the wire.jsonl mtime when wire_mtime is absent', async () => {
    // A state.json without `wire_mtime` must stamp the migrated artifacts from
    // the SAME signal detection ranks recency by — the source wire.jsonl mtime
    // — so post-migration list ordering matches the detected order.
    const srcDir = join(targetHome, 'src-no-wiremtime');
    await mkdir(srcDir, { recursive: true });
    const fixtureContext = await readFile(
      join(FIXTURES, 'tiny-hello-world', 'context.jsonl'),
      'utf-8',
    );
    await writeFile(join(srcDir, 'context.jsonl'), fixtureContext, 'utf-8');
    await writeFile(join(srcDir, 'wire.jsonl'), '{"type":"metadata"}\n', 'utf-8');
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');
    const wireTime = new Date('2024-03-04T05:06:07.000Z');
    const contextTime = new Date('2020-01-01T00:00:00.000Z');
    await utimes(join(srcDir, 'context.jsonl'), contextTime, contextTime);
    await utimes(join(srcDir, 'wire.jsonl'), wireTime, wireTime);

    const result = await migrateOneSession({
      source: { uuid: 'no-wiremtime-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const wireStat = await stat(join(targetDir, 'agents', 'main', 'wire.jsonl'));
    expect(Math.abs(wireStat.mtimeMs - wireTime.getTime())).toBeLessThan(1000);
  });

  it('reports outcome "empty" — not "failed" — when the context has no messages', async () => {
    // A context.jsonl with only markers (e.g. a session the user cleared in
    // kimi-cli) carries no migratable conversation. That is an empty session,
    // not a migration failure.
    const srcDir = join(targetHome, 'src-empty-context');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'context.jsonl'),
      '{"role":"_system_prompt","content":"You are ..."}\n',
      'utf-8',
    );
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');

    const result = await migrateOneSession({
      source: { uuid: 'empty-context-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('empty');
  });

  it('reports outcome "failed" when context.jsonl is corrupt (no parseable JSON lines)', async () => {
    // A disk-corrupted / truncated context.jsonl must be surfaced as a real
    // failure (so it ends up in `migration-errors.log`), not silently
    // counted as "skipped empty".
    const srcDir = join(targetHome, 'src-corrupt-context');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'context.jsonl'), 'not-json\n{broken\n}}}\n', 'utf-8');
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');

    const result = await migrateOneSession({
      source: { uuid: 'corrupt-context-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.reason).toMatch(/corrupt|parseable/i);
    }
  });

  it('migrates a historical flat context file with no session dir', async () => {
    const flatFile = join(targetHome, 'flat-uuid.jsonl');
    await writeFile(
      flatFile,
      '{"role":"user","content":"hello from the flat era"}\n',
      'utf-8',
    );

    const result = await migrateOneSession({
      source: { uuid: 'flat-uuid', flatContextFile: flatFile, contextPath: flatFile },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).toContain('hello from the flat era');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as {
      title: string;
    };
    expect(state.title).toBe('hello from the flat era');
  });

  it('migrates a title-only session: empty wire, title preserved', async () => {
    const srcDir = join(targetHome, 'src-title-only');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'context.jsonl'), '', 'utf-8');
    await writeFile(
      join(srcDir, 'state.json'),
      JSON.stringify({ custom_title: 'My named session' }),
      'utf-8',
    );

    const result = await migrateOneSession({
      source: { uuid: 'title-only-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).not.toContain('append_message');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as {
      title: string;
      isCustomTitle: boolean;
    };
    expect(state.title).toBe('My named session');
    expect(state.isCustomTitle).toBe(true);
  });

  it('merges legacy metadata.json into the migrated state (state fields win)', async () => {
    const srcDir = join(targetHome, 'src-metadata-merge');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'context.jsonl'),
      '{"role":"user","content":"hi"}\n',
      'utf-8',
    );
    await writeFile(
      join(srcDir, 'state.json'),
      JSON.stringify({ archived: false, archived_at: null, custom_title: 'State Title' }),
      'utf-8',
    );
    await writeFile(
      join(srcDir, 'metadata.json'),
      JSON.stringify({
        session_id: 'metadata-merge-uuid',
        title: 'Legacy Title',
        archived: true,
        archived_at: 9999,
        auto_archive_exempt: true,
      }),
      'utf-8',
    );

    const result = await migrateOneSession({
      source: { uuid: 'metadata-merge-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as {
      title: string;
      archived: boolean;
      archivedAt?: number;
      custom: { auto_archive_exempt: boolean };
    };
    expect(state.title).toBe('State Title');
    expect(state.archived).toBe(true);
    expect(state.archivedAt).toBe(9999000);
    expect(state.custom.auto_archive_exempt).toBe(true);
  });
});

describe('migrateOneSession repair of message-only imports', () => {
  const workdirPath = '/Users/me/proj';

  async function seedImportedTarget(
    wireLines: string[],
    stateExtra: Record<string, unknown> = {},
  ): Promise<string> {
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_repair-uuid',
    );
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), wireLines.join('\n') + '\n');
    await writeFile(
      join(targetDir, 'state.json'),
      JSON.stringify({
        id: 'ses_repair-uuid',
        title: 'old import',
        custom: { imported_from_kimi_cli: true, kimi_cli_session_id: 'repair-uuid' },
        ...stateExtra,
      }),
    );
    return targetDir;
  }

  const importedWire = [
    '{"type":"metadata","protocol_version":"1.0","created_at":1700000000000}',
    '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"old question"}],"toolCalls":[]}}',
    '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"old answer"}],"toolCalls":[]}}',
  ];

  function runMigrate() {
    return migrateOneSession({
      source: { uuid: 'repair-uuid', sessionDir: join(FIXTURES, 'tiny-hello-world'), contextPath: join(FIXTURES, 'tiny-hello-world', 'context.jsonl') },
      workdirPath,
      targetHome,
    });
  }

  it('inserts turn structure into a message-only imported wire, once', async () => {
    const targetDir = await seedImportedTarget(importedWire);

    const first = await runMigrate();
    expect(first.outcome).toBe('repaired');

    const records = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(records.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
    ]);
    expect(records[1]).toMatchObject({
      agentId: 'main',
      origin: { kind: 'user' },
      input: [{ type: 'text', text: 'old question' }],
      time: 1700000000000,
    });
    expect(records[4]).toMatchObject({ agentId: 'main', turnId: 0, reason: 'completed' });

    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.lastTurnReason).toBe('completed');
    expect(state.custom.import_format_version).toBe(2);

    const second = await runMigrate();
    expect(second.outcome).toBe('already-migrated');
  });

  it('imports the legacy todo list as a tools.update_store record', async () => {
    const sourceDir = join(targetHome, 'src-with-todos');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'state.json'),
      JSON.stringify({
        todos: [
          { title: '创建 f1.txt', status: 'done' },
          { title: '创建 f2.txt', status: 'in_progress' },
          { title: 'bogus', status: 'weird' },
        ],
      }),
    );
    const liveSuffix = [
      '{"type":"prompt.completed","agentId":"main","promptId":"msg_live1","time":1800000000002}',
    ];
    const targetDir = await seedImportedTarget([...importedWire, ...liveSuffix], {
      custom: {
        imported_from_kimi_cli: true,
        kimi_cli_session_id: 'repair-uuid',
        kimi_cli_source_path: sourceDir,
      },
    });

    const first = await runMigrate();
    expect(first.outcome).toBe('repaired');

    const lines = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'tools.update_store',
      'prompt.completed',
    ]);
    const todoRecord = JSON.parse(lines[5]!);
    // Invalid entries are filtered out; order is preserved.
    expect(todoRecord.value).toEqual([
      { title: '创建 f1.txt', status: 'done' },
      { title: '创建 f2.txt', status: 'in_progress' },
    ]);
    expect(todoRecord.time).toBe(1700000000000);
    expect(lines[6]).toBe(liveSuffix[0]);

    const second = await runMigrate();
    expect(second.outcome).toBe('already-migrated');
  });

  it('preserves a live suffix verbatim while repairing the imported prefix', async () => {
    const liveSuffix = [
      '{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"new question"}],"origin":{"kind":"user"},"time":1800000000000}',
      '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"new question"}],"toolCalls":[],"origin":{"kind":"user"},"id":"msg_live1"}}',
      '{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed","time":1800000000001}',
    ];
    const targetDir = await seedImportedTarget(
      [...importedWire, ...liveSuffix],
      { lastTurnReason: 'completed' },
    );

    const first = await runMigrate();
    expect(first.outcome).toBe('repaired');

    const lines = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'turn.prompt',
      'context.append_message',
      'turn.ended',
    ]);
    expect(lines.slice(5)).toEqual(liveSuffix);

    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.lastTurnReason).toBe('completed');
  });

  it('reports failed when a session needing repair has an unrepairable wire', async () => {
    await seedImportedTarget(['{"type":"metadata","protocol_version":"1.0","created_at":1}', '{broken']);
    const result = await runMigrate();
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.reason).toMatch(/repair/i);
    }
  });

  it('stays already-migrated for an import at the current format version', async () => {
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_repair-uuid',
    );
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(targetDir, 'state.json'),
      JSON.stringify({
        id: 'ses_repair-uuid',
        title: 'current import',
        custom: {
          imported_from_kimi_cli: true,
          kimi_cli_session_id: 'repair-uuid',
          import_format_version: 2,
        },
      }),
    );
    const result = await runMigrate();
    expect(result.outcome).toBe('already-migrated');
  });
});

describe('countImportedSessionsNeedingRepair', () => {
  it('counts imported sessions whose import format predates the current migrator', async () => {
    const workdirPath = '/Users/me/proj';
    const bucket = join(targetSessionsDir(targetHome), computeWorkdirBucket(workdirPath));

    const needsRepair = join(bucket, 'ses_old-import');
    await mkdir(join(needsRepair, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(needsRepair, 'agents', 'main', 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"1.0","created_at":1}\n' +
        '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"x"}],"toolCalls":[]}}\n',
    );
    await writeFile(
      join(needsRepair, 'state.json'),
      JSON.stringify({ custom: { imported_from_kimi_cli: true } }),
    );

    const current = join(bucket, 'ses_current-import');
    await mkdir(join(current, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(current, 'agents', 'main', 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"1.0","created_at":1}\n' +
        '{"type":"turn.prompt","agentId":"main","input":[],"origin":{"kind":"user"},"time":1}\n' +
        '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"x"}],"toolCalls":[]}}\n',
    );
    await writeFile(
      join(current, 'state.json'),
      JSON.stringify({ custom: { imported_from_kimi_cli: true, import_format_version: 2 } }),
    );

    const native = join(bucket, 'ses_native');
    await mkdir(join(native, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(native, 'agents', 'main', 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n' +
        '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"x"}],"toolCalls":[]}}\n',
    );
    await writeFile(join(native, 'state.json'), JSON.stringify({ title: 'real session' }));

    expect(await countImportedSessionsNeedingRepair(targetHome)).toBe(1);
  });

  it('returns 0 for a missing sessions root', async () => {
    expect(await countImportedSessionsNeedingRepair(join(targetHome, 'nope'))).toBe(0);
  });
});

describe('migrateOneSession todo list migration', () => {
  it('writes the legacy todos as a tools.update_store record in a fresh migration', async () => {
    const srcDir = join(targetHome, 'src-fresh-todos');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'context.jsonl'),
      '{"role":"user","content":"hi"}\n{"role":"assistant","content":[{"type":"text","text":"Hello"}]}\n',
    );
    await writeFile(
      join(srcDir, 'state.json'),
      JSON.stringify({
        todos: [
          { title: '创建 f1.txt', status: 'done' },
          { title: '创建 f2.txt', status: 'pending' },
        ],
      }),
    );

    const result = await migrateOneSession({
      source: { uuid: 'fresh-todos-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const lines = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    const last = JSON.parse(lines.at(-1)!);
    expect(last).toMatchObject({
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [
        { title: '创建 f1.txt', status: 'done' },
        { title: '创建 f2.txt', status: 'pending' },
      ],
    });
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.custom.import_format_version).toBe(2);
  });
});

describe('migrateOneSession subagent migration', () => {
  const workdirPath = '/Users/me/proj';

  async function seedSourceWithSubagent(): Promise<string> {
    const srcDir = join(targetHome, 'src-with-subagent');
    await mkdir(join(srcDir, 'subagents', 'sub1'), { recursive: true });
    await writeFile(
      join(srcDir, 'context.jsonl'),
      [
        '{"role":"user","content":"run a subagent"}',
        '{"role":"assistant","content":[],"tool_calls":[{"type":"function","id":"tool_X","function":{"name":"Agent","arguments":"{\\"description\\":\\"calc\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tool_X","content":"56088"}',
      ].join('\n') + '\n',
    );
    await writeFile(join(srcDir, 'state.json'), '{}');
    await writeFile(
      join(srcDir, 'wire.jsonl'),
      [
        '{"type":"metadata","protocol_version":"1.10"}',
        '{"timestamp":1,"message":{"type":"SubagentEvent","payload":{"parent_tool_call_id":"tool_X","agent_id":"sub1","subagent_type":"coder","event":{"type":"TurnBegin","payload":{"user_input":"计算 123 乘以 456"}}}}}',
      ].join('\n') + '\n',
    );
    await writeFile(
      join(srcDir, 'subagents', 'sub1', 'meta.json'),
      JSON.stringify({
        agent_id: 'sub1',
        subagent_type: 'coder',
        status: 'idle',
        description: 'Calculate 123*456',
        created_at: 1700000000.0,
        updated_at: 1700000007.0,
        launch_spec: { effective_model: 'k2' },
      }),
    );
    await writeFile(
      join(srcDir, 'subagents', 'sub1', 'context.jsonl'),
      [
        '{"role":"user","content":"计算 123 乘以 456"}',
        '{"role":"assistant","content":[{"type":"text","text":"56088"}]}',
      ].join('\n') + '\n',
    );
    await writeFile(
      join(srcDir, 'subagents', 'sub1', 'state.json'),
      JSON.stringify({ todos: [{ title: 'calc', status: 'done' }] }),
    );
    return srcDir;
  }

  it('migrates subagent wire, task records and roster registration linked to the main history', async () => {
    const srcDir = await seedSourceWithSubagent();
    const result = await migrateOneSession({
      source: { uuid: 'sub-session-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;

    const subWire = (await readFile(join(targetDir, 'agents', 'sub1', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(subWire.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'tools.update_store',
    ]);
    expect(subWire[1]).toMatchObject({ agentId: 'sub1', origin: { kind: 'user' } });
    expect(subWire[5]).toMatchObject({ agentId: 'sub1', key: 'todo', value: [{ title: 'calc', status: 'done' }] });

    const mainWire = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(mainWire.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'task.started',
      'context.append_message',
      'context.append_message',
      'task.terminated',
      'turn.ended',
    ]);
    expect(mainWire[3]).toMatchObject({
      agentId: 'main',
      info: {
        kind: 'agent',
        taskId: 'sub1',
        agentId: 'sub1',
        subagentType: 'coder',
        parentToolCallId: 'tool_X',
        description: 'Calculate 123*456',
        status: 'running',
        startedAt: 1700000000000,
        endedAt: null,
        model: 'k2',
      },
    });
    expect(mainWire[6]).toMatchObject({
      agentId: 'main',
      info: { taskId: 'sub1', status: 'completed', endedAt: 1700000007000 },
    });

    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.agents.sub1).toMatchObject({
      type: 'sub',
      parentAgentId: 'main',
      labels: { parentAgentId: 'main' },
    });
    expect(state.agents.sub1.homedir).toBe(join(targetDir, 'agents', 'sub1'));

    const second = await migrateOneSession({
      source: { uuid: 'sub-session-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(second.outcome).toBe('already-migrated');
  });

  it('repairs a message-only import by adding subagent wires and task records', async () => {
    const srcDir = await seedSourceWithSubagent();
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_repair-sub-uuid',
    );
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(targetDir, 'agents', 'main', 'wire.jsonl'),
      [
        '{"type":"metadata","protocol_version":"1.0","created_at":1700000000000}',
        '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"run a subagent"}],"toolCalls":[]}}',
        '{"type":"context.append_message","message":{"role":"assistant","content":[],"toolCalls":[{"type":"function","id":"tool_X","function":{"name":"Agent","arguments":"{}"}}]}}',
        '{"type":"context.append_message","message":{"role":"tool","content":[{"type":"text","text":"56088"}],"toolCalls":[],"toolCallId":"tool_X"}}',
      ].join('\n') + '\n',
    );
    await writeFile(
      join(targetDir, 'state.json'),
      JSON.stringify({
        id: 'ses_repair-sub-uuid',
        title: 'old import',
        custom: {
          imported_from_kimi_cli: true,
          kimi_cli_session_id: 'repair-sub-uuid',
          kimi_cli_source_path: srcDir,
        },
      }),
    );

    const result = await migrateOneSession({
      source: { uuid: 'repair-sub-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('repaired');

    const subWire = await readFile(join(targetDir, 'agents', 'sub1', 'wire.jsonl'), 'utf-8');
    expect(subWire).toContain('"agentId":"sub1"');

    const mainWire = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(mainWire.map((r) => r.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'task.started',
      'context.append_message',
      'context.append_message',
      'task.terminated',
      'turn.ended',
    ]);
    expect(mainWire[3]).toMatchObject({ info: { taskId: 'sub1', parentToolCallId: 'tool_X' } });

    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.agents.sub1).toBeDefined();
    expect(state.custom.import_format_version).toBe(2);

    const second = await migrateOneSession({
      source: { uuid: 'repair-sub-uuid', sessionDir: srcDir, contextPath: join(srcDir, 'context.jsonl') },
      workdirPath,
      targetHome,
    });
    expect(second.outcome).toBe('already-migrated');
  });
});
