import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { importedSessionDir } from '@moonshot-ai/migration-legacy';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleImportSessionsCommand } from '#/tui/commands/import-sessions';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/registry';
import {
  candidatesWithin,
  IMPORT_BATCH_LIMIT,
  importBudget,
  importedSessionId,
  importSessions,
  ImportSessionsScreenComponent,
  registerImportSessionsCommand,
  scanImportableSessions,
  sourceHomes,
  type ImportCandidate,
  type ImportReport,
} from '#/session-import/index';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const BUDGET = { contextWindow: 32_768, tokenBudget: 16_384 };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'import-sessions-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project, kimiHome: join(root, 'kimi'), claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') };
}

async function write(path: string, rows: unknown[], ageDays: number): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const time = new Date(NOW - ageDays * DAY);
  await utimes(path, time, time);
  return Math.round((await stat(path)).mtimeMs);
}

function claudeSession(cwd: string, prompt: string): unknown[] {
  return [
    { type: 'user', uuid: 'u', parentUuid: null, cwd, entrypoint: 'cli', message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], model: 'example' } },
  ];
}

function codexSession(id: string, cwd: string, extra: Record<string, unknown> = {}): unknown[] {
  return [
    { type: 'session_meta', payload: { id, cwd, source: 'cli', ...extra } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added.' }] } },
  ];
}

const plain = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const render = (screen: ImportSessionsScreenComponent): string => plain(screen.render(120).join('\n'));

describe('importing sessions', () => {
  it('imports recent sessions as ordinary sessions and skips them on the next run', async () => {
    const { project, kimiHome, claudeHome, codexHome } = await setup();
    const claudeTime = await write(join(claudeHome, 'projects', '-project', 'claude-one.jsonl'), claudeSession(project, 'Fix the login flow'), 2);
    await write(join(codexHome, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-00-00-thread-one.jsonl'), codexSession('thread-one', project), 20);
    await write(join(codexHome, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-05-00-helper.jsonl'), codexSession('helper', project, { source: { subagent: { thread_spawn: { parent_thread_id: 'thread-one', depth: 1 } } } }), 20);
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)');
    database.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-one', 'Renamed in Codex');
    database.close();

    const scan = await scanImportableSessions({ kimiHome, claudeHome, codexHome, now: NOW });
    expect(scan.candidates.map((candidate) => [candidate.source, candidate.sessionId])).toEqual([
      ['claude-code', 'ses_claude-one'],
      ['codex', 'ses_thread-one'],
    ]);
    expect(candidatesWithin(scan, 15, NOW).map((candidate) => candidate.sessionId)).toEqual(['ses_claude-one']);

    const report = await importSessions(scan.candidates, { kimiHome, ...BUDGET, now: NOW });
    expect(report).toEqual({
      imported: ['ses_claude-one', 'ses_thread-one'],
      alreadyImported: 0,
      missingFolder: 0,
      inUse: 0,
      empty: 0,
      unsupported: 0,
      failed: [],
      stopped: false,
    });
    const sessionDir = importedSessionDir(kimiHome, project, 'ses_claude-one');
    expect(JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'))).toMatchObject({
      id: 'ses_claude-one',
      cwd: project,
      title: 'Fix the login flow',
      lastPrompt: 'Fix the login flow',
      updatedAt: claudeTime,
      custom: { imported_from: 'claude-code', imported_source_id: 'claude-one' },
    });
    const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8');
    expect(wire).toContain('Fix the login flow');
    expect(wire).toContain('<imported_conversation>');
    expect((await readdir(join(sessionDir, 'attachments'))).some((name) => name.startsWith('effective-history-'))).toBe(true);
    expect(await readdir(join(sessionDir, 'attachments', 'source'))).toEqual(['claude-one.jsonl']);
    expect(await readdir(join(importedSessionDir(kimiHome, project, 'ses_thread-one'), 'attachments', 'source', 'subagents'))).toEqual(['rollout-2026-10-01T10-05-00-helper.jsonl']);
    expect(JSON.parse(await readFile(join(importedSessionDir(kimiHome, project, 'ses_thread-one'), 'state.json'), 'utf8'))).toMatchObject({ title: 'Renamed in Codex', lastPrompt: 'Add tests' });

    expect(await scanImportableSessions({ kimiHome, claudeHome, codexHome, now: NOW })).toEqual({ candidates: [], alreadyImported: 2, missingFolder: 0 });
  });

  it('reports sessions it cannot import and leaves no partial session directories', async () => {
    const { root, project, kimiHome, claudeHome, codexHome } = await setup();
    const projects = join(claudeHome, 'projects', '-project');
    await write(join(projects, 'moved.jsonl'), claudeSession(join(root, 'deleted-project'), 'Old task'), 1);
    await write(join(projects, 'commands-only.jsonl'), [
      { type: 'user', uuid: 'c', parentUuid: null, cwd: project, entrypoint: 'cli', message: { role: 'user', content: '<command-name>/model</command-name>' } },
    ], 1);
    await write(
      join(codexHome, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-00-00-forked.jsonl'),
      codexSession('forked', project, { history_base: { thread_id: 'parent', end_ordinal_exclusive: 3, end_byte_offset: 120 } }),
      1,
    );

    const scan = await scanImportableSessions({ kimiHome, claudeHome, codexHome, now: NOW });
    expect(scan.candidates.map((candidate) => candidate.sourceId)).toEqual(['forked']);
    expect(scan.missingFolder).toBe(1);
    const commandsOnly: ImportCandidate = {
      source: 'claude-code',
      path: join(projects, 'commands-only.jsonl'),
      sourceId: 'commands-only',
      cwd: project,
      modifiedAt: NOW,
      sessionId: 'ses_commands-only',
    };
    const report = await importSessions([...scan.candidates, commandsOnly], { kimiHome, ...BUDGET, now: NOW });

    expect(report).toEqual({ imported: [], alreadyImported: 0, missingFolder: 0, inUse: 0, empty: 1, unsupported: 1, failed: [], stopped: false });
    expect(await readdir(join(kimiHome, 'sessions')).catch(() => [])).toEqual([]);
  });

  it('imports at most one batch and stops between sessions when asked', async () => {
    const { kimiHome } = await setup();
    const candidates: ImportCandidate[] = Array.from({ length: IMPORT_BATCH_LIMIT + 1 }, (_, index) => ({
      source: 'claude-code',
      path: `/example/source-${String(index)}.jsonl`,
      sourceId: `source-${String(index)}`,
      cwd: '/example/missing-project',
      modifiedAt: NOW,
      sessionId: `ses_source-${String(index)}`,
    }));

    expect((await importSessions(candidates, { kimiHome, ...BUDGET, now: NOW })).missingFolder).toBe(IMPORT_BATCH_LIMIT);
    let started = 0;
    const stopped = await importSessions(candidates, {
      kimiHome,
      ...BUDGET,
      now: NOW,
      onProgress: () => {
        started++;
      },
      shouldStop: () => started >= 2,
    });
    expect(stopped).toMatchObject({ stopped: true, missingFolder: 2 });
  });

  it('turns unreliable conversions into skip reasons and failures', async () => {
    const { project, kimiHome } = await setup();
    vi.resetModules();
    vi.doMock('@moonshot-ai/session-import', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@moonshot-ai/session-import')>()),
      convertSession: async ({ sourcePath }: { sourcePath: string }) => {
        const code = sourcePath.slice(sourcePath.lastIndexOf('/') + 1, -'.jsonl'.length);
        return { status: 'unreliable', error: { code, message: `${code} message` }, issues: [] };
      },
    }));
    try {
      const { importSessions: importWithConversion } = await import('#/session-import/run-import');
      const candidates = ['SOURCE_CHANGED', 'EMPTY_SOURCE_HISTORY', 'UNSUPPORTED_HISTORY_BASE', 'CONVERSION_FAILED'].map((code) => ({
        source: 'claude-code' as const,
        path: `/example/${code}.jsonl`,
        sourceId: code,
        cwd: project,
        modifiedAt: NOW,
        sessionId: `ses_${code}`,
      }));
      expect(await importWithConversion(candidates, { kimiHome, ...BUDGET, now: NOW })).toEqual({
        imported: [],
        alreadyImported: 0,
        missingFolder: 0,
        inUse: 1,
        empty: 1,
        unsupported: 1,
        failed: [{ path: '/example/CONVERSION_FAILED.jsonl', message: 'CONVERSION_FAILED message' }],
        stopped: false,
      });
      expect(await readdir(join(kimiHome, 'sessions')).catch(() => [])).toEqual([]);
    } finally {
      vi.doUnmock('@moonshot-ai/session-import');
      vi.resetModules();
    }
  });

  it('sizes imports below the compaction threshold of the default model input limit', () => {
    const config = (maxContextSize: number, extra: { maxInputSize?: number; overrides?: { maxContextSize: number } } = {}) => ({
      defaultModel: 'example',
      models: { example: { provider: 'example', model: 'example-model', maxContextSize, ...extra } },
    });
    expect(importBudget({})).toEqual({ contextWindow: 131_072, tokenBudget: 40_857 });
    expect(importBudget(config(262_144))).toEqual({ contextWindow: 262_144, tokenBudget: 145_715 });
    expect(importBudget(config(400_000, { maxInputSize: 272_000 }))).toEqual({ contextWindow: 272_000, tokenBudget: 153_600 });
    expect(importBudget(config(200_000, { maxInputSize: 300_000 }))).toEqual({ contextWindow: 200_000, tokenBudget: 96_000 });
    expect(importBudget(config(400_000, { maxInputSize: 272_000, overrides: { maxContextSize: 128_000 } }))).toEqual({ contextWindow: 128_000, tokenBudget: 38_400 });
    expect(importBudget({ ...config(1_000_000), loopControl: { reservedContextSize: 0, compactionTriggerRatio: 0.95 } })).toEqual({ contextWindow: 1_000_000, tokenBudget: 736_000 });
    expect(importBudget(config(32_768))).toEqual({ contextWindow: 32_768, tokenBudget: 16_384 });
  });

  it('derives stable session ids and honors source home overrides', () => {
    const base = { source: 'codex' as const, path: '/example/rollout.jsonl', cwd: '/example', modifiedAt: NOW };
    expect(importedSessionId({ ...base, sourceId: '019a1b2c-3d4e' })).toBe('ses_019a1b2c-3d4e');
    expect(importedSessionId({ ...base, sourceId: 'odd id/with slash' })).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(sourceHomes({ CLAUDE_CONFIG_DIR: '/example/claude', CODEX_HOME: '/example/codex' }, '/home/example')).toEqual({
      claudeHome: '/example/claude',
      codexHome: '/example/codex',
    });
    expect(sourceHomes({}, '/home/example')).toEqual({ claudeHome: '/home/example/.claude', codexHome: '/home/example/.codex' });
  });
});

describe('ImportSessionsScreenComponent', () => {
  const candidate = (sessionId: string, source: 'claude-code' | 'codex', ageDays: number): ImportCandidate => ({
    source,
    path: `/sources/${sessionId}.jsonl`,
    sourceId: sessionId,
    cwd: '/projects/app',
    modifiedAt: NOW - ageDays * DAY,
    sessionId,
  });
  const scan = { candidates: [candidate('a', 'claude-code', 1), candidate('b', 'codex', 3), candidate('c', 'claude-code', 20)], alreadyImported: 2, missingFolder: 1 };
  const report = (overrides: Partial<ImportReport> = {}): ImportReport => ({
    imported: [],
    alreadyImported: 0,
    missingFolder: 0,
    inUse: 0,
    empty: 0,
    unsupported: 0,
    failed: [],
    stopped: false,
    ...overrides,
  });

  it('shows both windows with their counts and selects the last 15 days by default', async () => {
    const screen = new ImportSessionsScreenComponent({ now: NOW, scan: async () => scan, run: vi.fn(), onClose: vi.fn() });
    expect(render(screen)).toContain('Scanning Claude Code and Codex sessions');
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Last 30 days');
    });
    const out = render(screen);
    expect(out).toMatch(/❯ Last 15 days\s+2 sessions/);
    expect(out).toMatch(/ {3}Last 30 days\s+3 sessions/);
    expect(out).toContain('Claude Code 2 · Codex 1 · not counted: 2 already imported, 1 with a missing project folder');
  });

  it('imports the chosen window and summarizes the outcome', async () => {
    const run = vi.fn(async (candidates: readonly ImportCandidate[], hooks: { onProgress: (progress: { index: number; total: number; candidate: ImportCandidate }) => void }) => {
      hooks.onProgress({ index: 0, total: candidates.length, candidate: candidates[0]! });
      return report({ imported: ['a', 'b'], missingFolder: 1, failed: [{ path: '/sources/broken.jsonl', message: 'Broken record' }] });
    });
    const onClose = vi.fn();
    const screen = new ImportSessionsScreenComponent({ now: NOW, scan: async () => scan, run, onClose });
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Last 30 days');
    });

    screen.handleInput('\u001B[B');
    screen.handleInput('\r');
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Imported 2 sessions.');
    });

    expect(run.mock.calls[0]![0].map((item) => item.sessionId)).toEqual(['a', 'b', 'c']);
    const out = render(screen);
    expect(out).toContain('Skipped 1:\n   1 with a missing project folder');
    expect(out).toContain('broken.jsonl: Broken record');
    expect(out).toContain('/sessions');
    screen.handleInput('\r');
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ imported: ['a', 'b'] }));
  });

  it('stops after the current session when escape is pressed during an import', async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn((_candidates: readonly ImportCandidate[], hooks: { shouldStop: () => boolean }) =>
      new Promise<ImportReport>((resolve) => {
        finish = () => {
          resolve(report({ imported: ['a'], stopped: hooks.shouldStop() }));
        };
      }));
    const screen = new ImportSessionsScreenComponent({ now: NOW, scan: async () => scan, run, onClose: vi.fn() });
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Last 30 days');
    });

    screen.handleInput('\r');
    expect(run.mock.calls[0]![0]).toHaveLength(2);
    screen.handleInput('\u001B');
    expect(render(screen)).toContain('Stopping after the current session');
    finish!();
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Import stopped. Imported 1 session.');
    });
  });

  it('offers only Close when nothing new can be imported', async () => {
    const onClose = vi.fn();
    const screen = new ImportSessionsScreenComponent({ now: NOW, scan: async () => ({ candidates: [], alreadyImported: 3, missingFolder: 0 }), run: vi.fn(), onClose });
    await vi.waitFor(() => {
      expect(render(screen)).toContain('No sessions from the last 30 days to import. 3 already imported.');
    });
    expect(render(screen)).toContain('❯ Close');

    screen.handleInput('\r');
    expect(onClose).toHaveBeenCalledWith(undefined);
  });
});

