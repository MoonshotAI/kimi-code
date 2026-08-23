import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { ErrorCodes, Error2 } from '#/errors';
import { type HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ITelemetryService, type TelemetryProperties } from '#/app/telemetry/telemetry';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';

const WORK_DIR = '/repo';

function stubWorkspaceContext(): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'w',
    cwd: WORK_DIR,
    source: 'local',
    meta: { id: 'w', root: WORK_DIR, name: 'proj', createdAt: 1, lastOpenedAt: 1 },
    persistenceScope: 'sessions/w',
  };
}

function stubWorkspaceDirs(): IWorkspaceDirs {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    additionalDirs: [],
    onDidChange: () => ({ dispose: () => {} }),
    addDir: () => Promise.reject(new Error('not supported in tests')),
    mergeAdditionalDirs: () => Promise.resolve(),
    sessionInfo: () => {
      throw new Error('not supported in tests');
    },
  };
}

function workspaceGitStub(git: IGitService): IWorkspaceGitService {
  return {
    _serviceBrand: undefined,
    status: (filter) => git.status(WORK_DIR, filter),
    diff: (rel, abs) => git.diff(WORK_DIR, rel, abs),
  };
}

function fakeFs(
  files: Record<string, string | Buffer>,
  symlinks: readonly string[] = [],
  symlinkTargets: Record<string, string> = {},
): IHostFileSystem {
  const fileMap = new Map<string, string | Buffer>();
  const dirSet = new Set<string>([WORK_DIR]);
  const addAncestors = (rel: string): void => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(join(WORK_DIR, parts.slice(0, i).join('/')));
    }
  };
  for (const [rel, content] of Object.entries(files)) {
    fileMap.set(join(WORK_DIR, rel), content);
    addAncestors(rel);
  }
  const symlinkSet = new Set<string>();
  for (const rel of symlinks) {
    symlinkSet.add(join(WORK_DIR, rel));
    addAncestors(rel);
  }
  const symlinkTargetMap = new Map<string, string>();
  for (const [rel, target] of Object.entries(symlinkTargets)) {
    const abs = join(WORK_DIR, rel);
    symlinkTargetMap.set(abs, target);
    symlinkSet.add(abs);
    addAncestors(rel);
  }
  const isDir = (p: string): boolean => p === WORK_DIR || dirSet.has(p);
  const enoent = (p: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  const lstatImpl = async (p: string) => {
    if (fileMap.has(p)) {
      const c = fileMap.get(p)!;
      return {
        isFile: true,
        isDirectory: false,
        size: Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c),
        mtimeMs: 1000,
        ino: 1,
      };
    }
    if (symlinkSet.has(p)) {
      return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: 1000, ino: 1 };
    }
    if (isDir(p)) {
      return { isFile: false, isDirectory: true, size: 0, mtimeMs: 1000, ino: 1 };
    }
    throw enoent(p);
  };
  return {
    _serviceBrand: undefined,
    readText: async (p) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      return typeof c === 'string' ? c : c.toString('utf8');
    },
    writeText: async () => {},
    appendText: async () => {},
    readBytes: async (p, n) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      return buf.subarray(0, n ?? buf.length);
    },
    readLines: async function* (): AsyncGenerator<string> {
    },
    writeBytes: async () => {},
    createExclusive: async () => false,
    lstat: lstatImpl,
    stat: async (p) => {
      let cur = p;
      for (let hops = 0; hops < 10 && symlinkSet.has(cur); hops += 1) {
        const target = symlinkTargetMap.get(cur);
        if (target === undefined) break;
        cur = isAbsolute(target) ? target : join(cur, '..', target);
      }
      return lstatImpl(cur);
    },
    readdir: async (p) => {
      if (!isDir(p)) throw enoent(p);
      const prefix = `${p}/`;
      const children = new Map<string, HostDirEntry>();
      const addDir = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: false, isDirectory: true });
        }
      };
      const addFile = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: true, isDirectory: false });
        }
      };
      const addSymlink = (name: string): void => {
        if (!children.has(name)) {
          children.set(name, { name, isFile: false, isDirectory: false, isSymbolicLink: true });
        }
      };
      const visit = (key: string, kind: 'file' | 'dir' | 'symlink'): void => {
        if (key === p || !key.startsWith(prefix)) return;
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first === undefined || first.length === 0) return;
        if (rest.includes('/')) addDir(first);
        else if (kind === 'symlink') addSymlink(first);
        else if (kind === 'file') addFile(first);
        else addDir(first);
      };
      for (const d of dirSet) visit(d, 'dir');
      for (const f of fileMap.keys()) visit(f, 'file');
      for (const s of symlinkSet) visit(s, 'symlink');
      return [...children.values()];
    },
    mkdir: async (p, options) => {
      const recursive = options?.recursive ?? false;
      const exists = isDir(p) || fileMap.has(p);
      if (recursive) {
        let current = p;
        while (current !== WORK_DIR && current.length > WORK_DIR.length) {
          dirSet.add(current);
          const next = current.slice(0, current.lastIndexOf('/'));
          if (next === current || next === '') break;
          current = next;
        }
        dirSet.add(p);
        return;
      }
      if (exists) {
        const err = new Error(`EEXIST: ${p}`) as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent !== '' && parent !== WORK_DIR && !isDir(parent)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      dirSet.add(p);
    },
    remove: async () => {},
    realpath: async (p) => {
      let current = p;
      for (let i = 0; i < 40; i++) {
        let longest: string | undefined;
        for (const linkPath of symlinkTargetMap.keys()) {
          if (
            (current === linkPath || current.startsWith(`${linkPath}/`)) &&
            (longest === undefined || linkPath.length > longest.length)
          ) {
            longest = linkPath;
          }
        }
        if (longest === undefined) {
          if (current === p) {
            if (p === WORK_DIR || fileMap.has(p) || isDir(p) || symlinkSet.has(p)) return p;
            throw enoent(p);
          }
          return current;
        }
        current = symlinkTargetMap.get(longest)! + current.slice(longest.length);
      }
      return current;
    },
  };
}

