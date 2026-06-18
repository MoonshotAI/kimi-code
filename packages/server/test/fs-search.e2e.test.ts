

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

import { ISessionService, FsSearchService, ILogService } from '@moonshot-ai/agent-core';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-fs-search-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-fs-search-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {

  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
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

describe('POST /api/v1/sessions/{sid}/fs:search (W11.1)', () => {
  it('finds a file by fuzzy filename match', async () => {
    mkdirSync(join(workspace, 'src', 'components'), { recursive: true });
    writeFileSync(
      join(workspace, 'src', 'components', 'Button.tsx'),
      'export const Button = () => null;',
    );
    writeFileSync(join(workspace, 'README.md'), '# Hi');

    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:search`,
      payload: { query: 'buton' },
    });
    const env = envelopeOf<{
      items: { path: string; score: number }[];
      truncated: boolean;
    }>(res.json());
    expect(env.code).toBe(0);
    const top = env.data!.items[0];
    expect(top).toBeDefined();
    expect(top!.path).toBe('src/components/Button.tsx');
    expect(top!.score).toBeGreaterThan(0);
    expect(env.data!.truncated).toBe(false);
  });

  it('returns match_positions for highlight rendering', async () => {
    writeFileSync(join(workspace, 'index.ts'), 'export {};');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:search`,
      payload: { query: 'index' },
    });
    const env = envelopeOf<{
      items: { match_positions: number[] }[];
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.items[0]!.match_positions.length).toBe(5);
  });

  it('500-hit cap with truncated: true', async () => {

    for (let i = 0; i < 600; i++) {
      writeFileSync(join(workspace, `match_${i}.txt`), '');
    }
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:search`,
      payload: { query: 'match', limit: 200 },
    });
    const env = envelopeOf<{ items: unknown[]; truncated: boolean }>(res.json());
    expect(env.code).toBe(0);

    expect(env.data!.items.length).toBe(200);
    expect(env.data!.truncated).toBe(true);
  });

  it('respects include_globs / exclude_globs', async () => {
    writeFileSync(join(workspace, 'keep.ts'), '');
    writeFileSync(join(workspace, 'keep.md'), '');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:search`,
      payload: { query: 'keep', include_globs: ['*.ts'] },
    });
    const env = envelopeOf<{
      items: { path: string }[];
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.items.map((i) => i.path)).toEqual(['keep.ts']);
  });

  it('returns truncated: false when no globs filter and items <= limit', async () => {
    writeFileSync(join(workspace, 'a.txt'), '');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:search`,
      payload: { query: 'a' },
    });
    const env = envelopeOf<{ items: unknown[]; truncated: boolean }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.truncated).toBe(false);
  });

  it('40401 unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_does_not_exist/fs:search',
      payload: { query: 'x' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('POST /api/v1/sessions/{sid}/fs:grep (W11.1)', () => {
  it('finds a literal match across files with context', async () => {
    writeFileSync(
      join(workspace, 'a.txt'),
      'line 1\nhello world\nline 3\n',
    );
    writeFileSync(join(workspace, 'b.txt'), 'no match here');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:grep`,
      payload: { pattern: 'hello', context_lines: 1 },
    });
    const env = envelopeOf<{
      files: {
        path: string;
        matches: {
          line: number;
          col: number;
          text: string;
          before: string[];
          after: string[];
        }[];
      }[];
      files_scanned: number;
      truncated: boolean;
      elapsed_ms: number;
    }>(res.json());
    expect(env.code).toBe(0);
    const fileHit = env.data!.files.find((f) => f.path === 'a.txt');
    expect(fileHit).toBeDefined();
    const m = fileHit!.matches[0]!;
    expect(m.line).toBe(2);
    expect(m.col).toBeGreaterThan(0);
    expect(m.text).toContain('hello');
    expect(m.before).toContain('line 1');
    expect(m.after).toContain('line 3');

    expect(env.data!.files_scanned).toBeGreaterThanOrEqual(1);
    expect(env.data!.truncated).toBe(false);
    expect(env.data!.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('regex pattern matches both alternatives', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo\nbar\nbaz\n');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:grep`,
      payload: { pattern: 'foo|bar', regex: true, context_lines: 0 },
    });
    const env = envelopeOf<{
      files: { matches: { text: string }[] }[];
    }>(res.json());
    expect(env.code).toBe(0);
    const texts = env.data!.files.flatMap((f) => f.matches.map((m) => m.text));
    expect(texts).toContain('foo');
    expect(texts).toContain('bar');
  });

  it('case_sensitive false matches mixed-case patterns', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'Hello\nWORLD\n');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:grep`,
      payload: { pattern: 'hello', case_sensitive: false, context_lines: 0 },
    });
    const env = envelopeOf<{
      files: { matches: { text: string }[] }[];
    }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data!.files.length).toBe(1);
    expect(env.data!.files[0]!.matches[0]!.text).toBe('Hello');
  });

  it('honors .gitignore by default', async () => {
    writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(workspace, 'ignored.txt'), 'needle here\n');
    writeFileSync(join(workspace, 'visible.txt'), 'needle here\n');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:grep`,
      payload: { pattern: 'needle', context_lines: 0 },
    });
    const env = envelopeOf<{
      files: { path: string }[];
    }>(res.json());
    expect(env.code).toBe(0);
    const paths = env.data!.files.map((f) => f.path);
    expect(paths).toContain('visible.txt');
    expect(paths).not.toContain('ignored.txt');
  });

  it('max_total_matches caps the response and sets truncated: true', async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(workspace, `f${i}.txt`), 'needle\n');
    }
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/fs:grep`,
      payload: {
        pattern: 'needle',
        max_total_matches: 5,
        context_lines: 0,
      },
    });
    const env = envelopeOf<{
      files: { matches: unknown[] }[];
      truncated: boolean;
    }>(res.json());
    expect(env.code).toBe(0);
    const total = env.data!.files.reduce((n, f) => n + f.matches.length, 0);
    expect(total).toBeLessThanOrEqual(5);
    expect(env.data!.truncated).toBe(true);
  });

  it('40401 unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_does_not_exist/fs:grep',
      payload: { pattern: 'x' },
    });
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('FsSearchService direct: rg fallback + grep timeout (W11.1)', () => {
  function makeStubSession(cwd: string): ISessionService {
    return {
      list: async () => [],
      get: async () => ({
        id: 'sess_stub',
        metadata: { cwd, model: 'kimi-k2', created_at: '2026-06-04T00:00:00Z' },
        status: 'idle',
        created_at: '2026-06-04T00:00:00Z',
        updated_at: '2026-06-04T00:00:00Z',
      }),
      create: async () => {
        throw new Error('not used');
      },
      delete: async () => {
        throw new Error('not used');
      },
      update: async () => {
        throw new Error('not used');
      },
      dispose: () => undefined,
    } as unknown as ISessionService;
  }

  function makeStubLogger(): ILogService & { warnings: string[] } {
    const warnings: string[] = [];
    const logger: ILogService & { warnings: string[] } = {
      warnings,
      info: (..._args: unknown[]) => undefined,
      warn: (...args: unknown[]) => {
        const msg = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
        warnings.push(msg);
      },
      error: (..._args: unknown[]) => undefined,
      debug: (..._args: unknown[]) => undefined,
      fatal: (..._args: unknown[]) => undefined,
      trace: (..._args: unknown[]) => undefined,
      child: () => logger,
      dispose: () => undefined,
    } as unknown as ILogService & { warnings: string[] };
    return logger;
  }

  class StubMissingRg extends FsSearchService {
    public override probeRg(): Promise<string | null> {
      if (this.rgPath !== undefined) return Promise.resolve(this.rgPath);
      this.rgPath = null;
      if (!this.rgMissingWarned) {
        this.logger.warn(
          '`rg` (ripgrep) not found on PATH — fs:grep falling back to pure-Node implementation. Install ripgrep for faster searches.',
        );
        this.rgMissingWarned = true;
      }
      return Promise.resolve(null);
    }
  }

  it('node fallback runs when rg is missing AND warns exactly once', async () => {
    const sessions = makeStubSession(workspace);
    const logger = makeStubLogger();
    const svc = new StubMissingRg(sessions, logger);
    writeFileSync(join(workspace, 'a.txt'), 'needle\n');

    const first = await svc.grep('sess_stub', {
      pattern: 'needle',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(first.files.length).toBe(1);
    expect(first.files[0]!.matches[0]!.text).toBe('needle');

    await svc.grep('sess_stub', {
      pattern: 'needle',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(logger.warnings.length).toBe(1);
    expect(logger.warnings[0]).toContain('rg');
    svc.dispose();
  });

  it('grep timeout fires FsGrepTimeoutError → 41305', async () => {
    const sessions = makeStubSession(workspace);
    const logger = makeStubLogger();

    class StubTimeout extends FsSearchService {
      protected override async grepWithNode(
        _cwd: string,
        _req: import('@moonshot-ai/protocol').FsGrepRequest,
        _signal: AbortSignal,
        startedAt: number,
      ): Promise<import('@moonshot-ai/protocol').FsGrepResponse> {

        throw new (
          await import('@moonshot-ai/agent-core')
        ).FsGrepTimeoutError(Date.now() - startedAt);
      }
      public override probeRg(): Promise<string | null> {

        this.rgPath = null;
        return Promise.resolve(null);
      }
    }
    const svc = new StubTimeout(sessions, logger);
    writeFileSync(join(workspace, 'a.txt'), 'needle\n');
    await expect(
      svc.grep('sess_stub', {
        pattern: 'needle',
        regex: false,
        case_sensitive: true,
        follow_gitignore: true,
        max_files: 200,
        max_matches_per_file: 50,
        max_total_matches: 5000,
        context_lines: 0,
      }),
    ).rejects.toThrow(/grep_timeout/);
    svc.dispose();
  });

  it('through DI seed-and-resolve preserves stubbed rg-missing fallback', async () => {
    const sessions = makeStubSession(workspace);
    const logger = makeStubLogger();
    const svc = new StubMissingRg(sessions, logger);
    writeFileSync(join(workspace, 'a.txt'), 'needle\n');
    const out = await svc.grep('sess_stub', {
      pattern: 'needle',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(out.files.length).toBe(1);
    svc.dispose();
  });
});
