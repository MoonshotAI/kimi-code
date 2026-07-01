import { isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ISessionAgentFileSystem } from '#/agentFs';
import { ISessionFsService } from '#/agentFs/fs';
import { SessionFsService } from '#/agentFs/fsService';
import { ISessionProcessRunner, type IProcess } from '#/process';
import { ITelemetryService } from '#/telemetry';
import { ISessionWorkspaceContext } from '#/workspaceContext';

const WORK_DIR = '/repo';

function stubWorkspace(): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: WORK_DIR,
    additionalDirs: [],
    setWorkDir: () => {},
    resolve: (rel) => (isAbsolute(rel) ? rel : resolve(WORK_DIR, rel)),
    isWithin: (abs) => {
      const r = relative(WORK_DIR, abs);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    },
    assertAllowed: (abs) => abs,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function fakeFs(files: Record<string, string>): ISessionAgentFileSystem {
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set<string>(['']);
  for (const p of fileMap.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  const isDir = (p: string): boolean => p === '' || p === '.' || dirSet.has(p);
  const enoent = (p: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  return {
    _serviceBrand: undefined,
    cwd: WORK_DIR,
    readText: async (p) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      return c;
    },
    writeText: async () => {},
    readBytes: async (p, n) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      const buf = Buffer.from(c);
      return buf.subarray(0, n ?? buf.length);
    },
    readLines: async function* (): AsyncGenerator<string> {
      // not needed by the fs surface under test
    },
    writeBytes: async () => {},
    stat: async (p) => {
      if (fileMap.has(p)) {
        return {
          isFile: true,
          isDirectory: false,
          size: fileMap.get(p)!.length,
          mtimeMs: 1000,
          ino: 1,
        };
      }
      if (isDir(p)) {
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 1000, ino: 1 };
      }
      throw enoent(p);
    },
    readdir: async (p) => {
      const prefix = p === '.' || p === '' ? '' : `${p}/`;
      const children = new Set<string>();
      const addChild = (key: string): void => {
        if (key === '' || key === p) return;
        if (!key.startsWith(prefix)) return;
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first !== undefined && first.length > 0) children.add(first);
      };
      for (const f of fileMap.keys()) addChild(f);
      for (const d of dirSet) addChild(d);
      return [...children];
    },
    glob: async () => [],
    mkdir: async (p, options) => {
      const existOk = options?.existOk ?? true;
      if ((dirSet.has(p) || fileMap.has(p)) && !existOk) {
        const err = new Error(`EEXIST: ${p}`) as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      const parents = options?.parents ?? true;
      if (!parents) {
        const parent = p.split('/').slice(0, -1).join('/');
        if (parent !== '' && !isDir(parent)) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      }
      dirSet.add(p);
    },
    withCwd: () => {
      throw new Error('not implemented');
    },
  };
}

function fakeProcess(stdout: string, stderr: string, exitCode: number): IProcess {
  return {
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    pid: 1,
    exitCode,
    wait: () => Promise.resolve(exitCode),
    kill: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

type RunHandler = (args: readonly string[]) => {
  stdout: string;
  stderr?: string;
  exitCode: number;
};

function fakeRunner(handler: RunHandler): ISessionProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: async (args) => {
      const r = handler(args);
      return fakeProcess(r.stdout, r.stderr ?? '', r.exitCode);
    },
  };
}

function telemetryStub(events: Array<{ event: string; properties: Record<string, unknown> }>): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    },
    withContext: () => telemetryStub(events),
    setContext: () => {},
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
}

beforeEach(() => {
  _clearScopedRegistryForTests();
  registerScopedService(
    LifecycleScope.Session,
    ISessionFsService,
    SessionFsService,
    InstantiationType.Delayed,
    'agentFs',
  );
});

let host: ReturnType<typeof createScopedTestHost> | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
});

function makeSession(
  files: Record<string, string>,
  handler: RunHandler,
  events: Array<{ event: string; properties: Record<string, unknown> }> = [],
): ISessionFsService {
  host = createScopedTestHost();
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, stubWorkspace()),
    stubPair(ISessionAgentFileSystem, fakeFs(files)),
    stubPair(ISessionProcessRunner, fakeRunner(handler)),
    stubPair(ITelemetryService, telemetryStub(events)),
  ]);
  return session.accessor.get(ISessionFsService);
}