function fakeProcess(stdout: string, stderr: string, exitCode: number): IHostProcess {
  return {
    _serviceBrand: undefined,
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

function fakeRunner(handler: RunHandler): IHostProcessService {
  return {
    _serviceBrand: undefined,
    spawn: async (command, args) => {
      const r = handler([command, ...(args ?? [])]);
      return fakeProcess(r.stdout, r.stderr ?? '', r.exitCode);
    },
  };
}

function makeStreamingProcess(lines: readonly string[]): {
  proc: IHostProcess;
  wasKilled: () => boolean;
  yieldedLines: () => number;
} {
  let killed = false;
  let yielded = 0;
  let resolveWait: (code: number) => void = () => {};
  const waitP = new Promise<number>((res) => {
    resolveWait = res;
  });
  async function* gen(): AsyncGenerator<string> {
    for (const line of lines) {
      if (killed) break;
      yielded += 1;
      yield `${line}\n`;
      await new Promise((r) => setImmediate(r));
    }
    resolveWait(0);
  }
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from(gen()),
    stderr: Readable.from(['']),
    pid: 1,
    exitCode: null,
    wait: () => waitP,
    kill: async () => {
      killed = true;
      resolveWait(0);
    },
    dispose: () => undefined,
  };
  return { proc, wasKilled: () => killed, yieldedLines: () => yielded };
}

function telemetryStub(events: Array<{ event: string; properties: Record<string, unknown> }>): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: (event: string, properties?: TelemetryProperties) => {
      events.push({ event, properties: properties ?? {} });
    },
    track2: (event, properties) => {
      events.push({ event, properties: (properties as TelemetryProperties | undefined) ?? {} });
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
    'program',
    IWorkspaceFsService,
    WorkspaceFsService,
    ScopeActivation.OnDemand,
    'workspaceFs',
  );
});

let host: ReturnType<typeof createScopedTestHost> | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
});

function defaultGitStub(): IGitService {
  return {
    _serviceBrand: undefined,
    status: async () => ({
      branch: '',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    }),
    diff: async () => ({ path: '', diff: '', truncated: false }),
    findWorkTree: async () => null,
  };
}

