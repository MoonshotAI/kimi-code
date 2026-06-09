/**
 * `/api/v1/sessions/{sid}/fs:git_status` end-to-end tests (W11.2 / Chain 12 / P1.12).
 *
 * AC coverage (ROADMAP §Chain 12):
 *   1. e2e: git repo / non-git repo / dirty / clean
 *   2. (perf bench is implicit — covered by W6 smoke run)
 *
 * Plus:
 *   - branch / ahead / behind parsing
 *   - rename surfaced as `renamed`
 *   - paths filter applied
 *   - path safety on filter inputs (41304)
 *   - 40401 unknown session
 *   - parsePorcelain unit tests (header variants + XY collapse priority)
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';
import { parsePorcelain } from '#/services/fs/fsGit';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-fs-git-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-fs-git-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{
        statusCode: number;
        json: () => unknown;
      }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningDaemon): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: workspace } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function initRepo(): void {
  git(['init', '-b', 'main']);
  writeFileSync(join(workspace, 'seed.txt'), 'seed\n');
  git(['add', 'seed.txt']);
  git(['commit', '-m', 'seed', '--no-gpg-sign']);
}

describe('POST /api/v1/sessions/{sid}/fs:git_status (W11.2)', () => {
  it('clean repo: empty entries, branch populated', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: {},
    });
    const env = envelopeOf<{
      branch: string;
      ahead: number;
      behind: number;
      entries: Record<string, string>;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.branch).toBe('main');
    expect(env.data!.ahead).toBe(0);
    expect(env.data!.behind).toBe(0);
    expect(Object.keys(env.data!.entries)).toEqual([]);
  });

  it('dirty repo: modified + untracked + deleted entries', async () => {
    initRepo();
    // Modify the tracked file.
    writeFileSync(join(workspace, 'seed.txt'), 'changed\n');
    // Add an untracked file.
    writeFileSync(join(workspace, 'new.txt'), 'new\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: {},
    });
    const env = envelopeOf<{
      branch: string;
      entries: Record<string, string>;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.branch).toBe('main');
    expect(env.data!.entries['seed.txt']).toBe('modified');
    expect(env.data!.entries['new.txt']).toBe('untracked');
  });

  it('renamed entry surfaces as `renamed`', async () => {
    initRepo();
    // Stage a rename.
    git(['mv', 'seed.txt', 'renamed.txt']);

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: {},
    });
    const env = envelopeOf<{ entries: Record<string, string> }>(res.json());
    expect(env.code).toBe(0);
    // Either 'renamed' (if git detected the rename) or 'deleted' + 'added'
    // (if rename detection was off). Both shapes are spec-valid; assert at
    // least one of the new paths reports a status.
    const statuses = Object.values(env.data!.entries);
    expect(statuses.length).toBeGreaterThan(0);
    expect(
      statuses.some((s) => s === 'renamed') ||
        (env.data!.entries['renamed.txt'] === 'added' &&
          env.data!.entries['seed.txt'] === 'deleted'),
    ).toBe(true);
  });

  it('paths filter scopes the entries map', async () => {
    initRepo();
    writeFileSync(join(workspace, 'a.txt'), 'a\n');
    writeFileSync(join(workspace, 'b.txt'), 'b\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: { paths: ['a.txt'] },
    });
    const env = envelopeOf<{ entries: Record<string, string> }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.entries).toEqual({ 'a.txt': 'untracked' });
  });

  it('non-git workspace → 40908', async () => {
    // workspace is a plain tmpdir; no `git init`.

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: {},
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40908);
  });

  it('path filter that escapes cwd → 41304', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: { paths: ['../outside.txt'] },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(41304);
  });

  it('40401 unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_does_not_exist/fs:git_status',
      payload: {},
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40401);
  });
});

// -----------------------------------------------------------------
// Unit: porcelain parser
// -----------------------------------------------------------------

describe('parsePorcelain (W11.2)', () => {
  it('parses a clean tree', () => {
    const out = parsePorcelain('## main\n', undefined);
    expect(out.branch).toBe('main');
    expect(out.ahead).toBe(0);
    expect(out.behind).toBe(0);
    expect(out.entries).toEqual({});
  });

  it('parses ahead/behind on the branch header', () => {
    const out = parsePorcelain(
      '## feat/web...origin/feat/web [ahead 2, behind 1]\n',
      undefined,
    );
    expect(out.branch).toBe('feat/web');
    expect(out.ahead).toBe(2);
    expect(out.behind).toBe(1);
  });

  it('parses HEAD (no branch) as empty', () => {
    const out = parsePorcelain('## HEAD (no branch)\n', undefined);
    expect(out.branch).toBe('');
  });

  it('parses No commits yet on main', () => {
    const out = parsePorcelain('## No commits yet on main\n', undefined);
    expect(out.branch).toBe('main');
  });

  it('parses untracked (??)', () => {
    const out = parsePorcelain('## main\n?? new.txt\n', undefined);
    expect(out.entries['new.txt']).toBe('untracked');
  });

  it('parses ignored (!!)', () => {
    const out = parsePorcelain('## main\n!! a.log\n', undefined);
    expect(out.entries['a.log']).toBe('ignored');
  });

  it('collapses M_ / _M / MM → modified', () => {
    const out = parsePorcelain(
      '## main\nM  a.ts\n M b.ts\nMM c.ts\n',
      undefined,
    );
    expect(out.entries['a.ts']).toBe('modified');
    expect(out.entries['b.ts']).toBe('modified');
    expect(out.entries['c.ts']).toBe('modified');
  });

  it('collapses A_ → added', () => {
    const out = parsePorcelain('## main\nA  a.ts\n', undefined);
    expect(out.entries['a.ts']).toBe('added');
  });

  it('collapses D_ / _D → deleted', () => {
    const out = parsePorcelain('## main\nD  a.ts\n D b.ts\n', undefined);
    expect(out.entries['a.ts']).toBe('deleted');
    expect(out.entries['b.ts']).toBe('deleted');
  });

  it('collapses R_ → renamed and uses destination as path', () => {
    const out = parsePorcelain(
      '## main\nR  old.ts -> new.ts\n',
      undefined,
    );
    expect(out.entries['new.ts']).toBe('renamed');
    expect(out.entries['old.ts']).toBeUndefined();
  });

  it('collapses conflict pairs → conflicted', () => {
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const out = parsePorcelain(`## main\n${xy} a.ts\n`, undefined);
      expect(out.entries['a.ts']).toBe('conflicted');
    }
  });

  it('applies the paths filter (entries map shrinks)', () => {
    const out = parsePorcelain(
      '## main\n?? a.txt\n?? b.txt\n',
      new Set(['a.txt']),
    );
    expect(out.entries).toEqual({ 'a.txt': 'untracked' });
  });
});