describe('/import-sessions', () => {
  async function openPage(root: string, kimiHome: string) {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    vi.stubEnv('CODEX_HOME', join(root, 'codex'));
    const host = {
      harness: {
        homeDir: kimiHome,
        listSessions: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({ defaultModel: 'example', models: { example: { provider: 'example', model: 'example-model', maxContextSize: 32_768 } } })),
      },
      state: { ui: { requestRender: vi.fn() } },
      mountEditorReplacement: vi.fn(),
      restoreEditor: vi.fn(),
    };
    handleImportSessionsCommand(host as unknown as SlashCommandHost);
    const screen = host.mountEditorReplacement.mock.calls[0]![0] as ImportSessionsScreenComponent;
    expect(screen).toBeInstanceOf(ImportSessionsScreenComponent);
    return { host, screen };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces the editor with the import page while idle and restores it on close', async () => {
    const { root, kimiHome } = await setup();
    expect(resolveSlashCommandAvailability(findBuiltInSlashCommand('import-sessions')!, '')).toBe('idle-only');
    const { host, screen } = await openPage(root, kimiHome);
    await vi.waitFor(() => {
      expect(render(screen)).toContain('No sessions from the last 30 days to import.');
    });

    screen.handleInput('\r');
    expect(host.restoreEditor).toHaveBeenCalledOnce();
  });

  it('looks up each imported session so the running session list includes it right away', async () => {
    const { root, project, kimiHome } = await setup();
    await write(join(root, 'claude', 'projects', '-project', 'claude-one.jsonl'), claudeSession(project, 'Fix the login flow'), 1);
    const { host, screen } = await openPage(root, kimiHome);
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Last 15 days');
    });

    screen.handleInput('\r');
    await vi.waitFor(() => {
      expect(render(screen)).toContain('Imported 1 session.');
    });
    expect(host.harness.listSessions).toHaveBeenCalledWith({ sessionId: 'ses_claude-one' });
    expect(host.harness.getConfig).toHaveBeenCalledOnce();
  });
});

describe('registerImportSessionsCommand', () => {
  it('adds the import-sessions subcommand and passes its exit code through', async () => {
    const program = new Command('kimi');
    const run = vi.fn(async () => 0);
    registerImportSessionsCommand(program, run);

    expect(program.commands.find((command) => command.name() === 'import-sessions')?.description()).toContain('Claude Code and Codex');
    await program.parseAsync(['import-sessions'], { from: 'user' });
    expect(run).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });
});