function makeSession(
  files: Record<string, string | Buffer>,
  handler: RunHandler,
  events: Array<{ event: string; properties: Record<string, unknown> }> = [],
  git: IGitService = defaultGitStub(),
  symlinks: readonly string[] = [],
  runner?: IHostProcessService,
  symlinkTargets: Record<string, string> = {},
): IWorkspaceFsService {
  host = createScopedTestHost([
    stubPair(IHostEnvironment, {
      _serviceBrand: undefined,
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/home/test',
      ready: Promise.resolve(),
    }),
  ]);
  const runtime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: 'test' }, { capabilities: ['process'] });
  Object.defineProperty(runtime, 'process', { value: runner ?? fakeRunner(handler) });
  host.app.instantiation.provide(IRuntimeResolver, {
    _serviceBrand: undefined,
    inspect: () => runtime,
    acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
  });
  const workspace = host.child('program', 'w1', [
    stubPair(IWorkspaceContext, stubWorkspaceContext()),
    stubPair(IWorkspaceDirs, stubWorkspaceDirs()),
    stubPair(IHostFileSystem, fakeFs(files, symlinks, symlinkTargets)),
    stubPair(IHostProcessService, runner ?? fakeRunner(handler)),
    stubPair(ITelemetryService, telemetryStub(events)),
    stubPair(IWorkspaceGitService, workspaceGitStub(git)),
  ]);
  return workspace.accessor.get(IWorkspaceFsService);
}

const emptyHandler: RunHandler = () => ({ stdout: '', exitCode: 0 });

