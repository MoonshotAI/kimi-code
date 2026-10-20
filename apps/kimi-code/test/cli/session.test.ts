/**
 * `kimi session list`
 *
 * Verifies the CLI layer: scope option handling (--cwd/--all), archived
 * pass-through, --limit, --json, and the empty state.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  handleSessionList,
  registerSessionCommand,
  type SessionListDeps,
} from '#/cli/sub/session';
import type { ListSessionsOptions, SessionSummary } from '@moonshot-ai/kimi-code-sdk';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'ses_1',
    workDir: '/repo',
    sessionDir: '/home/.kimi-code/sessions/wd_repo/ses_1',
    createdAt: 1,
    updatedAt: new Date('2026-09-01T10:00:00').getTime(),
    ...overrides,
  };
}

interface Captured {
  options?: ListSessionsOptions;
  out: string;
  err: string;
  exitCode?: number;
}

function stubDeps(sessions: readonly SessionSummary[]): {
  deps: SessionListDeps;
  captured: Captured;
} {
  const captured: Captured = { out: '', err: '' };
  const deps: SessionListDeps = {
    listSessions: async (options) => {
      captured.options = options;
      return sessions;
    },
    cwd: () => '/repo',
    stdout: {
      write: (chunk) => {
        captured.out += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        captured.err += chunk;
        return true;
      },
    },
    exit: (code) => {
      captured.exitCode = code;
      throw new Error(`exit ${code}`);
    },
  };
  return { deps, captured };
}

describe('handleSessionList', () => {
  it('lists sessions of the current working directory by default', async () => {
    const { deps, captured } = stubDeps([
      summary({ id: 'ses_1', title: 'first' }),
      summary({ id: 'ses_2', title: 'second' }),
    ]);

    await handleSessionList(deps, { all: false, archived: false, json: false });

    expect(captured.options).toEqual({ workDir: '/repo', includeArchived: undefined });
    expect(captured.out).toContain('ses_1');
    expect(captured.out).toContain('first');
    expect(captured.out).toContain('ses_2');
    expect(captured.out).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(captured.out).not.toContain('/repo\n');
  });

  it('lists every workspace with --all and shows workDir per row', async () => {
    const { deps, captured } = stubDeps([summary({ id: 'ses_1', workDir: '/repo' })]);

    await handleSessionList(deps, { all: true, archived: false, json: false });

    expect(captured.options).toEqual({ workDir: undefined, includeArchived: undefined });
    expect(captured.out).toContain('/repo');
  });

  it('uses an explicit --cwd over the current directory', async () => {
    const { deps, captured } = stubDeps([summary()]);

    await handleSessionList(deps, { all: false, archived: false, cwd: '/other', json: false });

    expect(captured.options).toEqual({ workDir: '/other', includeArchived: undefined });
  });

  it('passes includeArchived through with --archived', async () => {
    const { deps, captured } = stubDeps([summary({ archived: true })]);

    await handleSessionList(deps, { all: false, archived: true, json: false });

    expect(captured.options).toEqual({ workDir: '/repo', includeArchived: true });
    expect(captured.out).toContain('[archived]');
  });

  it('truncates with --limit', async () => {
    const { deps, captured } = stubDeps([
      summary({ id: 'ses_1' }),
      summary({ id: 'ses_2' }),
      summary({ id: 'ses_3' }),
    ]);

    await handleSessionList(deps, { all: false, archived: false, limit: 2, json: false });

    expect(captured.out).toContain('ses_1');
    expect(captured.out).toContain('ses_2');
    expect(captured.out).not.toContain('ses_3');
  });

  it('emits the summaries as JSON with --json', async () => {
    const sessions = [summary({ id: 'ses_1', title: 'first' })];
    const { deps, captured } = stubDeps(sessions);

    await handleSessionList(deps, { all: false, archived: false, json: true });

    expect(JSON.parse(captured.out)).toEqual(JSON.parse(JSON.stringify(sessions)));
  });

  it('prints a friendly empty state', async () => {
    const { deps, captured } = stubDeps([]);

    await handleSessionList(deps, { all: false, archived: false, json: false });

    expect(captured.out).toBe('No sessions found.\n');
  });

  it('strips control characters and line breaks from user-controlled fields', async () => {
    const { deps, captured } = stubDeps([
      summary({
        id: 'ses_1',
        title: 'line one\nline two \u001b[31mred\u001b[0m',
        workDir: '/repo\nevil',
      }),
    ]);

    await handleSessionList(deps, { all: true, archived: false, json: false });

    const rows = captured.out.trimEnd().split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain('\u001b');
    expect(rows[0]).toContain('line one line two  [31mred [0m');
    expect(rows[0]).toContain('/repo evil');
  });
});

describe('registerSessionCommand', () => {
  it('parses session list options and runs the handler', async () => {
    const sessions = [summary({ id: 'ses_1', title: 'first' })];
    const { deps, captured } = stubDeps(sessions);
    const program = new Command('kimi');
    registerSessionCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'session', 'list', '--all', '--json']);

    expect(captured.options).toEqual({ workDir: undefined, includeArchived: undefined });
    expect(JSON.parse(captured.out)).toEqual(JSON.parse(JSON.stringify(sessions)));
    expect(captured.exitCode).toBeUndefined();
  });

  it('rejects a non-numeric --limit', async () => {
    const { deps } = stubDeps([]);
    const program = new Command('kimi');
    program.exitOverride();
    registerSessionCommand(program, deps);

    await expect(
      program.parseAsync(['node', 'kimi', 'session', 'list', '--limit', 'abc']),
    ).rejects.toThrow(/positive integer/);
  });
});