const emptyHandler: RunHandler = () => ({ stdout: '', exitCode: 0 });

describe('SessionFsService.gitStatus', () => {
  it('returns branch, entries, numstat, and null pull request', async () => {
    const fs = makeSession({}, (args) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return { stdout: 'true\n', exitCode: 0 };
      if (cmd.includes('status --porcelain')) {
        return { stdout: '## main...origin/main\n M src/a.ts\n', exitCode: 0 };
      }
      if (cmd.includes('--verify') && cmd.includes('HEAD')) return { stdout: '', exitCode: 0 };
      if (cmd.includes('--numstat')) return { stdout: '3\t1\tsrc/a.ts\n', exitCode: 0 };
      if (args[0] === 'gh') return { stdout: '', exitCode: 1 };
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.gitStatus({});
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(1);
    expect(result.pullRequest).toBeNull();
  });

  it('throws FS_GIT_UNAVAILABLE when not a git repo', async () => {
    const fs = makeSession({}, () => ({
      stdout: '',
      stderr: 'not a git repository',
      exitCode: 128,
    }));
    await expect(fs.gitStatus({})).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });
});

describe('SessionFsService.diff', () => {
  it('returns the unified diff for a tracked file', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, (args) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return { stdout: 'true\n', exitCode: 0 };
      if (cmd.includes('status --porcelain')) return { stdout: ' M src/a.ts\n', exitCode: 0 };
      if (cmd.includes('--verify') && cmd.includes('HEAD')) return { stdout: '', exitCode: 0 };
      if (cmd.includes('diff') && cmd.includes('HEAD')) {
        return { stdout: '-old\n+new\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.diff({ path: 'src/a.ts' });
    expect(result.path).toBe('src/a.ts');
    expect(result.diff).toContain('+new');
    expect(result.truncated).toBe(false);
  });

  it('rejects paths that escape the workspace', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(fs.diff({ path: '../etc/passwd' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });
});

describe('SessionFsService.search', () => {
  it('finds files by fuzzy query and respects the result cap', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'src/bar.ts': '', 'README.md': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: 'foo', limit: 50, follow_gitignore: false });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).not.toContain('src/bar.ts');
  });
});

describe('SessionFsService.grep', () => {
  it('falls back to the node implementation when rg is unavailable', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fs = makeSession(
      { 'src/a.ts': 'hello world\nfoo bar\nhello again\n' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
      events,
    );
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: false,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches).toHaveLength(2);
    expect(events).toContainEqual({
      event: 'fs_grep_node_fallback',
      properties: { reason: 'rg_missing' },
    });
  });

  it('uses rg when available and parses its JSON output', async () => {
    const rgJson = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'hello world\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
      '',
    ].join('\n');
    const fs = makeSession({}, (args) => {
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 14.1.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--json')) return { stdout: rgJson, exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches[0]?.text).toBe('hello world');
  });
});