describe('WorkspaceFsService.gitStatus', () => {
  it('delegates to IWorkspaceGitService with the handler root and a confined filter', async () => {
    const calls: Array<{ cwd: string; filter: ReadonlySet<string> | undefined }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd, filter) => {
        calls.push({ cwd, filter });
        return {
          branch: 'main',
          ahead: 0,
          behind: 0,
          entries: { 'src/a.ts': 'modified' },
          additions: 3,
          deletions: 1,
          pullRequest: null,
        };
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    const result = await fs.gitStatus({ paths: ['src/a.ts'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(WORK_DIR);
    expect(calls[0]?.filter).toEqual(new Set(['src/a.ts']));
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
    expect(result.additions).toBe(3);
  });

  it('propagates FS_GIT_UNAVAILABLE thrown by IGitService', async () => {
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => {
        throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'git unavailable at /repo: not a repo');
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    await expect(fs.gitStatus({})).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });
});

describe('WorkspaceFsService.diff', () => {
  it('delegates to IWorkspaceGitService with confined rel and abs paths', async () => {
    const calls: Array<{ cwd: string; rel: string; abs: string }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      }),
      diff: async (cwd, rel, abs) => {
        calls.push({ cwd, rel, abs });
        return { path: rel, diff: '-old\n+new\n', truncated: false };
      },
      findWorkTree: async () => null,
    };
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler, [], git);
    const result = await fs.diff({ path: 'src/a.ts' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(WORK_DIR);
    expect(calls[0]?.rel).toBe('src/a.ts');
    expect(calls[0]?.abs).toBe(resolve(WORK_DIR, 'src/a.ts'));
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

describe('WorkspaceFsService.search', () => {
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

  it('reports symlinks as kind symlink and does not recurse into them', async () => {
    const fs = makeSession(
      { 'src/real.ts': '', 'src/target/inside.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      ['src/link'],
    );
    const result = await fs.search({ query: 'link', limit: 50, follow_gitignore: false });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/link');
    expect(result.items.find((i) => i.path === 'src/link')?.kind).toBe('symlink');
    expect(paths.some((p) => p.startsWith('src/link/'))).toBe(false);
  });

  it('lists the workspace root top-level entries when the query is empty', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'src/nested/deep.ts': '', 'README.md': '', '.hidden.ts': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: '', limit: 50, follow_gitignore: false });
    expect(result.items.map((i) => i.path)).toEqual(['src', 'README.md']);
    expect(result.items[0]).toMatchObject({
      name: 'src',
      kind: 'directory',
      score: 1,
      match_positions: [],
    });
    expect(result.truncated).toBe(false);
  });

  it('truncates the empty-query listing at the limit', async () => {
    const fs = makeSession({ 'a.ts': '', 'b.ts': '', 'c.ts': '' }, emptyHandler);
    const result = await fs.search({ query: '', limit: 2, follow_gitignore: false });
    expect(result.items.map((i) => i.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(true);
  });

  it('respects .gitignore in the empty-query listing', async () => {
    const fs = makeSession(
      { '.gitignore': 'ignored.ts\n', 'ignored.ts': '', 'kept.ts': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: '', limit: 50, follow_gitignore: true });
    expect(result.items.map((i) => i.path)).toEqual(['kept.ts']);
  });
});

describe('WorkspaceFsService.suggest', () => {
  function rgLinesHandler(lines: readonly string[], captured?: string[][]): RunHandler {
    return (args) => {
      captured?.push([...args]);
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--files')) {
        return { stdout: lines.map((l) => `${l}\n`).join(''), exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };
  }

  function rgMissingHandler(args: readonly string[]): { stdout: string; exitCode: number } {
    if (args[0] === 'rg' && args[1] === '--version') return { stdout: '', exitCode: 1 };
    return { stdout: '', exitCode: 0 };
  }

  it('matches path segments in order and ranks the matched directory first', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'apps/mobile/app.ts', 'src/api/index.ts']),
    );
    const result = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]).toMatchObject({
      path: 'apps/desktop',
      name: 'desktop',
      kind: 'directory',
    });
    expect(result.items.map((i) => i.path)).toContain('apps/desktop/package.json');
  });

  it('allows skipping segments when consuming the query', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'src/api/index.ts']),
    );
    const result = await fs.suggest({
      query: 'ap/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps/desktop');
    expect(result.items.map((i) => i.path)).toContain('src/api/index.ts');
  });

  it('matches a file several segments deep', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/desktop/package.json']));
    const result = await fs.suggest({
      query: 'apps/pack',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('apps/desktop/package.json');
  });

  it('ignores an empty last query segment', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json', 'src/app.ts']),
    );
    const result = await fs.suggest({
      query: 'apps/',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps');
  });

  it('returns an empty list when a path-form query has no match', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/desktop/package.json']));
    const result = await fs.suggest({
      query: 'zzz/qqq',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('matches basenames across the whole workspace in name mode', async () => {
    const fs = makeSession({}, rgLinesHandler(['docs/README.md', 'src/app.ts']));
    const result = await fs.suggest({
      query: 'readme',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual(['docs/README.md']);
    expect(result.items[0]).toMatchObject({ name: 'README.md', kind: 'file' });
    expect(result.items[0]?.match_positions).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('ranks a shallow prefix hit before a deeper one and varies scores', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/index.ts', 'src/deep/api.ts']));
    const result = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('apps');
    expect(paths.indexOf('apps')).toBeLessThan(paths.indexOf('src/deep/api.ts'));
    expect(new Set(result.items.map((i) => i.score)).size).toBeGreaterThan(1);
  });

  it('ranks an exact short hit before weaker longer or deeper hits', async () => {
    const fs = makeSession({}, rgLinesHandler(['apps/x.ts', 'xapps/y.ts']));
    const result = await fs.suggest({
      query: 'apps',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items[0]?.path).toBe('apps');
  });

  it('passes gitignore and hidden flags to rg', async () => {
    const captured: string[][] = [];
    const fs = makeSession({}, rgLinesHandler([], captured));
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: true, show_hidden: true });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('--no-require-git');
    expect(filesArgs).toContain('--hidden');
    expect(filesArgs).not.toContain('--no-ignore');
    expect(filesArgs).toContain('!.git/**');
  });

  it('passes --no-ignore to rg when follow_gitignore is false', async () => {
    const captured: string[][] = [];
    const fs = makeSession({}, rgLinesHandler([], captured));
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: false, show_hidden: false });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('--no-ignore');
    expect(filesArgs).not.toContain('--no-require-git');
    expect(filesArgs).not.toContain('--hidden');
  });

  it('hides dot-prefixed entries at any depth unless show_hidden is set', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['visible.ts', '.env.ts', 'sub/.secret/x.ts']),
    );
    const off = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(off.items.map((i) => i.path)).toEqual(['visible.ts']);
    const on = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(on.items.map((i) => i.path)).toContain('.env.ts');
    expect(on.items.map((i) => i.path)).toContain('sub/.secret/x.ts');
  });

  it('never returns VCS metadata entries even with show_hidden', async () => {
    const fs = makeSession({}, rgLinesHandler(['.git/x.ts', 'src/.jj/y.ts', 'ok.ts']));
    const result = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(result.items.map((i) => i.path)).toEqual(['ok.ts']);
  });

  it('lists root entries for an empty query and never lists VCS dirs', async () => {
    const fs = makeSession(
      { 'kept.ts': '', '.hidden.ts': '', '.git/config': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      ['link'],
    );
    const shown = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: false,
      show_hidden: true,
    });
    const paths = shown.items.map((i) => i.path);
    expect(paths).toContain('.hidden.ts');
    expect(paths).toContain('kept.ts');
    expect(paths).not.toContain('.git');
    expect(shown.items.find((i) => i.path === 'link')?.kind).toBe('symlink');

    const hidden = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: false,
      show_hidden: false,
    });
    expect(hidden.items.map((i) => i.path)).not.toContain('.hidden.ts');
  });

  it('truncates at the limit and reports it', async () => {
    const fs = makeSession({}, rgLinesHandler(['a1.ts', 'a2.ts', 'a3.ts', 'a4.ts']));
    const result = await fs.suggest({
      query: 'a',
      limit: 2,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('applies include_globs and exclude_globs after matching', async () => {
    const fs = makeSession({}, rgLinesHandler(['src/a.ts', 'src/a.md', 'dist/a.ts']));
    const included = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
      include_globs: ['**/*.ts'],
    });
    expect(included.items.map((i) => i.path)).toContain('src/a.ts');
    expect(included.items.map((i) => i.path)).not.toContain('src/a.md');
    const excluded = await fs.suggest({
      query: 'a',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
      exclude_globs: ['dist/**'],
    });
    expect(excluded.items.map((i) => i.path)).not.toContain('dist/a.ts');
  });

  it('falls back to the node walk when rg is unavailable', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fs = makeSession(
      {
        'src/foo.ts': '',
        'src/nested/bar.ts': '',
        '.gitignore': 'ignored.ts\n',
        'ignored.ts': '',
      },
      rgMissingHandler,
      events,
      defaultGitStub(),
      ['src/link'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_missing' },
    });

    const pathResult = await fs.suggest({
      query: 'src/nested',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(pathResult.items.map((i) => i.path)).toContain('src/nested/bar.ts');

    const linkResult = await fs.suggest({
      query: 'link',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(linkResult.items.find((i) => i.path === 'src/link')?.kind).toBe('symlink');
    expect(linkResult.items.some((i) => i.path.startsWith('src/link/'))).toBe(false);

    const ignored = await fs.suggest({
      query: 'ignored',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(ignored.items.map((i) => i.path)).not.toContain('ignored.ts');
  });

  it('hides dot entries in the fallback walk unless show_hidden is set', async () => {
    const fs = makeSession({ '.secret.ts': '', 'plain.ts': '' }, rgMissingHandler);
    const off = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(off.items.map((i) => i.path)).toEqual(['plain.ts']);
    const on = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: true,
    });
    expect(on.items.map((i) => i.path)).toContain('.secret.ts');
  });

  it('falls back to the node walk when rg fails to spawn', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const all = [command, ...(args ?? [])];
        if (all[0] === 'rg' && all[1] === '--version') {
          return fakeProcess('ripgrep 15.0.0', '', 0);
        }
        throw new Error('spawn EAGAIN');
      },
    };
    const fs = makeSession({ 'src/foo.ts': '' }, emptyHandler, events, defaultGitStub(), [], runner);
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_error' },
    });
  });

  it('falls back to the node walk when rg exits with an error status', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const all = [command, ...(args ?? [])];
        if (all[0] === 'rg' && all[1] === '--version') {
          return fakeProcess('ripgrep 15.0.0', '', 0);
        }
        return fakeProcess('', 'permission denied', 2);
      },
    };
    const fs = makeSession({ 'src/foo.ts': '' }, emptyHandler, events, defaultGitStub(), [], runner);
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toContain('src/foo.ts');
    expect(events).toContainEqual({
      event: 'fs_suggest_node_fallback',
      properties: { reason: 'rg_error' },
    });
  });

  it('filters the root listing before applying the limit', async () => {
    const fs = makeSession({ 'aaa/x.ts': '', 'y.ts': '', 'z.ts': '' }, emptyHandler);
    const result = await fs.suggest({
      query: '',
      limit: 1,
      follow_gitignore: true,
      show_hidden: false,
      include_globs: ['**/*.ts'],
    });
    expect(result.items.map((i) => i.path)).toEqual(['y.ts']);
    expect(result.truncated).toBe(true);
  });
});

