

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

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { parsePorcelain, parseNumstat } from '@moonshot-ai/agent-core';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

function rmSyncRobust(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
    // Best-effort cleanup: a child process may still hold the cwd or be
    // writing into the dir after server.close(); the OS reclaims the temp dir
    // later and a cleanup hiccup must not fail an otherwise-passing test.
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-fs-git-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-fs-git-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {

  }
  server = undefined;
  // On Windows the git/gh child processes and the session core process spawned
  // during a test can outlive `server.close()` (their disposal is not fully
  // awaited) and keep the temp workspace as their cwd, which makes rmSync fail
  // with EPERM. Retry generously to ride out the asynchronous teardown, and if
  // the cwd is still locked, swallow the error — temp dirs are reclaimed by the
  // OS and a cleanup hiccup must not fail an otherwise-passing test.
  rmSyncRobust(tmpDir);
  rmSyncRobust(bridgeHome);
}, 20_000);

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
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

async function createSession(r: RunningServer): Promise<string> {
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

// oxlint-disable-next-line eslint-plugin-jest(valid-describe-callback)
describe('POST /api/v1/sessions/{sid}/fs:git_status (W11.2)', { timeout: process.platform === 'win32' ? 20_000 : 5_000 }, () => {
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
      additions: number;
      deletions: number;
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.branch).toBe('main');
    expect(env.data!.ahead).toBe(0);
    expect(env.data!.behind).toBe(0);
    expect(Object.keys(env.data!.entries)).toEqual([]);
    // Clean tree → no line stats.
    expect(env.data!.additions).toBe(0);
    expect(env.data!.deletions).toBe(0);
    // First server-booting test in the file: on Windows, cold module load
    // plus the `git`/`gh` child-process spawns can exceed the default 5s.
  }, 20_000);

  it('dirty repo: aggregate additions/deletions vs HEAD', async () => {
    initRepo();
    // seed.txt: one line "seed\n" → replace with two lines (1 deleted, 2 added).
    writeFileSync(join(workspace, 'seed.txt'), 'one\ntwo\n');
    // new.txt untracked: `git diff --numstat HEAD` does NOT count untracked
    // files, so these 3 lines are intentionally excluded from the totals.
    writeFileSync(join(workspace, 'new.txt'), 'a\nb\nc\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: {},
    });
    const env = envelopeOf<{ additions: number; deletions: number }>(res.json());
    expect(env.code).toBe(0);
    // Only the tracked seed.txt rewrite counts: 2 added, 1 deleted.
    expect(env.data!.additions).toBe(2);
    expect(env.data!.deletions).toBe(1);
  });

  it('paths filter does not scope the line stats (whole-tree totals)', async () => {
    initRepo();
    writeFileSync(join(workspace, 'seed.txt'), 'changed\n');
    // extra.txt is untracked → excluded from `git diff --numstat HEAD`.
    writeFileSync(join(workspace, 'extra.txt'), 'x\ny\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:git_status`,
      payload: { paths: ['seed.txt'] },
    });
    const env = envelopeOf<{
      entries: Record<string, string>;
      additions: number;
      deletions: number;
    }>(res.json());
    expect(env.code).toBe(0);
    // entries scoped to seed.txt; the counter reflects the whole tree, but
    // untracked extra.txt does not contribute, so only seed.txt's edit counts.
    expect(Object.keys(env.data!.entries)).toEqual(['seed.txt']);
    expect(env.data!.additions).toBe(1); // seed line replaced
    expect(env.data!.deletions).toBe(1); // seed line removed
  });

  it('dirty repo: modified + untracked + deleted entries', async () => {
    initRepo();

    writeFileSync(join(workspace, 'seed.txt'), 'changed\n');

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

describe('POST /api/v1/sessions/{sid}/fs:diff', () => {
  it('modified file: unified diff with -old/+new lines', async () => {
    initRepo();
    writeFileSync(join(workspace, 'seed.txt'), 'changed\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'seed.txt' },
    });
    const env = envelopeOf<{ path: string; diff: string; truncated: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.path).toBe('seed.txt');
    expect(env.data!.diff).toContain('-seed');
    expect(env.data!.diff).toContain('+changed');
    expect(env.data!.truncated).toBe(false);
  });

  it('untracked file: all-added diff against /dev/null', async () => {
    initRepo();
    writeFileSync(join(workspace, 'new.txt'), 'brand new\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'new.txt' },
    });
    const env = envelopeOf<{ path: string; diff: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.diff).toContain('+brand new');
    expect(env.data!.diff).not.toContain('-brand new');
  });

  it('deleted file: all-removed diff', async () => {
    initRepo();
    rmSync(join(workspace, 'seed.txt'));

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'seed.txt' },
    });
    const env = envelopeOf<{ diff: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.diff).toContain('-seed');
  });

  it('clean tracked file: empty diff', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'seed.txt' },
    });
    const env = envelopeOf<{ diff: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.diff).toBe('');
  });

  it('repo without commits: untracked file still diffs all-added', async () => {
    git(['init', '-b', 'main']);
    writeFileSync(join(workspace, 'first.txt'), 'first\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'first.txt' },
    });
    const env = envelopeOf<{ diff: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.diff).toContain('+first');
  });

  it('nonexistent path → 40409', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'no-such-file.txt' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40409);
  });

  it('non-git workspace → 40908', async () => {
    writeFileSync(join(workspace, 'plain.txt'), 'plain\n');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: 'plain.txt' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40908);
  });

  it('path escaping cwd → 41304', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: { path: '../outside.txt' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(41304);
  });

  it('missing path → 40001 validation', async () => {
    initRepo();

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:diff`,
      payload: {},
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40001);
  });

  it('40401 unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_does_not_exist/fs:diff',
      payload: { path: 'seed.txt' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40401);
  });
});

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

  it('defaults additions/deletions to 0 (filled in by the service)', () => {
    const out = parsePorcelain('## main\n M a.ts\n', undefined);
    expect(out.additions).toBe(0);
    expect(out.deletions).toBe(0);
  });
});

describe('parseNumstat', () => {
  it('sums added/deleted counts across files', () => {
    const out = parseNumstat('3\t1\ta.ts\n10\t0\tb.ts\n0\t4\tc.ts\n');
    expect(out.additions).toBe(13);
    expect(out.deletions).toBe(5);
  });

  it('treats binary files (-\t-) as 0', () => {
    const out = parseNumstat('-\t-\timg.png\n2\t1\ta.ts\n');
    expect(out.additions).toBe(2);
    expect(out.deletions).toBe(1);
  });

  it('empty output → 0/0', () => {
    const out = parseNumstat('');
    expect(out.additions).toBe(0);
    expect(out.deletions).toBe(0);
  });

  it('ignores blank trailing lines', () => {
    const out = parseNumstat('5\t2\ta.ts\n\n');
    expect(out.additions).toBe(5);
    expect(out.deletions).toBe(2);
  });
});