describe('SessionFsService.list', () => {
  it('lists files and directories with kinds', async () => {
    const fs = makeSession(
      { 'src/a.ts': '', 'src/sub/b.ts': '', 'README.md': '' },
      emptyHandler,
    );
    const result = await fs.list({
      path: '.',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    const names = result.items.map((i) => i.name).sort();
    expect(names).toEqual(['README.md', 'src']);
    expect(result.items.find((i) => i.name === 'src')?.kind).toBe('directory');
  });

  it('returns children_by_path for depth > 1', async () => {
    const fs = makeSession({ 'src/a.ts': '', 'src/sub/b.ts': '' }, emptyHandler);
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.children_by_path?.['src']?.map((i) => i.name).sort()).toEqual([
      'a.ts',
      'sub',
    ]);
  });

  it('rejects paths that escape the workspace', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(
      fs.list({
        path: '../etc',
        depth: 1,
        limit: 200,
        show_hidden: false,
        follow_gitignore: false,
        sort: 'name_asc',
        include_git_status: false,
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });
});

describe('SessionFsService.read', () => {
  it('reads utf-8 content with metadata', async () => {
    const fs = makeSession({ 'src/a.ts': 'hello\nworld\n' }, emptyHandler);
    const result = await fs.read({
      path: 'src/a.ts',
      offset: 0,
      length: 1024,
      encoding: 'utf-8',
    });
    expect(result.content).toBe('hello\nworld\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.size).toBe('hello\nworld\n'.length);
    expect(result.line_count).toBe(2);
    expect(result.mime).toBe('text/typescript');
    expect(result.is_binary).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('honors offset and length and sets truncated', async () => {
    const fs = makeSession({ 'a.txt': 'hello world' }, emptyHandler);
    const result = await fs.read({ path: 'a.txt', offset: 0, length: 5, encoding: 'utf-8' });
    expect(result.content).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('returns base64 for binary content in auto mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\x00def' }, emptyHandler);
    const result = await fs.read({ path: 'bin.dat', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.encoding).toBe('base64');
    expect(result.is_binary).toBe(true);
    expect(result.content).toBe(Buffer.from('abc\x00def').toString('base64'));
  });

  it('throws fs.is_binary for binary content in utf-8 mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\x00def' }, emptyHandler);
    await expect(
      fs.read({ path: 'bin.dat', offset: 0, length: 1024, encoding: 'utf-8' }),
    ).rejects.toMatchObject({ code: 'fs.is_binary' });
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(
      fs.read({ path: 'src', offset: 0, length: 1024, encoding: 'auto' }),
    ).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});

describe('SessionFsService.stat', () => {
  it('returns a file entry with mime', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler);
    const entry = await fs.stat({ path: 'src/a.ts' });
    expect(entry.kind).toBe('file');
    expect(entry.size).toBe('content'.length);
    expect(entry.mime).toBe('text/typescript');
    expect(entry.name).toBe('a.ts');
  });

  it('throws fs.path_not_found for a missing path', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(fs.stat({ path: 'nope' })).rejects.toMatchObject({ code: 'fs.path_not_found' });
  });
});

describe('SessionFsService.statMany', () => {
  it('returns null per missing path and entries for present ones', async () => {
    const fs = makeSession({ 'a.txt': 'hi' }, emptyHandler);
    const result = await fs.statMany({ paths: ['a.txt', 'missing.txt'] });
    expect(result.entries['a.txt']?.kind).toBe('file');
    expect(result.entries['missing.txt']).toBeNull();
  });
});

describe('SessionFsService.listMany', () => {
  it('returns results per path and partial_errors for failures', async () => {
    const fs = makeSession({ 'a.txt': '' }, emptyHandler);
    const result = await fs.listMany({
      paths: ['.', 'missing'],
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.results['.']?.map((i) => i.name)).toContain('a.txt');
    expect(result.partial_errors?.['missing']).toMatchObject({ code: 40409 });
  });
});

describe('SessionFsService.mkdir', () => {
  it('creates a directory and returns its entry', async () => {
    const fs = makeSession({}, emptyHandler);
    const entry = await fs.mkdir({ path: 'newdir', recursive: false });
    expect(entry.kind).toBe('directory');
    expect(entry.name).toBe('newdir');
  });

  it('throws fs.already_exists when the directory exists (non-recursive)', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(fs.mkdir({ path: 'src', recursive: false })).rejects.toMatchObject({
      code: 'fs.already_exists',
    });
  });
});

describe('SessionFsService.resolvePath', () => {
  it('returns absolute, relative, and isDirectory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    const res = await fs.resolvePath('src/a.ts');
    expect(res.relative).toBe('src/a.ts');
    expect(res.isDirectory).toBe(false);
    expect(res.absolute).toContain('src/a.ts');
  });
});

describe('SessionFsService.resolveDownload', () => {
  it('returns size, etag, mime, modifiedAt', async () => {
    const fs = makeSession({ 'a.txt': 'hello' }, emptyHandler);
    const res = await fs.resolveDownload('a.txt');
    expect(res.size).toBe('hello'.length);
    expect(res.mime).toBe('text/plain');
    expect(res.etag).toBeTypeOf('string');
    expect(res.modifiedAt).toBeInstanceOf(Date);
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(fs.resolveDownload('src')).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});