describe('WorkspaceFsService.grep', () => {
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

  it('stops rg as soon as max_total_matches is reached', async () => {
    const TOTAL = 200;
    const CAP = 5;
    const lines: string[] = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'big.ts' } } }),
    ];
    for (let i = 0; i < TOTAL; i++) {
      lines.push(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: 'big.ts' },
            lines: { text: `hit ${i}\n` },
            line_number: i + 1,
            submatches: [{ start: 0, end: 3 }],
          },
        }),
      );
    }
    lines.push(JSON.stringify({ type: 'end', data: { path: { text: 'big.ts' } } }));

    let streaming: ReturnType<typeof makeStreamingProcess> | undefined;
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (command, args) => {
        const allArgs = [command, ...(args ?? [])];
        if (allArgs[0] === 'rg' && allArgs[1] === '--version') {
          return fakeProcess('ripgrep 14.1.0', '', 0);
        }
        streaming = makeStreamingProcess(lines);
        return streaming.proc;
      },
    };
    const fs = makeSession({}, emptyHandler, [], defaultGitStub(), [], runner);
    const result = await fs.grep({
      pattern: 'hit',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: CAP,
      context_lines: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.matches).toHaveLength(CAP);
    expect(streaming?.wasKilled()).toBe(true);
    expect(streaming?.yieldedLines()).toBeLessThan(TOTAL);
  });
});

