import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { ErrorCodes, Error2 } from '#/errors';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { HandshakeError } from '#/remote/client/connection';
import { type HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError } from '#/os/interface/hostFsErrors';
import { walkHostDirectory } from '#/os/interface/hostFsWalk';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import { WorkspaceFsService } from '#/workspace/workspaceFs/fsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
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
    meta: { id: 'w', root: WORK_DIR, name: 'proj', kind: 'implicit', createdAt: 1, lastOpenedAt: 1 },
    persistenceScope: 'sessions/w',
  };
}

function stubWorkspaceDirs(additionalDirs: readonly string[] = []): IWorkspaceDirs {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    additionalDirs: [...additionalDirs],
    sharedAdditionalDirs: [...additionalDirs],
    primaryByWorkspace: {},
    onDidChange: () => ({ dispose: () => {} }),
    addDir: () => Promise.reject(new Error('not supported in tests')),
    mergeAdditionalDirs: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    sessionInfo: () => {
      throw new Error('not supported in tests');
    },
  };
}

function workspaceGitStub(git: IGitService): IWorkspaceGitService {
  return {
    _serviceBrand: undefined,
    status: (pathFilter) => git.status(WORK_DIR, { pathFilter }),
    statusAt: (cwd, options) => git.status(cwd, options),
    pullRequestAt: (cwd) => git.pullRequest(cwd),
    diff: (rel, abs) => git.diff(WORK_DIR, rel, abs),
    diffAt: (cwd, rel, abs) => git.diff(cwd, rel, abs),
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
  const addAbsAncestors = (abs: string): void => {
    let dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
    while (dir.length > 0 && !dirSet.has(dir)) {
      dirSet.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  };
  for (const [rel, content] of Object.entries(files)) {
    if (rel.startsWith('/')) {
      fileMap.set(rel, content);
      addAbsAncestors(rel);
    } else {
      fileMap.set(join(WORK_DIR, rel), content);
      addAncestors(rel);
    }
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
  const resolveSymlinks = (p: string): string => {
    let cur = p;
    for (let hops = 0; hops < 10; hops += 1) {
      let longest: string | undefined;
      for (const linkPath of symlinkTargetMap.keys()) {
        if (
          (cur === linkPath || cur.startsWith(`${linkPath}/`)) &&
          (longest === undefined || linkPath.length > longest.length)
        ) {
          longest = linkPath;
        }
      }
      if (longest === undefined) return cur;
      const target = symlinkTargetMap.get(longest)!;
      const resolvedTarget = isAbsolute(target) ? target : join(longest, '..', target);
      cur = `${resolvedTarget}${cur.slice(longest.length)}`;
    }
    return cur;
  };
  const resolveParentSymlinks = (p: string): string => {
    const slash = p.lastIndexOf('/');
    if (slash <= 0) return p;
    return `${resolveSymlinks(p.slice(0, slash))}${p.slice(slash)}`;
  };
  const lstatImpl = async (rawPath: string) => {
    const p = resolveParentSymlinks(rawPath);
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
  const fs: IHostFileSystem = {
    _serviceBrand: undefined,
    readText: async (p) => {
      const c = fileMap.get(resolveSymlinks(p));
      if (c === undefined) throw enoent(p);
      return typeof c === 'string' ? c : c.toString('utf8');
    },
    writeText: async () => {},
    appendText: async () => {},
    readBytes: async (p, n, offset = 0) => {
      const c = fileMap.get(resolveSymlinks(p));
      if (c === undefined) throw enoent(p);
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      return buf.subarray(offset, n === undefined ? buf.length : offset + n);
    },
    readLines: async function* (): AsyncGenerator<string> {
    },
    writeBytes: async () => {},
    createExclusive: async () => false,
    lstat: lstatImpl,
    stat: async (p) => lstatImpl(resolveSymlinks(p)),
    readdir: async (p) => {
      const dir = resolveSymlinks(p);
      if (!isDir(dir)) throw enoent(p);
      const prefix = `${dir}/`;
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
        if (key === dir || !key.startsWith(prefix)) return;
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
    walk: (path, options) => walkHostDirectory(fs, path, options),
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
  return fs;
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
    track: (event, properties) => {
      events.push({ event, properties: properties ?? {} });
    },
    track2: (event, properties) => {
      events.push({ event, properties: (properties as TelemetryProperties | undefined) ?? {} });
    },
    withContext: () => telemetryStub(events),
    setContext: () => {},
    getContext: () => ({}),
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
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
    pullRequest: async () => null,
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
  additionalDirs: readonly string[] = [],
  pathClass: 'posix' | 'win32' = 'posix',
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
  const environment = new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'], pathClass });
  Object.defineProperty(environment, 'process', { value: runner ?? fakeRunner(handler) });
  host.app.instantiation.provide(IEnvironmentService, resolverFor(environment));
  const workspace = host.child('program', 'w1', [
    stubPair(IWorkspaceContext, stubWorkspaceContext()),
    stubPair(IWorkspaceDirs, stubWorkspaceDirs(additionalDirs)),
    stubPair(IHostFileSystem, fakeFs(files, symlinks, symlinkTargets)),
    stubPair(IHostProcessService, runner ?? fakeRunner(handler)),
    stubPair(ITelemetryService, telemetryStub(events)),
    stubPair(IWorkspaceGitService, workspaceGitStub(git)),
  ]);
  return workspace.accessor.get(IWorkspaceFsService);
}

const emptyHandler: RunHandler = () => ({ stdout: '', exitCode: 0 });

function resolverFor(environment: FakeEnvironment): EnvironmentResolver {
  return {
    _serviceBrand: undefined,
    inspect: () => environment,
    acquire: () => ({ environment, track: (resource) => resource, dispose: () => {} }),
    acquireWhenReady: async () => ({ environment, track: (resource) => resource, dispose: () => {} }),
  };
}

function makeRemoteSession(
  files: Record<string, string | Buffer>,
  handler: RunHandler,
  events: Array<{ event: string; properties: Record<string, unknown> }> = [],
  environmentId = 'ssh-dev',
  homeDir = '/home/target',
  hostFs?: IHostFileSystem,
): IWorkspaceFsService {
  const environment = new FakeEnvironment(
    { environmentId, generation: 'test' },
    { capabilities: ['process'], host: { homeDir } },
  );
  Object.defineProperty(environment, 'process', { value: fakeRunner(handler) });
  const resolver = resolverFor(environment);
  return new WorkspaceFsService(
    stubWorkspaceContext(),
    stubWorkspaceDirs(),
    hostFs ?? fakeFs(files),
    resolver,
    telemetryStub(events),
    workspaceGitStub(defaultGitStub()),
    environmentId,
  );
}

describe('WorkspaceFsService.gitStatus', () => {
  it('delegates to IWorkspaceGitService with the handler root and a confined filter', async () => {
    const calls: Array<{ cwd: string; options: { pathFilter?: ReadonlySet<string>; scopeToCwd?: boolean } | undefined }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd, options) => {
        calls.push({ cwd, options });
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
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    const result = await fs.gitStatus({ paths: ['src/a.ts'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(WORK_DIR);
    expect(calls[0]?.options?.pathFilter).toEqual(new Set(['src/a.ts']));
    expect(calls[0]?.options?.scopeToCwd).toBe(false);
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
    expect(result.additions).toBe(3);
  });

  it('delegates a selected additional root with cwd scoping', async () => {
    const calls: Array<{ cwd: string; options: { scopeToCwd?: boolean } | undefined }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd, options) => {
        calls.push({ cwd, options });
        return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({ '/extra/placeholder': '' }, emptyHandler, [], git, [], undefined, {}, ['/extra']);

    await fs.gitStatus({ root: '/extra' });
    await fs.gitStatus({ root: '/extra', include_pull_request: false });

    expect(calls).toEqual([
      { cwd: '/extra', options: { pathFilter: undefined, scopeToCwd: true, includePullRequest: true } },
      { cwd: '/extra', options: { pathFilter: undefined, scopeToCwd: true, includePullRequest: false } },
    ]);
  });

  it('resolves status filters from the selected root', async () => {
    const calls: Array<{ options: { pathFilter?: ReadonlySet<string> } | undefined }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (_cwd, options) => {
        calls.push({ options });
        return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession(
      { 'sub/link/file.ts': '', '/outside/file.ts': '' },
      emptyHandler,
      [],
      git,
      ['/repo/link'],
      undefined,
      { '/repo/link': '/outside' },
    );

    await fs.gitStatus({ root: 'sub', paths: ['link/file.ts'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.pathFilter).toEqual(new Set(['link/file.ts']));
  });

  it('rejects roots outside the workspace and roots that are files', async () => {
    const fs = makeSession({ 'src/a.ts': '' }, emptyHandler);

    await expect(fs.gitStatus({ root: '/outside' })).rejects.toMatchObject({ code: 'fs.path_escapes' });
    await expect(fs.gitStatus({ root: 'src/a.ts' })).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });

  it('allows a registered filesystem root as a Git root', async () => {
    const calls: string[] = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd) => {
        calls.push(cwd);
        return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({ '/placeholder': '' }, emptyHandler, [], git, [], undefined, {}, ['/']);

    await fs.gitStatus({ root: '/' });
    await fs.gitStatusBatch({ roots: ['/'], include_pull_request: false });

    expect(calls).toEqual(['/', '/']);
  });

  it('propagates FS_GIT_UNAVAILABLE thrown by IGitService', async () => {
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => {
        throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'git unavailable at /repo: not a repo');
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({}, emptyHandler, [], git);
    await expect(fs.gitStatus({})).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });
});

describe('WorkspaceFsService git batches', () => {
  it('returns independent results and errors with bounded concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    let statusCalls = 0;
    const optionsSeen: Array<{ includePullRequest?: boolean } | undefined> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd, options) => {
        statusCalls += 1;
        optionsSeen.push(options);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        if (cwd === '/b') throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'not a repo');
        return { branch: `branch-${cwd.slice(1)}`, ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
      },
      pullRequest: async (cwd) => {
        if (cwd === '/b') throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'not a repo');
        return cwd === '/a' ? { number: 7, state: 'open', url: 'https://example.com/pull/7' } : null;
      },
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const fs = makeSession(
      { '/a/placeholder': '', '/b/placeholder': '', '/c/placeholder': '' },
      emptyHandler,
      [],
      git,
      [],
      undefined,
      {},
      ['/a', '/b', '/c'],
    );

    const status = await fs.gitStatusBatch({ roots: ['/a', '/b', '/c', '/a'], include_pull_request: false });

    expect(statusCalls).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(optionsSeen.every(options => options?.includePullRequest === false)).toBe(true);
    expect(Object.keys(status.results)).toEqual(['/a', '/c']);
    expect(status.results['/a']?.branch).toBe('branch-a');
    expect(status.results['/c']?.branch).toBe('branch-c');
    expect(status.errors['/b']).toEqual({ code: 40908, msg: 'not a repo' });

    const pullRequests = await fs.pullRequestBatch({ roots: ['/a', '/b', '/c'] });
    expect(pullRequests.results['/a']).toEqual({ number: 7, state: 'open', url: 'https://example.com/pull/7' });
    expect(pullRequests.results['/c']).toBeNull();
    expect(pullRequests.errors['/b']).toEqual({ code: 40908, msg: 'not a repo' });
  });

  it('preserves special root names and established batch error codes', async () => {
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async (cwd) => {
        if (cwd === '/missing-env') throw new EnvironmentError('environment.not_found', 'missing');
        if (cwd === '/invalid-cwd') throw new EnvironmentError('environment.invalid_cwd', 'invalid');
        if (cwd === '/conflict') throw new EnvironmentError('environment.conflict', 'conflict');
        if (cwd === '/unavailable') throw new EnvironmentError('environment.unavailable', 'unavailable');
        if (cwd === '/handshake') throw new HandshakeError('handshake');
        return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
      },
      pullRequest: async () => null,
      diff: async () => ({ path: '', diff: '', truncated: false }),
      findWorkTree: async () => null,
    };
    const roots = ['__proto__', '/missing-env', '/invalid-cwd', '/conflict', '/unavailable', '/handshake'];
    const files = Object.fromEntries(roots.filter(root => root.startsWith('/')).map(root => [`${root}/placeholder`, '']));
    const fs = makeSession(
      { '__proto__/placeholder': '', ...files },
      emptyHandler,
      [],
      git,
      [],
      undefined,
      {},
      roots.filter(root => root.startsWith('/')),
    );

    const status = await fs.gitStatusBatch({ roots: [...roots, '/outside'], include_pull_request: false });

    expect(Object.hasOwn(status.results, '__proto__')).toBe(true);
    expect(JSON.stringify(status.results)).toContain('"__proto__"');
    expect(status.errors).toEqual({
      '/outside': { code: 41304, msg: 'path "/outside" escapes workspace' },
      '/missing-env': { code: 40420, msg: 'missing' },
      '/invalid-cwd': { code: 40001, msg: 'invalid' },
      '/conflict': { code: 40901, msg: 'conflict' },
      '/unavailable': { code: 40926, msg: 'unavailable' },
      '/handshake': { code: 40926, msg: 'handshake' },
    });
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
      pullRequest: async () => null,
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

  it('delegates file diff using the selected additional root', async () => {
    const calls: Array<{ cwd: string; rel: string; abs: string }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => ({ branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null }),
      diff: async (cwd, rel, abs) => {
        calls.push({ cwd, rel, abs });
        return { path: rel, diff: '-old\n+new\n', truncated: false };
      },
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({ '/extra/src/a.ts': 'content' }, emptyHandler, [], git, [], undefined, {}, ['/extra']);

    const result = await fs.diff({ root: '/extra', path: 'src/a.ts' });

    expect(calls).toEqual([{ cwd: '/extra', rel: 'src/a.ts', abs: '/extra/src/a.ts' }]);
    expect(result.path).toBe('src/a.ts');
  });

  it('preserves rootless diffs for allowed sibling directories', async () => {
    const calls: Array<{ cwd: string; rel: string; abs: string }> = [];
    const git: IGitService = {
      _serviceBrand: undefined,
      status: async () => ({ branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null }),
      diff: async (cwd, rel, abs) => {
        calls.push({ cwd, rel, abs });
        return { path: rel, diff: '-old\n+new\n', truncated: false };
      },
      pullRequest: async () => null,
      findWorkTree: async () => null,
    };
    const fs = makeSession({ '/extra/src/a.ts': 'content' }, emptyHandler, [], git, [], undefined, {}, ['/extra']);

    const result = await fs.diff({ path: '/extra/src/a.ts' });

    expect(calls).toEqual([{ cwd: WORK_DIR, rel: '../extra/src/a.ts', abs: '/extra/src/a.ts' }]);
    expect(result.diff).toContain('+new');
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

  it('keeps the original deep-directory boundary', async () => {
    const files: Record<string, string> = {};
    let current = 'root';
    files[`${current}/match.ts`] = '';
    for (let depth = 1; depth <= 66; depth += 1) {
      current = `${current}/level-${depth}`;
      if (depth === 63 || depth === 64 || depth === 65) files[`${current}/match.ts`] = '';
    }
    const fs = makeSession(files, emptyHandler);
    const deepPath = Array.from({ length: 63 }, (_, index) => `level-${index + 1}`).join('/');

    const result = await fs.search({ query: 'match', limit: 50, follow_gitignore: false });

    expect(result.items.map((item) => item.path).toSorted()).toEqual([
      'root/match.ts',
      `root/${deepPath}/match.ts`,
    ].toSorted());
    expect(result.items.some((item) => item.path.includes('level-64/'))).toBe(false);
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

  it('searches additional roots with absolute result paths', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', '/extra/lib/foo.ts': '', '/extra/top.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );

    const matches = await fs.search({ query: 'foo', limit: 50, follow_gitignore: false });
    expect(matches.items.map((item) => item.path)).toContain('src/foo.ts');
    expect(matches.items.map((item) => item.path)).toContain('/extra/lib/foo.ts');

    const topLevel = await fs.search({ query: '', limit: 50, follow_gitignore: false });
    expect(topLevel.items.map((item) => item.path)).toContain('src');
    expect(topLevel.items.map((item) => item.path)).toContain('/extra/top.ts');
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
    if (args[1] === '--version') return { stdout: '', exitCode: 1 };
    return { stdout: '', exitCode: 0 };
  }

  function rgMultiRootHandler(perRoot: Record<string, readonly string[]>, captured?: string[][]): RunHandler {
    return (args) => {
      captured?.push([...args]);
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--files')) {
        const lines: string[] = [];
        for (const arg of args) {
          const rootLines = perRoot[arg];
          if (rootLines !== undefined) {
            for (const line of rootLines) lines.push(`${arg === '/' ? '' : arg}/${line}`);
          }
        }
        return { stdout: lines.map((l) => `${l}\n`).join(''), exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };
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

  it('passes ignore rules to the walk and reports inventory truncation', async () => {
    const backend = fakeFs({
      '.gitignore': 'node_modules/\n',
      'src/app.ts': '',
      'node_modules/pkg/index.ts': '',
    });
    let receivedIgnore: readonly string[] | undefined;
    backend.walk = async (_path, options) => {
      receivedIgnore = options.ignore;
      return { entries: [], errors: [], truncated: true, responseBytes: 64 };
    };
    const fs = makeRemoteSession(
      { '.gitignore': 'node_modules/\n' },
      () => ({ stdout: '', exitCode: 127 }),
      [],
      'ssh-dev',
      '/home/target',
      backend,
    );

    const result = await fs.suggest({
      query: 'app',
      limit: 50,
      show_hidden: false,
      follow_gitignore: true,
    });

    expect(receivedIgnore).toEqual(['.git/', 'node_modules/', '']);
    expect(result).toEqual({ items: [], truncated: true });
  });

  it('keeps matching and file enumeration order when using batched walks', async () => {
    const backend = fakeFs({
      '.git/config': 'hello\n',
      'a/first.ts': 'hello\n',
      'a/nested/second.ts': 'hello\n',
      'z.ts': 'hello\n',
    });
    const readdir = backend.readdir.bind(backend);
    const reads: string[] = [];
    backend.readdir = async (path) => {
      reads.push(path);
      return readdir(path);
    };
    const fs = makeRemoteSession(
      {},
      () => ({ stdout: '', exitCode: 127 }),
      [],
      'ssh-dev',
      '/home/target',
      backend,
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

    expect(result.files.map((file) => file.path)).toEqual([
      'a/nested/second.ts',
      'a/first.ts',
      'z.ts',
    ]);
    expect(result.files.some((file) => file.path.startsWith('.git/'))).toBe(false);
    expect(reads).toEqual(['/repo', '/repo/a', '/repo/a/nested']);
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

  it('keeps valid roots available when an additional root is missing', async () => {
    const fs = makeSession(
      { 'src/a.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/missing'],
    );

    const result = await fs.suggest({ query: '', limit: 50, follow_gitignore: false, show_hidden: false });

    expect(result.items.map((item) => item.path)).toEqual(['src']);
  });

  it('merges rg candidates across roots with relative paths for the primary root only', async () => {
    const fs = makeSession(
      {
        'apps/desktop/package.json': '',
        '/extra/lib/util.ts': '',
        '/extra/README.md': '',
      },
      rgMultiRootHandler({
        '/repo': ['apps/desktop/package.json'],
        '/extra': ['lib/util.ts', 'README.md'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const pathResult = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(pathResult.items[0]?.path).toBe('apps/desktop');
    const nameResult = await fs.suggest({
      query: 'util',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(nameResult.items.map((i) => i.path)).toContain('/extra/lib/util.ts');
    const readme = await fs.suggest({
      query: 'readme',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const item = readme.items.find((i) => i.path === '/extra/README.md');
    expect(item?.match_positions).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('passes every root to rg as a path argument', async () => {
    const captured: string[][] = [];
    const fs = makeSession(
      { '/extra/x.ts': '' },
      rgMultiRootHandler({ '/repo': [], '/extra': ['x.ts'] }, captured),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    await fs.suggest({ query: 'x', limit: 50, follow_gitignore: true, show_hidden: false });
    const filesArgs = captured.find((a) => a.includes('--files'))!;
    expect(filesArgs).toContain('/repo');
    expect(filesArgs).toContain('/extra');
  });

  it('parses multi-root rg output joined with the windows path separator', async () => {
    const fs = makeSession(
      { 'src/a.ts': '', '/extra/lib/util.ts': '' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
        if (args[0] === 'rg' && args.includes('--files')) {
          return { stdout: '/repo\\src\\a.ts\n/extra\\lib\\util.ts\n', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
      'win32',
    );
    const primary = await fs.suggest({ query: 'a.ts', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(primary.items.map((i) => i.path)).toContain('src/a.ts');
    const extra = await fs.suggest({ query: 'util', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(extra.items.map((i) => i.path)).toContain('/extra/lib/util.ts');
  });

  it('parses single-root rg output joined with the windows path separator', async () => {
    const fs = makeSession(
      { 'src/a.ts': '' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: 'ripgrep 15.0.0', exitCode: 0 };
        if (args[0] === 'rg' && args.includes('--files')) {
          return { stdout: 'src\\a.ts\n', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      [],
      'win32',
    );
    const result = await fs.suggest({ query: 'a.ts', limit: 50, follow_gitignore: true, show_hidden: false });
    expect(result.items.map((i) => i.path)).toContain('src/a.ts');
  });

  it('deduplicates candidates when roots overlap', async () => {
    const fs = makeSession(
      { 'src/a.ts': '', '/other.ts': '' },
      rgMultiRootHandler({
        '/repo': ['src/a.ts'],
        '/': ['repo/src/a.ts', 'other.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/'],
    );
    const result = await fs.suggest({
      query: 'ts',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths.filter((p) => p === 'src/a.ts')).toHaveLength(1);
    expect(paths).toContain('/other.ts');
  });

  it('skips an additional root contained in the primary root', async () => {
    const fs = makeSession(
      {},
      rgLinesHandler(['apps/desktop/package.json']),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/repo/apps'],
    );
    const result = await fs.suggest({
      query: 'apps/de',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.filter((i) => i.path === 'apps/desktop')).toHaveLength(1);
  });

  it('does not treat dot segments of an additional root itself as hidden', async () => {
    const fs = makeSession(
      { '/x/.config/kimi/foo.ts': '' },
      rgMultiRootHandler({
        '/repo': [],
        '/x/.config/kimi': ['foo.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/x/.config/kimi'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual(['/x/.config/kimi/foo.ts']);
  });

  it('applies the limit to the merged ranking across roots', async () => {
    const fs = makeSession(
      { 'a1.ts': '', '/extra/a2.ts': '', '/extra/a3.ts': '' },
      rgMultiRootHandler({
        '/repo': ['a1.ts'],
        '/extra': ['a2.ts', 'a3.ts'],
      }),
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: 'a',
      limit: 2,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('merges node-fallback candidates across roots with per-root gitignore', async () => {
    const fs = makeSession(
      {
        'src/foo.ts': '',
        '/extra/lib/foo-util.ts': '',
        '/extra/.gitignore': 'skip.ts\n',
        '/extra/skip.ts': '',
      },
      rgMissingHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: 'foo',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('/extra/lib/foo-util.ts');
    const skipped = await fs.suggest({
      query: 'skip',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(skipped.items.map((i) => i.path)).toEqual([]);
  });

  it('keeps partial candidates at the shared deadline without walking later roots', async () => {
    const backend = fakeFs({ 'src/foo.ts': '', '/extra/foo-extra.ts': '' });
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let deadline: number | undefined;
    const roots: string[] = [];
    backend.walk = async (path, options) => {
      roots.push(path);
      deadline = options.deadlineMs;
      clock += 10_000;
      return {
        entries: [
          { name: '/repo/src', isFile: false, isDirectory: true },
          { name: '/repo/src/foo.ts', isFile: true, isDirectory: false },
        ],
        errors: [],
        truncated: true,
        responseBytes: 128,
      };
    };
    try {
      const fs = makeRemoteSession({}, () => ({ stdout: '', exitCode: 127 }), [], 'ssh-dev', '/home/target', backend);
      Object.defineProperty(fs, 'suggestRoots', {
        value: async () => [
          { dir: WORK_DIR, real: WORK_DIR, primary: true },
          { dir: '/extra', real: '/extra', primary: false },
        ],
      });

      const result = await fs.suggest({
        query: 'foo',
        limit: 50,
        follow_gitignore: false,
        show_hidden: false,
      });

      expect(result.items.map((item) => item.path)).toEqual(['src/foo.ts']);
      expect(result.truncated).toBe(true);
      expect(roots).toEqual([WORK_DIR]);
      expect(deadline).toBe(11_000);
    } finally {
      now.mockRestore();
    }
  });

  it('does not restart the suggest budget after the rg attempt', async () => {
    const backend = fakeFs({ 'src/foo.ts': '' });
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let deadline: number | undefined;
    backend.walk = async (_path, options) => {
      deadline = options.deadlineMs;
      return { entries: [], errors: [], truncated: false, responseBytes: 64 };
    };
    const runner: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (_command, args) => {
        if (args?.[0] === '--version') return fakeProcess('ripgrep 15.0.0', '', 0);
        clock += 4_000;
        throw new Error('spawn failed');
      },
    };
    try {
      const fs = makeRemoteSession({}, emptyHandler, [], 'ssh-dev', '/home/target', backend);
      Object.defineProperty(fs, 'resolver', {
        value: {
          acquire: () => ({
            environment: { process: runner },
            track: (resource: unknown) => resource,
            dispose: () => {},
          }),
        },
      });
      Object.defineProperty(fs, 'rgResolution', { value: { path: 'rg' } });

      await fs.suggest({ query: 'foo', limit: 50, follow_gitignore: false, show_hidden: false });

      expect(deadline).toBe(11_000);
    } finally {
      now.mockRestore();
    }
  });

  it('lists top-level entries of every root for an empty query', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'README.md': '', '/extra/lib/util.ts': '', '/extra/notes.md': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.suggest({
      query: '',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(result.items.map((i) => i.path)).toEqual([
      'src',
      'README.md',
      '/extra/lib',
      '/extra/notes.md',
    ]);
    expect(result.truncated).toBe(false);
  });
});

describe('WorkspaceFsService.grep', () => {
  it('falls back to the node implementation when rg is unavailable', async () => {
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fs = makeSession(
      { 'src/a.ts': 'hello world\nfoo bar\nhello again\n' },
      (args) => {
        if (args[1] === '--version') return { stdout: '', exitCode: 1 };
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

  it('searches additional roots with rg and preserves unambiguous paths', async () => {
    const rgFile = (path: string, text: string): string => [
      { type: 'begin', data: { path: { text: path } } },
      {
        type: 'match',
        data: {
          path: { text: path },
          lines: { text: `${text}\n` },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      },
      { type: 'end', data: { path: { text: path } } },
    ].map((record) => JSON.stringify(record)).join('\n');
    const captured: string[][] = [];
    const fs = makeSession(
      {},
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') {
          return { stdout: 'ripgrep 14.1.0', exitCode: 0 };
        }
        if (args[0] === 'rg' && args.includes('--json')) {
          captured.push([...args]);
          return {
            stdout: `${rgFile('src/a.ts', 'hello a')}\n${rgFile('/extra/b.ts', 'hello b')}\n`,
            exitCode: 0,
          };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );

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

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('.');
    expect(captured[0]).toContain('/extra');
    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts', '/extra/b.ts']);
  });

  it('deduplicates primary files emitted through an overlapping ancestor root', async () => {
    const rgFile = (path: string, text: string): string => [
      { type: 'begin', data: { path: { text: path } } },
      {
        type: 'match',
        data: {
          path: { text: path },
          lines: { text: `${text}\n` },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      },
      { type: 'end', data: { path: { text: path } } },
    ].map((record) => JSON.stringify(record)).join('\n');
    const fs = makeSession(
      {},
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') {
          return { stdout: 'ripgrep 14.1.0', exitCode: 0 };
        }
        if (args[0] === 'rg' && args.includes('--json')) {
          return {
            stdout: [
              rgFile('src/a.ts', 'hello primary'),
              rgFile('/repo/src/a.ts', 'hello duplicate'),
              rgFile('/other.ts', 'hello other'),
            ].join('\n') + '\n',
            exitCode: 0,
          };
        }
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/'],
    );

    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 2,
      max_matches_per_file: 50,
      max_total_matches: 2,
      context_lines: 0,
    });

    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts', '/other.ts']);
    expect(result.files_scanned).toBe(2);
  });

  it('searches additional roots in the Node fallback', async () => {
    const fs = makeSession(
      { 'src/a.ts': 'hello primary\n', '/extra/b.ts': 'hello extra\n' },
      (args) => {
        if (args[1] === '--version') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
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

    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts', '/extra/b.ts']);
    expect(result.files_scanned).toBe(2);
  });

  it('distinguishes partial matches from an empty timed-out inventory', async () => {
    const backend = fakeFs({ 'src/a.ts': 'hello primary\n', '/extra/b.ts': 'hello extra\n' });
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const roots: string[] = [];
    backend.walk = async (path) => {
      roots.push(path);
      clock += 30_000;
      return {
        entries: [
          { name: '/repo/src', isFile: false, isDirectory: true },
          { name: '/repo/src/a.ts', isFile: true, isDirectory: false },
        ],
        errors: [],
        truncated: true,
        responseBytes: 128,
      };
    };
    try {
      const fs = makeRemoteSession({}, () => ({ stdout: '', exitCode: 127 }), [], 'ssh-dev', '/home/target', backend);
      Object.defineProperty(fs, 'suggestRoots', {
        value: async () => [
          { dir: WORK_DIR, real: WORK_DIR, primary: true },
          { dir: '/extra', real: '/extra', primary: false },
        ],
      });

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

      expect(result.files.map((file) => file.path)).toEqual(['src/a.ts']);
      expect(result.files_scanned).toBe(1);
      expect(result.truncated).toBe(true);
      expect(roots).toEqual([WORK_DIR]);
      backend.walk = async () => {
        clock += 30_000;
        return { entries: [], errors: [], truncated: true, responseBytes: 64 };
      };
      await expect(fs.grep({
        pattern: 'hello',
        regex: false,
        case_sensitive: true,
        follow_gitignore: false,
        max_files: 200,
        max_matches_per_file: 50,
        max_total_matches: 5000,
        context_lines: 0,
      })).rejects.toMatchObject({
        code: ErrorCodes.FS_GREP_TIMEOUT,
        message: 'grep timed out after 30000ms',
      });
    } finally {
      now.mockRestore();
    }
  });
});

describe('WorkspaceFsService.list', () => {
  it.each(['list', 'suggest'] as const)('rejects an oversized nested directory during %s', async (operation) => {
    const backend = fakeFs({ 'huge/hidden.txt': '', 'visible.txt': '' });
    const readdir = backend.readdir;
    backend.readdir = async (path) => {
      if (path === '/repo/huge') {
        throw new HostFsError('os.fs.directory_too_large', 'Directory /repo/huge exceeds 50000 entries');
      }
      return readdir(path);
    };
    const fs = makeRemoteSession({}, () => ({ stdout: '', exitCode: 127 }), [], 'ssh-dev', '/home/target', backend);

    const result = operation === 'list'
      ? fs.list({ path: '.', depth: 2, limit: 200, show_hidden: false, follow_gitignore: false, sort: 'name_asc', include_git_status: false })
      : fs.suggest({ query: 'hidden', limit: 50, show_hidden: false, follow_gitignore: false });

    await expect(result).rejects.toMatchObject({
      code: 'fs.too_many_results',
      message: 'Directory /repo/huge exceeds 50000 entries',
    });
  });

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
    const names = result.items.map((i) => i.name).toSorted();
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
    expect(result.children_by_path?.['src']?.map((i) => i.name).toSorted()).toEqual([
      'a.ts',
      'sub',
    ]);
  });

  it('marks in-workspace symlink directories as expandable and recurses into them', async () => {
    const fs = makeSession(
      { 'real/a.txt': '', 'real/sub/b.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {
        link: '/repo/real',
        fileLink: '/repo/real/a.txt',
        broken: '/repo/missing',
      },
    );
    const result = await fs.list({
      path: '.',
      depth: 3,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.find((i) => i.path === 'link')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(result.items.find((i) => i.path === 'fileLink')?.is_directory).toBeUndefined();
    expect(result.items.find((i) => i.path === 'broken')?.is_directory).toBeUndefined();
    expect(result.children_by_path?.['link']?.map((i) => i.name).toSorted()).toEqual([
      'a.txt',
      'sub',
    ]);
    expect(result.children_by_path?.['link/sub']?.map((i) => i.name)).toEqual(['b.ts']);
  });

  it('lists the direct path of an in-workspace symlink directory', async () => {
    const fs = makeSession(
      { 'real/a.txt': '', 'real/sub/b.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { link: '/repo/real' },
    );
    const result = await fs.list({
      path: 'link',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.map((i) => i.name).toSorted()).toEqual(['a.txt', 'sub']);
  });

  it('does not mark symlink directories outside the workspace as expandable', async () => {
    const fs = makeSession(
      {},
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { docs: '/outside' },
    );
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.find((i) => i.path === 'docs')).toMatchObject({ kind: 'symlink' });
    expect(result.items.find((i) => i.path === 'docs')?.is_directory).toBeUndefined();
    expect(result.children_by_path?.['docs']).toBeUndefined();
  });

  it('expands and reads external symlink directories when explicitly allowed', async () => {
    const fs = makeSession(
      { '/outside/secret.txt': 'secret' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { docs: '/outside' },
    );
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      allow_external_symlinks: true,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.find((i) => i.path === 'docs')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(result.children_by_path?.['docs']?.map((i) => i.name)).toEqual(['secret.txt']);

    const children = await fs.list({
      path: 'docs',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      allow_external_symlinks: true,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(children.items.map((i) => i.name)).toEqual(['secret.txt']);

    const read = await fs.read({
      path: 'docs/secret.txt',
      offset: 0,
      length: 1024,
      encoding: 'utf-8',
      allow_external_symlinks: true,
    });
    expect(read.content).toBe('secret');

    const download = await fs.resolveDownload('docs/secret.txt', true);
    expect(download.absolute).toBe('/repo/docs/secret.txt');
    expect(download.size).toBe(6);
  });

  it('marks symlink directories inside additional dirs as expandable', async () => {
    const fs = makeSession(
      { '/extra/lib/util.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { extra: '/extra' },
      ['/extra'],
    );
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.find((i) => i.path === 'extra')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(result.children_by_path?.['extra']?.map((i) => i.name)).toEqual(['lib']);
  });

  it('does not recurse through symlink cycles', async () => {
    const fs = makeSession(
      { 'real/a.txt': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { loop: '/repo' },
    );
    const result = await fs.list({
      path: '.',
      depth: 3,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.find((i) => i.path === 'loop')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(result.children_by_path?.['loop']).toBeUndefined();
    expect(Object.keys(result.children_by_path ?? {}).some((key) => key.startsWith('loop/'))).toBe(
      false,
    );
  });

  it('keeps recursive children when the top-level limit is smaller', async () => {
    const fs = makeSession({ 'dir/a.txt': '', 'dir/b.txt': '' }, emptyHandler);
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 1,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.children_by_path?.['dir']?.map((i) => i.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('does not cap ordinary recursive directory results', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10_001; index += 1) {
      files[`bulk/file-${String(index).padStart(5, '0')}.txt`] = '';
    }
    const fs = makeSession(files, emptyHandler);
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(false);
    expect(result.children_by_path?.['bulk']).toHaveLength(10_001);
  });

  it('does not count file symlinks in ordinary directories toward the budget', async () => {
    const symlinks = Array.from(
      { length: 10_001 },
      (_, index) => `bulk/link-${String(index).padStart(5, '0')}.txt`,
    );
    const fs = makeSession(
      {},
      emptyHandler,
      [],
      defaultGitStub(),
      symlinks,
    );
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(false);
    expect(result.children_by_path?.['bulk']).toHaveLength(10_001);
  });

  it('stops recursive symlink expansion at the request-wide output budget', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10_001; index += 1) {
      files[`real/bulk/file-${String(index).padStart(5, '0')}.txt`] = '';
    }
    const fs = makeSession(
      files,
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { link: '/repo/real' },
    );
    const result = await fs.list({
      path: '.',
      depth: 3,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(true);
    const symlinkDescendantEntries = Object.entries(result.children_by_path ?? {})
      .filter(([path]) => path === 'link' || path.startsWith('link/'))
      .reduce((total, [, entries]) => total + entries.length, 0);
    expect(symlinkDescendantEntries).toBe(10_000);
    expect(result.children_by_path?.['real/bulk']).toHaveLength(10_001);

    const direct = await fs.list({
      path: 'link',
      depth: 2,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(direct.truncated).toBe(true);
    expect(
      Object.values(direct.children_by_path ?? {}).reduce(
        (total, entries) => total + entries.length,
        0,
      ),
    ).toBe(9_999);
  });

  it('counts a symlinked workspace root toward the budget', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10_001; index += 1) {
      files[`/repo-real/bulk/file-${String(index).padStart(5, '0')}.txt`] = '';
    }
    const fs = makeSession(
      files,
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { '': '/repo-real' },
    );
    const result = await fs.list({
      path: '.',
      depth: 2,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(true);
    expect(result.children_by_path?.['bulk']).toHaveLength(9_999);
  });

  it('counts symlinks in intermediate root path segments', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10_001; index += 1) {
      files[`real/sub/deep/file-${String(index).padStart(5, '0')}.txt`] = '';
    }
    const fs = makeSession(
      files,
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { link: '/repo/real' },
    );
    const result = await fs.list({
      path: 'link/sub',
      depth: 2,
      limit: 1000,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.truncated).toBe(true);
    expect(result.children_by_path?.['link/sub/deep']).toHaveLength(9_999);
  });

  it('finds allowed descendants through external symlinks in ignored directories', async () => {
    const fs = makeSession(
      { '.gitignore': 'ignored/\n', '/outside/keep.txt': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { 'ignored/link': '/outside' },
    );
    const request = {
      path: '.',
      depth: 3,
      limit: 200,
      show_hidden: false,
      follow_gitignore: true,
      allow_ignored_globs: ['ignored/link/keep.txt'],
      sort: 'name_asc' as const,
      include_git_status: false,
    };
    const denied = await fs.list(request);
    expect(denied.items.map((i) => i.path)).not.toContain('ignored');

    const allowed = await fs.list({ ...request, allow_external_symlinks: true });
    expect(allowed.items.map((i) => i.path)).toContain('ignored');
    expect(allowed.children_by_path?.['ignored/link']?.map((i) => i.name)).toEqual(['keep.txt']);
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

  it('lists an additional workspace root by absolute path with request-anchored keys', async () => {
    const fs = makeSession(
      { '/extra/notes.md': '', '/extra/sub/more.ts': '', 'src/a.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.list({
      path: '/extra',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.map((i) => i.path).toSorted()).toEqual(['notes.md', 'sub']);
    expect(result.children_by_path?.['sub']?.map((i) => i.path)).toEqual(['sub/more.ts']);

    const sub = await fs.list({
      path: '/extra/sub',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(sub.items.map((i) => i.path)).toEqual(['sub/more.ts']);
  });

  it('expands a symlink directory under an additional root with request-anchored paths', async () => {
    const fs = makeSession(
      { '/extra/real/a.txt': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      { '../extra/link': '/extra/real' },
      ['/extra'],
    );

    const result = await fs.list({
      path: '/extra',
      depth: 2,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });

    expect(result.items.find((item) => item.path === 'link')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(result.children_by_path?.['link']?.map((item) => item.path)).toEqual(['link/a.txt']);
  });

  it('anchors at an additional root whose path length ties with the workdir', async () => {
    const fs = makeSession(
      { '/repa/notes.md': '', 'src/a.ts': '' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/repa'],
    );
    const result = await fs.list({
      path: '/repa',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: false,
      sort: 'name_asc',
      include_git_status: false,
    });
    expect(result.items.map((i) => i.path)).toEqual(['notes.md']);
  });

  it('rejects absolute paths outside the workspace dir set', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(
      fs.list({
        path: '/etc',
        depth: 1,
        limit: 200,
        show_hidden: false,
        follow_gitignore: false,
        sort: 'name_asc',
        include_git_status: false,
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('reads a file under an additional workspace root by absolute path', async () => {
    const fs = makeSession(
      { '/extra/notes.md': 'hello\n' },
      emptyHandler,
      [],
      defaultGitStub(),
      [],
      undefined,
      {},
      ['/extra'],
    );
    const result = await fs.stat({ path: '/extra/notes.md' });
    expect(result.name).toBe('notes.md');
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

  it('honors a non-zero offset window', async () => {
    const fs = makeSession({ 'a.txt': 'hello world' }, emptyHandler);
    const result = await fs.read({ path: 'a.txt', offset: 6, length: 5, encoding: 'utf-8' });
    expect(result.content).toBe('world');
    expect(result.truncated).toBe(false);
  });

  it('returns base64 for binary content in auto mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\u0000def' }, emptyHandler);
    const result = await fs.read({ path: 'bin.dat', offset: 0, length: 1024, encoding: 'auto' });
    expect(result.encoding).toBe('base64');
    expect(result.is_binary).toBe(true);
    expect(result.content).toBe(Buffer.from('abc\u0000def').toString('base64'));
  });

  it('throws fs.is_binary for binary content in utf-8 mode', async () => {
    const fs = makeSession({ 'bin.dat': 'abc\u0000def' }, emptyHandler);
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