describe('WorkspaceFsService.list', () => {
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

describe('WorkspaceFsService.read', () => {
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

  it('transcodes UTF-16 text with a BOM instead of throwing fs.is_binary', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\nworld\n', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(result.content).toBe('hello\nworld\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
    expect(result.line_count).toBe(2);
    expect(result.mime).toBe('text/plain');
    expect(result.truncated).toBe(false);
  });

  it('transcodes BOM-less UTF-16 text in auto mode', async () => {
    const fs = makeSession({ 'notes.txt': Buffer.from('hello\n', 'utf16le') }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.content).toBe('hello\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('transcodes BOM-marked UTF-16 content that never looks binary (CJK-only)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好世界', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(result.content).toBe('你好世界');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('windows the decoded UTF-8 bytes when transcoding', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello world', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 5, encoding: 'utf-8' });
    expect(result.content).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('keeps raw bytes for base64 requests on UTF-16 files', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
    const fs = makeSession({ 'notes.txt': utf16 }, emptyHandler);
    const result = await fs.read({ path: 'notes.txt', offset: 0, length: 1024, encoding: 'base64' });
    expect(result.encoding).toBe('base64');
    expect(result.is_binary).toBe(true);
    expect(result.content).toBe(utf16.toString('base64'));
  });

  it('reads UTF-8 Chinese log content as text instead of throwing fs.is_binary', async () => {
    const log = '2026-08-16 INFO 启动完成 ✅\n2026-08-16 INFO 处理请求 🚀 成功\n'.repeat(50);
    const fs = makeSession({ 'app.log': log }, emptyHandler);
    const result = await fs.read({
      path: 'app.log',
      offset: 0,
      length: 1024 * 1024,
      encoding: 'utf-8',
    });
    expect(result.content).toBe(log);
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
    expect(result.mime).toBe('text/plain');
    expect(result.truncated).toBe(false);
  });

  it('returns utf-8 rather than base64 for UTF-8 Chinese text in auto mode', async () => {
    const fs = makeSession({ 'app.log': '中文日志 ✅\n' }, emptyHandler);
    const result = await fs.read({ path: 'app.log', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.content).toBe('中文日志 ✅\n');
    expect(result.encoding).toBe('utf-8');
    expect(result.is_binary).toBe(false);
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(
      fs.read({ path: 'src', offset: 0, length: 1024, encoding: 'auto' }),
    ).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});

describe('WorkspaceFsService.stat', () => {
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

describe('WorkspaceFsService.statMany', () => {
  it('returns null per missing path and entries for present ones', async () => {
    const fs = makeSession({ 'a.txt': 'hi' }, emptyHandler);
    const result = await fs.statMany({ paths: ['a.txt', 'missing.txt'] });
    expect(result.entries['a.txt']?.kind).toBe('file');
    expect(result.entries['missing.txt']).toBeNull();
  });
});

describe('WorkspaceFsService.listMany', () => {
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

describe('WorkspaceFsService.mkdir', () => {
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

describe('WorkspaceFsService.resolvePath', () => {
  it('returns absolute, relative, and isDirectory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    const res = await fs.resolvePath('src/a.ts');
    expect(res.relative).toBe('src/a.ts');
    expect(res.isDirectory).toBe(false);
    expect(res.absolute).toContain('src/a.ts');
  });
});

describe('WorkspaceFsService.resolveDownload', () => {
  it('returns size, etag, mime, modifiedAt', async () => {
    const fs = makeSession({ 'a.txt': 'hello' }, emptyHandler);
    const res = await fs.resolveDownload('a.txt');
    expect(res.size).toBe('hello'.length);
    expect(res.mime).toBe('text/plain');
    expect(res.etag).toBeTypeOf('string');
    expect(res.modifiedAt).toBeInstanceOf(Date);
  });

  it('resolves a UTF-8 Chinese log as text/plain', async () => {
    const fs = makeSession({ 'app.log': '启动完成 ✅ 中文日志内容\n'.repeat(20) }, emptyHandler);
    const res = await fs.resolveDownload('app.log');
    expect(res.mime).toBe('text/plain');
  });

  it('throws fs.is_directory for a directory', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);
    await expect(fs.resolveDownload('src')).rejects.toMatchObject({ code: 'fs.is_directory' });
  });
});

describe('WorkspaceFsService symlink confinement', () => {
  const escapeTargets = { docs: '/outside' };

  function escapeSession(): IWorkspaceFsService {
    return makeSession(
      { 'src/a.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      escapeTargets,
    );
  }

  it('rejects reads that escape through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(
      fs.read({ path: 'docs/secret.txt', offset: 0, length: 1024, encoding: 'utf-8' }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('rejects list through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(
      fs.list({
        path: 'docs',
        depth: 1,
        limit: 200,
        show_hidden: false,
        follow_gitignore: false,
        sort: 'name_asc',
        include_git_status: false,
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('rejects stat, mkdir, resolvePath and resolveDownload through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(fs.stat({ path: 'docs/secret.txt' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.mkdir({ path: 'docs/newdir', recursive: true })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.resolvePath('docs/secret.txt')).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(fs.resolveDownload('docs/secret.txt')).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });

  it('rejects statMany when any path escapes through a symlinked directory', async () => {
    const fs = escapeSession();
    await expect(fs.statMany({ paths: ['docs/secret.txt'] })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });

  it('still allows a symlink whose target stays inside the workspace', async () => {
    const fs = makeSession(
      { 'real/a.txt': 'hi' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { link: '/repo/real' },
    );
    const entry = await fs.stat({ path: 'link' });
    expect(entry.kind).toBe('symlink');
  });

  it('still resolves ordinary in-workspace paths', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, emptyHandler);
    const res = await fs.read({ path: 'src/a.ts', offset: 0, length: 1024, encoding: 'utf-8' });
    expect(res.content).toBe('content');
  });
});
