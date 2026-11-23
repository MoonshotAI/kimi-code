import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Error2 } from '#/_base/errors/errors';
import { encodeWorkDirKey, toAbsoluteDir } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEnvironmentService } from '#/app/environment/environment';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import { locateCheckout } from '#/app/git/workTree';
import { IProjectService } from '#/app/project/project';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionPresence, SESSION_PRESENCE_DIR } from '#/app/sessionPresence/sessionPresence';
import { SessionPresenceService } from '#/app/sessionPresence/sessionPresenceService';
import { projectPersistenceScope, sessionDirOf } from '#/project/sessionLifecycle/internal/addressing';
import {
  IWorktreeService,
  type CreateWorktreeInput,
  type CreatedWorktree,
  type RemoveWorktreeInput,
  type WorktreeCreateEvent,
} from '#/app/worktree/worktree';
import { generateWorktreeName, normalizeWorktreeName } from '#/app/worktree/worktreeName';
import { WorktreeService } from '#/app/worktree/worktreeService';
import type { Environment } from '#/environment/environment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { stubFlag } from '../flag/stubs';

const isWindows = process.platform === 'win32';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commitFile(dir: string, file: string, content: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', `add ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

function registeredPaths(repo: string): string[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function branches(repo: string): string[] {
  return git(repo, 'branch', '--format=%(refname:short)').split('\n').filter((name) => name !== '');
}

async function failure(promise: Promise<unknown>): Promise<Error2> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error2)) throw new Error(`expected an Error2 rejection, got ${String(outcome)}`);
  return outcome;
}

describe('worktree names', () => {
  it('generates <MMDD>-<4 random characters> from the local date', () => {
    const name = generateWorktreeName(new Date(2026, 0, 5, 23, 59));
    expect(name).toMatch(/^0105-[a-z0-9]{4}$/);
  });

  it('lowercases a valid name and keeps it otherwise unchanged', () => {
    expect(normalizeWorktreeName('Fix_Login-1')).toBe('fix_login-1');
    expect(normalizeWorktreeName('  release-1.2 ')).toBe('release-1.2');
    expect(normalizeWorktreeName('config')).toBe('config');
    expect(normalizeWorktreeName('com10')).toBe('com10');
  });

  it.each([
    ['feat/login', 'slash'],
    ['feat\\login', 'slash'],
    ['a b', 'chars'],
    ['中文', 'chars'],
    ['-a', 'edge'],
    ['a.', 'edge'],
    ['a..b', 'dots'],
    ['a'.repeat(65), 'length'],
    ['con', 'reserved'],
    ['NUL', 'reserved'],
    ['aux', 'reserved'],
    ['prn', 'reserved'],
    ['com1', 'reserved'],
    ['lpt9', 'reserved'],
    ['con.txt', 'reserved'],
  ])('rejects %j with reason %s', (input, reason) => {
    let thrown: unknown;
    try {
      normalizeWorktreeName(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error2);
    expect((thrown as Error2).code).toBe('worktree.invalid_name');
    expect((thrown as Error2).details?.['reason']).toBe(reason);
  });

  it('explains that -w names the directory, not the branch', () => {
    expect(() => normalizeWorktreeName('feat/login')).toThrow(/not a branch/);
  });
});

describe('WorktreeService', () => {
  let root: string;
  let home: string;
  let repo: string;
  let realRepo: string;
  let flagEnabled: boolean;
  let disposables: DisposableStore;
  let service: IWorktreeService;
  let presence: ISessionPresence;
  let indexed: SessionSummary[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worktree-service-'));
    home = join(root, 'home');
    repo = join(root, 'repo');
    initRepo(repo);
    commitFile(repo, 'README.md', 'hello\n');
    realRepo = realpathSync(repo);
    flagEnabled = true;
    indexed = [];

    disposables = new DisposableStore();
    const environment = { process: new HostProcessService() } as unknown as Environment;
    const lease = { environment, track: <T>(resource: T): T => resource, dispose: () => {} };
    const hostFs = new HostFileSystem();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostFileSystem, hostFs);
        reg.definePartialInstance(IProjectService, {
          peekImplicit: async (dir: string) => {
            const abs = toAbsoluteDir(dir);
            const located = abs === undefined ? undefined : await locateCheckout(hostFs, abs);
            const projectRoot = located?.kind === 'grouped' ? located.canonicalMainDir : dir;
            return { id: encodeWorkDirKey(projectRoot), root: projectRoot };
          },
        });
        reg.definePartialInstance(IEnvironmentService, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          inspect: () => environment,
          acquire: () => lease,
          acquireWhenReady: async () => lease,
        });
        reg.definePartialInstance(IBootstrapService, { homeDir: home, scope: () => 'sessions' });
        reg.definePartialInstance(ISessionIndex, { listRecent: async () => ({ items: indexed }) });
        reg.definePartialInstance(ILogService, { warn: () => {} });
        reg.define(ISessionPresence, SessionPresenceService);
        reg.defineInstance(IFlagService, stubFlag((id) => id === 'worktree' && flagEnabled));
        reg.define(IWorktreeService, WorktreeService);
      },
    });
    service = ix.get(IWorktreeService);
    presence = ix.get(ISessionPresence);
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function kimiDir(): string {
    return join(realpathSync(root), 'home', 'worktrees', encodeWorkDirKey(realRepo));
  }

  function create(input: Partial<CreateWorktreeInput> = {}): Promise<CreatedWorktree> {
    return service.create({ cwd: repo, ...input });
  }

  describe('create', () => {
    it('creates a detached checkout of the source HEAD without a new branch', async () => {
      const events: WorktreeCreateEvent[] = [];
      const head = git(repo, 'rev-parse', 'HEAD');

      const created = await service.create({ cwd: repo, name: 'fix-login' }, { onEvent: (event) => events.push(event) });

      const path = join(kimiDir(), 'fix-login');
      expect(created.worktree).toEqual({
        path,
        name: 'fix-login',
        head,
        branch: undefined,
        missing: false,
        managed: true,
      });
      expect(created.repoRoot).toBe(realRepo);
      expect(created.sourceRoot).toBe(realRepo);
      expect(created.cwd).toBe(path);
      expect(created.cwdFallback).toBe(false);
      expect(created.sourceDirty).toBe(false);
      expect(created.setupScript).toBeUndefined();
      expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
      expect(() => git(path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
      expect(branches(repo)).toEqual(['main']);
      expect(registeredPaths(repo)).toEqual([realRepo, path]);
      expect(events.filter((event) => event.type === 'step')).toEqual(
        (['check', 'add', 'include'] as const).flatMap((step) => [
          { type: 'step', step, status: 'started' },
          { type: 'step', step, status: 'finished' },
        ]),
      );
      expect(
        events.some((event) => event.type === 'output' && event.step === 'add' && event.text.includes('HEAD is now at')),
      ).toBe(true);
      const planned = events.findIndex((event) => event.type === 'planned');
      expect(events[planned]).toEqual({ type: 'planned', name: 'fix-login', path, head });
      expect(events[planned - 1]).toEqual({ type: 'step', step: 'check', status: 'finished' });
      expect(events[planned + 1]).toEqual({ type: 'step', step: 'add', status: 'started' });
    });

    it('reports the generated name before creating the checkout', async () => {
      const events: WorktreeCreateEvent[] = [];

      const created = await service.create({ cwd: repo }, { onEvent: (event) => events.push(event) });

      expect(events.filter((event) => event.type === 'planned')).toEqual([
        { type: 'planned', name: created.worktree.name, path: created.worktree.path, head: created.worktree.head },
      ]);
    });

    it('generates a name when none is given', async () => {
      const blank = await create({ name: '  ' });
      const omitted = await create();

      for (const created of [blank, omitted]) {
        expect(created.worktree.name).toMatch(/^\d{4}-[a-z0-9]{4}$/);
        expect(existsSync(created.worktree.path)).toBe(true);
      }
      expect(blank.worktree.name).not.toBe(omitted.worktree.name);
    });

    it('starts from a tag passed as base', async () => {
      const tagged = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'tag', 'v1');
      commitFile(repo, 'later.txt', 'later\n');

      const created = await create({ name: 'from-tag', base: 'v1' });

      expect(git(created.worktree.path, 'rev-parse', 'HEAD')).toBe(tagged);
      expect(existsSync(join(created.worktree.path, 'later.txt'))).toBe(false);
    });

    it('accepts the name of the branch checked out in the main checkout', async () => {
      const created = await create({ name: 'main' });

      expect(created.worktree.path).toBe(join(kimiDir(), 'main'));
      expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    });

    it('reports an unknown base', async () => {
      const error = await failure(create({ name: 'x', base: 'no-such-ref' }));
      expect(error.code).toBe('worktree.base_not_found');
    });

    it('refuses a name already used by a directory or a registration', async () => {
      const first = await create({ name: 'dup' });
      writeFileSync(join(first.worktree.path, 'work.txt'), 'keep me\n');

      const again = await failure(create({ name: 'DUP' }));
      expect(again.code).toBe('worktree.already_exists');
      expect(again.details?.['path']).toBe(first.worktree.path);
      expect(readFileSync(join(first.worktree.path, 'work.txt'), 'utf8')).toBe('keep me\n');

      const gone = await create({ name: 'gone' });
      rmSync(gone.worktree.path, { recursive: true, force: true });
      const stale = await failure(create({ name: 'gone' }));
      expect(stale.code).toBe('worktree.already_exists');
      expect(stale.details?.['path']).toBe(gone.worktree.path);
      expect(registeredPaths(repo)).toContain(gone.worktree.path);
      expect(existsSync(gone.worktree.path)).toBe(false);
    });

    it('rejects an invalid name before touching the disk', async () => {
      const error = await failure(create({ name: 'feat/login' }));
      expect(error.code).toBe('worktree.invalid_name');
      expect(error.details?.['reason']).toBe('slash');
      expect(existsSync(join(home, 'worktrees'))).toBe(false);
    });

    it('is refused while the flag is off', async () => {
      flagEnabled = false;
      const error = await failure(create({ name: 'off' }));
      expect(error.code).toBe('worktree.disabled');
      expect(error.message).toContain('KIMI_CODE_EXPERIMENTAL_WORKTREE');
    });

    describe('refuses sources without a usable repository', () => {
      it('outside git', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect((await failure(service.create({ cwd: plain }))).code).toBe('worktree.not_git_repo');
        expect(existsSync(join(home, 'worktrees'))).toBe(false);
      });

      it('in a repository without commits', async () => {
        const empty = join(root, 'empty');
        initRepo(empty);
        expect((await failure(service.create({ cwd: empty }))).code).toBe('worktree.no_commits');
        expect(existsSync(join(home, 'worktrees'))).toBe(false);
      });

      it('in a bare repository root', async () => {
        const bare = join(root, 'bare.git');
        git(root, 'clone', '-q', '--bare', repo, bare);

        expect((await failure(service.create({ cwd: bare }))).code).toBe('worktree.not_git_repo');
        expect(existsSync(join(home, 'worktrees'))).toBe(false);
      });
    });

    describe('supports additional git repository layouts', () => {
      it('creates, lists, and removes worktrees from a bare repository linked worktree', async () => {
        const bare = join(root, 'bare.git');
        git(root, 'clone', '-q', '--bare', repo, bare);
        const realBare = realpathSync(bare);
        const linked = join(root, 'bare-linked');
        git(bare, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');

        const created = await service.create({ cwd: linked, name: 'from-bare' });
        expect(created.repoRoot).toBe(realBare);
        expect(created.sourceRoot).toBe(realpathSync(linked));

        const listing = await service.list(created.worktree.path);
        expect(listing.repoRoot).toBe(realBare);
        expect(listing.currentCheckoutRoot).toBe(created.worktree.path);
        expect(listing.bare).toBe(true);
        expect(listing.worktrees.map(({ name, managed }) => ({ name, managed }))).toEqual([
          { name: 'from-bare', managed: true },
          { name: 'bare-linked', managed: false },
        ]);

        const check = await service.inspectRemoval({ repoRoot: realBare, path: created.worktree.path, deleteBranch: false });
        expect(check.uncommittedFiles).toBe(0);
        await service.remove({
          repoRoot: realBare,
          path: created.worktree.path,
          deleteBranch: false,
          discard: { uncommittedFiles: 0, uniqueCommits: 0 },
        });
        expect(existsSync(created.worktree.path)).toBe(false);
      });

      it('creates, lists, and removes worktrees from a git submodule', async () => {
        const superproject = join(root, 'super');
        initRepo(superproject);
        commitFile(superproject, 'README.md', 'super\n');
        git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repo, 'sub');
        const sub = join(superproject, 'sub');
        const realSub = realpathSync(sub);

        const created = await service.create({ cwd: sub, name: 'sub-wt' });
        expect(created.repoRoot).toBe(realSub);
        expect(created.sourceRoot).toBe(realSub);

        const listing = await service.list(created.worktree.path);
        expect(listing.repoRoot).toBe(realSub);
        expect(listing.bare).toBe(false);
        expect(listing.worktrees.map((worktree) => worktree.name)).toEqual(['sub-wt']);

        await service.remove({
          repoRoot: realSub,
          path: created.worktree.path,
          deleteBranch: false,
          discard: { uncommittedFiles: 0, uniqueCommits: 0 },
        });
        expect(existsSync(created.worktree.path)).toBe(false);
      });

      it('creates, lists, and removes worktrees from a separate-git-dir checkout with core.worktree', async () => {
        const separateGit = join(root, 'separate.git');
        const separateCheckout = join(root, 'separate-checkout');
        git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', separateGit, separateCheckout);
        git(separateCheckout, 'config', 'user.email', 'test@example.com');
        git(separateCheckout, 'config', 'user.name', 'Test');
        git(separateCheckout, 'config', 'commit.gpgsign', 'false');
        git(separateCheckout, 'config', 'core.worktree', realpathSync(separateCheckout));
        commitFile(separateCheckout, 'README.md', 'separate\n');
        const realSeparate = realpathSync(separateCheckout);

        const created = await service.create({ cwd: separateCheckout, name: 'sep-wt' });
        expect(created.repoRoot).toBe(realSeparate);

        const listing = await service.list(created.worktree.path);
        expect(listing.repoRoot).toBe(realSeparate);
        expect(listing.bare).toBe(false);
        expect(listing.worktrees.map((worktree) => worktree.name)).toEqual(['sep-wt']);

        await service.remove({
          repoRoot: realSeparate,
          path: created.worktree.path,
          deleteBranch: false,
          discard: { uncommittedFiles: 0, uniqueCommits: 0 },
        });
        expect(existsSync(created.worktree.path)).toBe(false);
      });
    });

    it('maps the starting subdirectory into the worktree and falls back to the root', async () => {
      commitFile(repo, 'packages/foo/index.ts', 'export {};\n');
      mkdirSync(join(repo, 'scratch', 'deep'), { recursive: true });

      const mapped = await create({ name: 'mapped', cwd: join(repo, 'packages', 'foo') });
      expect(mapped.cwd).toBe(join(mapped.worktree.path, 'packages', 'foo'));
      expect(mapped.cwdFallback).toBe(false);

      const fallback = await create({ name: 'fallback', cwd: join(repo, 'scratch', 'deep') });
      expect(fallback.cwd).toBe(fallback.worktree.path);
      expect(fallback.cwdFallback).toBe(true);

      commitFile(repo, '..cache/data.txt', 'ok\n');
      const dotdot = await create({ name: 'dotdot', cwd: join(repo, '..cache') });
      expect(dotdot.cwd).toBe(join(dotdot.worktree.path, '..cache'));
      expect(dotdot.cwdFallback).toBe(false);
    });

    it.skipIf(isWindows)('copies ignored files listed in .worktreeinclude and nothing else', async () => {
      commitFile(repo, '.gitignore', '.env\nconfig/*.local\nlinked.env\n');
      commitFile(repo, 'tracked.txt', 'committed\n');
      writeFileSync(join(repo, '.worktreeinclude'), '# local secrets\n.env\nconfig/*.local\nlinked.env\ntracked.txt\nloose.txt\n');
      writeFileSync(join(repo, '.env'), 'SECRET=1\n');
      chmodSync(join(repo, '.env'), 0o640);
      mkdirSync(join(repo, 'config'));
      writeFileSync(join(repo, 'config', 'app.local'), 'local\n');
      symlinkSync('.env', join(repo, 'linked.env'));
      writeFileSync(join(repo, 'tracked.txt'), 'edited in source\n');
      writeFileSync(join(repo, 'loose.txt'), 'untracked, not ignored\n');

      const created = await create({ name: 'with-env' });

      const wt = created.worktree.path;
      expect(created.copiedFiles.toSorted()).toEqual(['.env', 'config/app.local']);
      expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(statSync(join(wt, '.env')).mode & 0o777).toBe(0o640);
      expect(readFileSync(join(wt, 'config', 'app.local'), 'utf8')).toBe('local\n');
      expect(existsSync(join(wt, 'linked.env'))).toBe(false);
      expect(existsSync(join(wt, 'loose.txt'))).toBe(false);
      expect(readFileSync(join(wt, 'tracked.txt'), 'utf8')).toBe('committed\n');
    });

    it('reports uncommitted source changes without carrying them over', async () => {
      commitFile(repo, 'tracked.txt', 'committed\n');
      writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
      writeFileSync(join(repo, 'new.txt'), 'new\n');
      const before = git(repo, 'status', '--porcelain');

      const created = await create({ name: 'dirty' });

      expect(created.sourceDirty).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe(before);
      expect(readFileSync(join(created.worktree.path, 'tracked.txt'), 'utf8')).toBe('committed\n');
      expect(existsSync(join(created.worktree.path, 'new.txt'))).toBe(false);
    });

    it('points at the setup script of the source checkout without running it', async () => {
      mkdirSync(join(repo, '.kimi-code'));
      writeFileSync(join(repo, '.kimi-code', 'worktree-setup.sh'), 'touch ran\n');

      const created = await create({ name: 'scripted' });

      expect(created.setupScript).toBe(join(realRepo, '.kimi-code', 'worktree-setup.sh'));
      expect(existsSync(join(created.worktree.path, 'ran'))).toBe(false);
    });

    it('creates the requested branch', async () => {
      const created = await create({ name: 'desk', branch: 'desk-branch' });

      expect(created.worktree.branch).toBe('desk-branch');
      expect(git(created.worktree.path, 'symbolic-ref', '--short', 'HEAD')).toBe('desk-branch');
      expect(branches(repo)).toEqual(['desk-branch', 'main']);
    });

    it.skipIf(isWindows)('cleans up the directory, registration and new branch when git fails', async () => {
      const hook = join(repo, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, '#!/bin/sh\necho hook refused >&2\nexit 3\n');
      chmodSync(hook, 0o755);
      const outputs: string[] = [];

      const error = await failure(
        service.create(
          { cwd: repo, name: 'broken', branch: 'broken-branch' },
          { onEvent: (event) => event.type === 'output' && outputs.push(event.text) },
        ),
      );

      expect(error.code).toBe('worktree.git_failed');
      expect(error.details?.['stderr']).toContain('hook refused');
      expect(outputs.join('')).toContain('hook refused');
      expect(existsSync(join(kimiDir(), 'broken'))).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
      expect(branches(repo)).toEqual(['main']);
    });

    it.skipIf(isWindows)('keeps an existing branch when git refuses to recreate it', async () => {
      git(repo, 'branch', 'taken');

      const error = await failure(create({ name: 'reuse', branch: 'taken' }));

      expect(error.code).toBe('worktree.git_failed');
      expect(branches(repo)).toEqual(['main', 'taken']);
      expect(existsSync(join(kimiDir(), 'reuse'))).toBe(false);
    });

    it.skipIf(isWindows)('kills a running git on cancel and leaves nothing behind', async () => {
      const hook = join(repo, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, '#!/bin/sh\nsleep 30\n');
      chmodSync(hook, 0o755);
      const controller = new AbortController();
      const started = Date.now();

      const error = await failure(
        service.create(
          { cwd: repo, name: 'cancelled', branch: 'cancelled-branch' },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'output') controller.abort();
            },
          },
        ),
      );

      expect(error.code).toBe('worktree.cancelled');
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(existsSync(join(kimiDir(), 'cancelled'))).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
      expect(branches(repo)).toEqual(['main']);
    });

    it('honors a cancel that lands after git worktree add finished', async () => {
      const controller = new AbortController();

      const error = await failure(
        service.create(
          { cwd: repo, name: 'late' },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'step' && event.step === 'add' && event.status === 'finished') controller.abort();
            },
          },
        ),
      );

      expect(error.code).toBe('worktree.cancelled');
      expect(existsSync(join(kimiDir(), 'late'))).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
    });

    it('cancels before git runs when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const error = await failure(service.create({ cwd: repo, name: 'early' }, { signal: controller.signal }));

      expect(error.code).toBe('worktree.cancelled');
      expect(registeredPaths(repo)).toEqual([realRepo]);
    });
  });

  describe('list', () => {
    it('lists managed Kimi worktrees before external linked worktrees, sorted by name, and marks missing ones', async () => {
      const beta = await create({ name: 'beta' });
      const alpha = await create({ name: 'alpha', branch: 'alpha-branch' });
      const external = join(root, 'aaa-user-worktree');
      git(repo, 'worktree', 'add', '-q', '--detach', external, 'HEAD');
      rmSync(beta.worktree.path, { recursive: true, force: true });

      const listing = await service.list(join(repo));

      expect(listing.repoRoot).toBe(realRepo);
      expect(listing.currentCheckoutRoot).toBe(realRepo);
      expect(listing.bare).toBe(false);
      expect(listing.worktrees).toEqual([
        { ...alpha.worktree, branch: 'alpha-branch' },
        { ...beta.worktree, missing: true },
        {
          path: realpathSync(external),
          name: 'aaa-user-worktree',
          head: alpha.worktree.head,
          branch: undefined,
          missing: false,
          managed: false,
        },
      ]);

      const fromExternal = await service.list(external);
      expect(fromExternal.currentCheckoutRoot).toBe(realpathSync(external));
      expect(fromExternal.worktrees).toEqual(listing.worktrees);
    });

    it('allows creating a managed worktree with the same name as an external linked worktree', async () => {
      const external = join(root, 'shared-name');
      git(repo, 'worktree', 'add', '-q', '--detach', external, 'HEAD');

      const created = await create({ name: 'shared-name' });
      expect(created.worktree.managed).toBe(true);
      expect(created.worktree.path).toBe(join(kimiDir(), 'shared-name'));
    });

    it('lists the same worktrees from inside a Kimi worktree', async () => {
      const created = await create({ name: 'inside' });

      const listing = await service.list(created.worktree.path);

      expect(listing.repoRoot).toBe(realRepo);
      expect(listing.currentCheckoutRoot).toBe(created.worktree.path);
      expect(listing.worktrees.map((worktree) => worktree.name)).toEqual(['inside']);
    });

    it.skipIf(isWindows)('resolves symlinked paths to the realpath git records', async () => {
      const link = join(root, 'repo-link');
      symlinkSync(repo, link);
      const created = await service.create({ cwd: link, name: 'via-link' });

      expect(created.worktree.path).toBe(join(kimiDir(), 'via-link'));
      expect(await service.list(link)).toEqual(await service.list(repo));
    });

    it.skipIf(process.platform !== 'darwin')('treats /tmp and /private/tmp as the same repository', async () => {
      const tmpRoot = mkdtempSync('/tmp/worktree-service-');
      try {
        const tmpRepo = join(tmpRoot, 'repo');
        initRepo(tmpRepo);
        commitFile(tmpRepo, 'README.md', 'hello\n');
        const created = await service.create({ cwd: tmpRepo, name: 'tmp' });
        const privateRepo = join('/private', tmpRepo);

        expect(created.repoRoot).toBe(privateRepo);
        expect(created.worktree.path).toBe(join(realpathSync(home), 'worktrees', encodeWorkDirKey(privateRepo), 'tmp'));
        expect(service.worktreesDir(created.repoRoot)).toBe(join(home, 'worktrees', encodeWorkDirKey(privateRepo)));
        expect(await service.list(tmpRepo)).toEqual(await service.list(privateRepo));
        expect((await service.list(tmpRepo)).worktrees.map((worktree) => worktree.path)).toEqual([created.worktree.path]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('fails outside git', async () => {
      const plain = join(root, 'plain');
      mkdirSync(plain);
      expect((await failure(service.list(plain))).code).toBe('worktree.not_git_repo');
    });
  });

  describe('resolveCheckout', () => {
    it('resolves the main checkout and its subdirectories', async () => {
      commitFile(repo, 'packages/foo/index.ts', 'export {};\n');

      expect(await service.resolveCheckout(repo)).toEqual({
        repoRoot: realRepo,
        checkoutRoot: realRepo,
        relativePath: '',
        kind: 'main',
        bare: false,
      });
      expect(await service.resolveCheckout(join(repo, 'packages', 'foo'))).toEqual({
        repoRoot: realRepo,
        checkoutRoot: realRepo,
        relativePath: 'packages/foo',
        kind: 'main',
        bare: false,
      });
    });

    it('recognizes Kimi worktrees and user-made linked worktrees', async () => {
      commitFile(repo, 'packages/foo/index.ts', 'export {};\n');
      const created = await create({ name: 'resolved' });
      const userWorktree = join(root, 'user-worktree');
      git(repo, 'worktree', 'add', '-q', '--detach', userWorktree, 'HEAD');

      expect(await service.resolveCheckout(join(created.worktree.path, 'packages', 'foo'))).toEqual({
        repoRoot: realRepo,
        checkoutRoot: created.worktree.path,
        relativePath: 'packages/foo',
        kind: 'managed',
        bare: false,
      });
      expect(await service.resolveCheckout(userWorktree)).toEqual({
        repoRoot: realRepo,
        checkoutRoot: realpathSync(userWorktree),
        relativePath: '',
        kind: 'linked',
        bare: false,
      });
    });

    it('returns undefined outside git and at a bare root, and resolves a bare linked worktree', async () => {
      const plain = join(root, 'plain');
      mkdirSync(plain);
      const bare = join(root, 'bare.git');
      git(root, 'clone', '-q', '--bare', repo, bare);
      const linked = join(root, 'bare-linked');
      git(bare, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');

      expect(await service.resolveCheckout(plain)).toBeUndefined();
      expect(await service.resolveCheckout(bare)).toBeUndefined();
      expect(await service.resolveCheckout(linked)).toEqual({
        repoRoot: realpathSync(bare),
        checkoutRoot: realpathSync(linked),
        relativePath: '',
        kind: 'linked',
        bare: true,
      });
    });
  });

  describe('locate', () => {
    it('identifies a Kimi worktree along with its project root', async () => {
      commitFile(repo, 'packages/foo/index.ts', 'export {};\n');
      const created = await create({ name: 'located' });
      mkdirSync(join(created.worktree.path, 'scratch'));
      const link = join(root, 'located-link');
      symlinkSync(created.worktree.path, link);
      const worktree = { root: created.worktree.path, name: 'located', repoRoot: realRepo };

      expect(await service.locate(join(created.worktree.path, 'packages', 'foo'))).toEqual({
        cwd: join(created.worktree.path, 'packages', 'foo'),
        projectRoot: realRepo,
        isGitRepo: true,
        worktree,
      });
      expect(await service.locate(join(created.worktree.path, 'scratch'))).toEqual({
        cwd: join(created.worktree.path, 'scratch'),
        projectRoot: realRepo,
        isGitRepo: true,
        worktree,
      });
      expect(await service.locate(`${link}/packages/foo/`)).toEqual({
        cwd: join(created.worktree.path, 'packages', 'foo'),
        projectRoot: realRepo,
        isGitRepo: true,
        worktree,
      });
    });

    it('omits worktree metadata outside Kimi worktrees or while the flag is off', async () => {
      const created = await create({ name: 'flagged' });
      const plain = join(root, 'plain');
      mkdirSync(plain);

      expect(await service.locate(repo)).toEqual({ cwd: repo, projectRoot: realRepo, isGitRepo: true });
      expect(await service.locate(plain)).toEqual({ cwd: plain, projectRoot: plain, isGitRepo: false });
      flagEnabled = false;
      expect(await service.locate(created.worktree.path)).toEqual({
        cwd: created.worktree.path,
        projectRoot: realRepo,
        isGitRepo: true,
      });
    });
  });

  describe('inspectRemoval and remove', () => {
    function removal(path: string, overrides: { deleteBranch?: boolean; discard?: RemoveWorktreeInput['discard'] } = {}) {
      return {
        repoRoot: realRepo,
        path,
        deleteBranch: overrides.deleteBranch ?? false,
        discard: overrides.discard ?? { uncommittedFiles: 0, uniqueCommits: 0 },
      };
    }

    it('removes a clean detached worktree', async () => {
      const created = await create({ name: 'clean' });

      expect(await service.inspectRemoval({ repoRoot: realRepo, path: created.worktree.path, deleteBranch: false })).toEqual({
        path: created.worktree.path,
        missing: false,
        branch: undefined,
        uncommittedFiles: 0,
        uniqueCommits: 0,
        openSessionIds: [],
        closedSessionCount: 0,
      });
      await service.remove(removal(created.worktree.path));

      expect(existsSync(created.worktree.path)).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
    });

    it.skipIf(isWindows)('ignores copied ignored files when counting uncommitted work', async () => {
      commitFile(repo, '.gitignore', '.env\n');
      writeFileSync(join(repo, '.worktreeinclude'), '.env\n');
      writeFileSync(join(repo, '.env'), 'SECRET=1\n');
      const created = await create({ name: 'ignored-only' });
      expect(created.copiedFiles).toEqual(['.env']);

      const check = await service.inspectRemoval({ repoRoot: realRepo, path: created.worktree.path, deleteBranch: false });
      expect(check.uncommittedFiles).toBe(0);
      await service.remove(removal(created.worktree.path));
      expect(existsSync(created.worktree.path)).toBe(false);
    });

    it('refuses to drop uncommitted files unless told to', async () => {
      commitFile(repo, 'tracked.txt', 'committed\n');
      const created = await create({ name: 'edited' });
      const wt = created.worktree.path;
      writeFileSync(join(wt, 'tracked.txt'), 'edited\n');
      mkdirSync(join(wt, 'notes'));
      writeFileSync(join(wt, 'notes', 'a.md'), 'a\n');
      writeFileSync(join(wt, 'notes', 'b.md'), 'b\n');
      git(wt, 'mv', 'README.md', 'README.txt');

      expect((await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false })).uncommittedFiles).toBe(4);
      const refused = await failure(service.remove(removal(wt)));
      expect(refused.code).toBe('worktree.has_uncommitted');
      expect(readFileSync(join(wt, 'tracked.txt'), 'utf8')).toBe('edited\n');

      await service.remove(removal(wt, { discard: { uncommittedFiles: 4, uniqueCommits: 0 } }));
      expect(existsSync(wt)).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
    });

    it('refuses to discard files or commits that appeared after the caller looked', async () => {
      const created = await create({ name: 'racy' });
      const wt = created.worktree.path;
      commitFile(wt, 'one.txt', 'one\n');
      writeFileSync(join(wt, 'first.txt'), 'first\n');
      const seen = await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false });
      const agreed = { uncommittedFiles: seen.uncommittedFiles, uniqueCommits: seen.uniqueCommits };
      expect(agreed).toEqual({ uncommittedFiles: 1, uniqueCommits: 1 });

      writeFileSync(join(wt, 'second.txt'), 'second\n');
      expect((await failure(service.remove(removal(wt, { discard: agreed })))).code).toBe('worktree.has_uncommitted');
      expect(readFileSync(join(wt, 'second.txt'), 'utf8')).toBe('second\n');

      rmSync(join(wt, 'second.txt'));
      commitFile(wt, 'two.txt', 'two\n');
      expect((await failure(service.remove(removal(wt, { discard: agreed })))).code).toBe('worktree.has_unique_commits');
      expect(existsSync(join(wt, 'two.txt'))).toBe(true);

      await service.remove(removal(wt, { discard: 'all' }));
      expect(existsSync(wt)).toBe(false);
    });

    it('counts edits that skip-worktree or assume-unchanged hide from git status', async () => {
      const created = await create({ name: 'hidden-edits' });
      const wt = created.worktree.path;
      for (const file of ['skipped.txt', 'assumed.txt', 'assumed-deleted.txt', 'assumed-dir.txt', 'untouched.txt', 'sparse.txt']) {
        commitFile(wt, file, 'committed\n');
      }
      if (!isWindows) {
        symlinkSync('target-a', join(wt, 'assumed-link'));
        git(wt, 'add', 'assumed-link');
        git(wt, 'commit', '-q', '-m', 'add assumed-link');
      }
      git(repo, 'branch', 'keep', git(wt, 'rev-parse', 'HEAD'));
      git(wt, 'update-index', '--skip-worktree', 'skipped.txt', 'sparse.txt');
      git(
        wt,
        'update-index',
        '--assume-unchanged',
        'assumed.txt',
        'assumed-deleted.txt',
        'assumed-dir.txt',
        'untouched.txt',
        ...(isWindows ? [] : ['assumed-link']),
      );
      writeFileSync(join(wt, 'skipped.txt'), 'local edit\n');
      writeFileSync(join(wt, 'assumed.txt'), 'local edit\n');
      rmSync(join(wt, 'assumed-deleted.txt'));
      rmSync(join(wt, 'assumed-dir.txt'));
      mkdirSync(join(wt, 'assumed-dir.txt'));
      rmSync(join(wt, 'sparse.txt'));
      if (!isWindows) {
        rmSync(join(wt, 'assumed-link'));
        symlinkSync('target-b', join(wt, 'assumed-link'));
      }
      expect(git(wt, 'status', '--porcelain')).toBe('');

      const expectedCount = isWindows ? 4 : 5;
      const seen = await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false });
      expect(seen.uncommittedFiles).toBe(expectedCount);
      expect((await failure(service.remove(removal(wt)))).code).toBe('worktree.has_uncommitted');
      expect(readFileSync(join(wt, 'skipped.txt'), 'utf8')).toBe('local edit\n');

      await service.remove(removal(wt, { discard: { uncommittedFiles: expectedCount, uniqueCommits: 0 } }));
      expect(existsSync(wt)).toBe(false);
    });

    it('refuses removal while the worktree flag is off', async () => {
      const created = await create({ name: 'flag-off-remove' });
      flagEnabled = false;

      const error = await failure(service.remove(removal(created.worktree.path)));
      expect(error.code).toBe('worktree.disabled');
      expect(existsSync(created.worktree.path)).toBe(true);
    });

    it('rejects non-finite or negative discard thresholds instead of bypassing removal guards', async () => {
      const created = await create({ name: 'nan-discard' });
      const wt = created.worktree.path;
      writeFileSync(join(wt, 'dirty.txt'), 'dirty\n');

      for (const bad of [
        { uncommittedFiles: Number.NaN, uniqueCommits: 0 },
        { uncommittedFiles: 0, uniqueCommits: Number.NaN },
        { uncommittedFiles: Number.POSITIVE_INFINITY, uniqueCommits: 0 },
        { uncommittedFiles: -1, uniqueCommits: 0 },
      ]) {
        await expect(service.remove(removal(wt, { discard: bad }))).rejects.toThrow(/discard/i);
        expect(existsSync(wt)).toBe(true);
      }
    });

    it('keeps a branch created concurrently by another process when worktree add fails', async () => {
      const racingTip = git(repo, 'rev-parse', 'HEAD');
      const error = await failure(
        service.create(
          { cwd: repo, name: 'branch-race', branch: 'raced-branch' },
          {
            onEvent: (event) => {
              if (event.type === 'step' && event.step === 'check' && event.status === 'finished') {
                git(repo, 'branch', 'raced-branch', racingTip);
              }
            },
          },
        ),
      );
      expect(error.code).toBe('worktree.git_failed');
      expect(branches(repo)).toContain('raced-branch');
      expect(git(repo, 'rev-parse', 'refs/heads/raced-branch')).toBe(racingTip);
    });

    it('counts commits that only a detached worktree holds', async () => {
      const created = await create({ name: 'detached-work' });
      const wt = created.worktree.path;
      commitFile(wt, 'work.txt', 'work\n');

      expect((await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false })).uniqueCommits).toBe(1);
      expect((await failure(service.remove(removal(wt)))).code).toBe('worktree.has_unique_commits');

      git(repo, 'branch', 'keep', git(wt, 'rev-parse', 'HEAD'));
      expect((await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false })).uniqueCommits).toBe(0);
      await service.remove(removal(wt));
      expect(existsSync(wt)).toBe(false);
    });

    it('counts unpushed, unmerged branch commits only when the branch goes too', async () => {
      const created = await create({ name: 'topic-work' });
      const wt = created.worktree.path;
      git(wt, 'switch', '-q', '-c', 'topic');
      commitFile(wt, 'topic.txt', 'topic\n');

      expect(await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: true })).toMatchObject({
        branch: 'topic',
        uniqueCommits: 1,
      });
      expect((await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: false })).uniqueCommits).toBe(0);
      expect((await failure(service.remove(removal(wt, { deleteBranch: true })))).code).toBe('worktree.has_unique_commits');
      expect(branches(repo)).toContain('topic');

      await service.remove(removal(wt, { deleteBranch: true, discard: { uncommittedFiles: 0, uniqueCommits: 1 } }));
      expect(existsSync(wt)).toBe(false);
      expect(branches(repo)).toEqual(['main']);
    });

    it('does not count branch commits merged into another branch', async () => {
      const created = await create({ name: 'merged-work' });
      const wt = created.worktree.path;
      git(wt, 'switch', '-q', '-c', 'merged');
      commitFile(wt, 'merged.txt', 'merged\n');
      git(repo, 'merge', '-q', '--ff-only', 'merged');

      expect((await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: true })).uniqueCommits).toBe(0);
    });

    it('clears the registration of a worktree whose directory is gone', async () => {
      const created = await create({ name: 'vanished', branch: 'vanished-branch' });
      rmSync(created.worktree.path, { recursive: true, force: true });

      expect(
        await service.inspectRemoval({ repoRoot: realRepo, path: created.worktree.path, deleteBranch: true }),
      ).toEqual({
        path: created.worktree.path,
        missing: true,
        branch: 'vanished-branch',
        uncommittedFiles: 0,
        uniqueCommits: 0,
        openSessionIds: [],
        closedSessionCount: 0,
      });
      await service.remove(removal(created.worktree.path, { deleteBranch: true }));

      expect(registeredPaths(repo)).toEqual([realRepo]);
      expect(branches(repo)).toEqual(['main']);
    });

    it('reports the git error and keeps the branch when git refuses', async () => {
      const created = await create({ name: 'locked', branch: 'locked-branch' });
      git(repo, 'worktree', 'lock', created.worktree.path);

      const error = await failure(service.remove(removal(created.worktree.path, { deleteBranch: true })));

      expect(error.code).toBe('worktree.git_failed');
      expect(error.details?.['stderr']).toContain('locked');
      expect(existsSync(created.worktree.path)).toBe(true);
      expect(branches(repo)).toContain('locked-branch');
    });

    it('inspects and removes external linked worktrees of the repository', async () => {
      const userWorktree = join(root, 'user-worktree');
      git(repo, 'worktree', 'add', '-q', '-b', 'user-branch', userWorktree, 'HEAD');
      const realUserWorktree = realpathSync(userWorktree);
      writeFileSync(join(userWorktree, 'draft.txt'), 'draft\n');

      const check = await service.inspectRemoval({
        repoRoot: realRepo,
        path: userWorktree,
        deleteBranch: true,
      });
      expect(check).toMatchObject({
        path: realUserWorktree,
        missing: false,
        branch: 'user-branch',
        uncommittedFiles: 1,
        uniqueCommits: 0,
      });
      expect((await failure(service.remove(removal(userWorktree, { deleteBranch: true })))).code).toBe(
        'worktree.has_uncommitted',
      );

      await service.remove(
        removal(userWorktree, { deleteBranch: true, discard: { uncommittedFiles: 1, uniqueCommits: 0 } }),
      );
      expect(existsSync(userWorktree)).toBe(false);
      expect(branches(repo)).toEqual(['main']);
    });

    it('rejects paths that are not linked worktrees of the repository', async () => {
      const otherRepo = join(root, 'other-repo');
      initRepo(otherRepo);
      commitFile(otherRepo, 'README.md', 'other\n');
      const otherWorktree = join(root, 'other-worktree');
      git(otherRepo, 'worktree', 'add', '-q', '--detach', otherWorktree, 'HEAD');

      for (const path of [otherWorktree, repo, join(kimiDir(), 'never-created')]) {
        const error = await failure(service.inspectRemoval({ repoRoot: realRepo, path, deleteBranch: false }));
        expect(error.code).toBe('worktree.not_found');
      }
    });

    it('inspects and removes a worktree checked out on an unborn orphan branch', async () => {
      const created = await create({ name: 'orphan-wt' });
      const wt = created.worktree.path;
      git(wt, 'switch', '-q', '--orphan', 'orphan');

      expect(await service.inspectRemoval({ repoRoot: realRepo, path: wt, deleteBranch: true })).toMatchObject({
        path: wt,
        missing: false,
        branch: 'orphan',
        uncommittedFiles: 0,
        uniqueCommits: 0,
      });

      await service.remove(removal(wt, { deleteBranch: true }));
      expect(existsSync(wt)).toBe(false);
      expect(registeredPaths(repo)).toEqual([realRepo]);
    });

    it.skipIf(isWindows)('ignores a managed worktree path replaced by a symlink to a sibling worktree', async () => {
      const first = await create({ name: 'first-wt', branch: 'branch-a' });
      const second = await create({ name: 'second-wt', branch: 'branch-b' });
      rmSync(first.worktree.path, { recursive: true, force: true });
      symlinkSync(second.worktree.path, first.worktree.path);

      const listed = await service.list(repo);
      expect(listed.worktrees.map((worktree) => worktree.name)).toEqual(['second-wt']);

      const refused = await failure(service.remove(removal(`${first.worktree.path}/`, { deleteBranch: true })));
      expect(refused.code).toBe('worktree.not_found');
      expect(existsSync(second.worktree.path)).toBe(true);
      expect(branches(repo)).toContain('branch-a');
      expect(branches(repo)).toContain('branch-b');

      await service.remove(removal(second.worktree.path, { deleteBranch: true }));
      expect(existsSync(second.worktree.path)).toBe(false);
      expect(branches(repo)).toContain('branch-a');
      expect(branches(repo)).not.toContain('branch-b');
    });
  });

  describe('runSetupScript', () => {
    function writeScript(body: string): void {
      mkdirSync(join(repo, '.kimi-code'), { recursive: true });
      writeFileSync(join(repo, '.kimi-code', 'worktree-setup.sh'), body);
    }

    it.skipIf(isWindows)('runs in the worktree root with both directories in the environment', async () => {
      writeScript('echo "source=$KIMI_CODE_WORKTREE_SOURCE_DIR"\necho "dir=$KIMI_CODE_WORKTREE_DIR"\necho "pwd=$(pwd -P)"\necho oops >&2\nexit 3\n');
      const created = await create({ name: 'setup' });
      let output = '';

      const result = await service.runSetupScript(
        { worktreePath: created.worktree.path, sourceRoot: created.sourceRoot },
        { onOutput: (text) => (output += text) },
      );

      expect(result.exitCode).toBe(3);
      expect(output).toContain(`source=${realRepo}\n`);
      expect(output).toContain(`dir=${created.worktree.path}\n`);
      expect(output).toContain(`pwd=${created.worktree.path}\n`);
      expect(output).toContain('oops\n');
    });

    it.skipIf(isWindows)('returns once the script exits even if a background child holds its output', async () => {
      writeScript('sleep 5 &\necho done\n');
      const created = await create({ name: 'background-setup' });
      const started = Date.now();

      const result = await service.runSetupScript({ worktreePath: created.worktree.path, sourceRoot: created.sourceRoot });

      expect(result.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it.skipIf(isWindows)('kills the script on cancel', async () => {
      writeScript('echo started\nsleep 30\n');
      const created = await create({ name: 'slow-setup' });
      const controller = new AbortController();
      const started = Date.now();

      const error = await failure(
        service.runSetupScript(
          { worktreePath: created.worktree.path, sourceRoot: created.sourceRoot },
          {
            signal: controller.signal,
            onOutput: () => {
              controller.abort();
            },
          },
        ),
      );

      expect(error.code).toBe('worktree.cancelled');
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('refuses runSetupScript while the worktree flag is off', async () => {
      writeScript('echo ran\n');
      const created = await create({ name: 'flag-off-setup' });
      flagEnabled = false;

      const error = await failure(
        service.runSetupScript({ worktreePath: created.worktree.path, sourceRoot: created.sourceRoot }),
      );
      expect(error.code).toBe('worktree.disabled');
    });

    it.skipIf(isWindows)('keeps draining output when onOutput throws', async () => {
      writeScript('head -c 200000 /dev/zero | tr "\\0" "a"\n');
      const created = await create({ name: 'noisy-callback' });

      const result = await service.runSetupScript(
        { worktreePath: created.worktree.path, sourceRoot: created.sourceRoot },
        {
          onOutput: () => {
            throw new Error('listener failed');
          },
        },
      );
      expect(result.exitCode).toBe(0);
    });
  });

  it('keeps every created worktree under the per-repository directory', async () => {
    await create({ name: 'one' });
    await create({ name: 'two' });

    expect(readdirSync(join(home, 'worktrees'))).toEqual([encodeWorkDirKey(realRepo)]);
    expect(readdirSync(kimiDir()).toSorted()).toEqual(['one', 'two']);
  });

  describe('sessions in the worktree', () => {
    function indexSession(id: string, cwd: string): string {
      indexed.push({ id, workspaceId: 'wd_project', cwd, createdAt: 0, updatedAt: 0, archived: false });
      return sessionDirOf(home, projectPersistenceScope('sessions', 'wd_project'), id);
    }

    function removal(path: string): Parameters<IWorktreeService['remove']>[0] {
      return { repoRoot: realRepo, path, deleteBranch: false, discard: { uncommittedFiles: 0, uniqueCommits: 0 } };
    }

    it('reports open and closed sessions and refuses removal while another session is open', async () => {
      const created = await create({ name: 'busy' });
      const wt = created.worktree.path;
      const open = presence.markOpen(indexSession('open-here', join(wt, 'packages')));
      indexSession('closed-here', wt);
      indexSession('in-source', realRepo);
      indexed.push({ id: 'remote', workspaceId: 'wd_project', cwd: wt, environmentId: 'sandbox', createdAt: 0, updatedAt: 0, archived: false });
      const inspect = { repoRoot: realRepo, path: wt, deleteBranch: false };

      expect(await service.inspectRemoval(inspect)).toMatchObject({ openSessionIds: ['open-here'], closedSessionCount: 1 });
      expect(await service.inspectRemoval({ ...inspect, excludeSessionId: 'open-here' })).toMatchObject({
        openSessionIds: [],
        closedSessionCount: 1,
      });
      const refused = await failure(service.remove(removal(wt)));
      expect(refused.code).toBe('worktree.in_use');
      expect(refused.details).toEqual({ path: wt, openSessionIds: ['open-here'] });
      expect(existsSync(wt)).toBe(true);

      await service.remove({ ...removal(wt), excludeSessionId: 'open-here' });
      expect(existsSync(wt)).toBe(false);
      open.dispose();
    });

    it('counts a session whose marker was left by a dead process as closed', async () => {
      const created = await create({ name: 'crashed' });
      const markers = join(indexSession('crashed', created.worktree.path), SESSION_PRESENCE_DIR);
      const exited = spawnSync(process.execPath, ['-e', '']);
      mkdirSync(markers, { recursive: true });
      writeFileSync(
        join(markers, `${exited.pid}-stale.json`),
        JSON.stringify({ version: 1, pid: exited.pid, hostname: hostname(), startedAt: Date.now() }),
      );

      expect(
        await service.inspectRemoval({ repoRoot: realRepo, path: created.worktree.path, deleteBranch: false }),
      ).toMatchObject({ openSessionIds: [], closedSessionCount: 1 });
      expect(readdirSync(markers)).toEqual([]);
      await service.remove(removal(created.worktree.path));
      expect(existsSync(created.worktree.path)).toBe(false);
    });

    it('counts a session opened in this process as open even when its marker cannot be written', async () => {
      const created = await create({ name: 'unmarked' });
      const sessionDir = indexSession('unmarked', created.worktree.path);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, SESSION_PRESENCE_DIR), '');
      const inspect = { repoRoot: realRepo, path: created.worktree.path, deleteBranch: false };

      const open = presence.markOpen(sessionDir);
      expect(await service.inspectRemoval(inspect)).toMatchObject({ openSessionIds: ['unmarked'], closedSessionCount: 0 });
      expect((await failure(service.remove(removal(created.worktree.path)))).code).toBe('worktree.in_use');
      open.dispose();
      open.dispose();
      expect(await service.inspectRemoval(inspect)).toMatchObject({ openSessionIds: [], closedSessionCount: 1 });
    });

    it('keeps one marker per open and deletes each on close', () => {
      const sessionDir = indexSession('twice', realRepo);
      const markers = join(sessionDir, SESSION_PRESENCE_DIR);
      const first = presence.markOpen(sessionDir);
      const second = presence.markOpen(sessionDir);

      const written = readdirSync(markers);
      expect(written).toHaveLength(2);
      expect(JSON.parse(readFileSync(join(markers, written[0]!), 'utf8'))).toMatchObject({
        version: 1,
        pid: process.pid,
        hostname: hostname(),
      });
      first.dispose();
      expect(readdirSync(markers)).toHaveLength(1);
      second.dispose();
      second.dispose();
      expect(readdirSync(markers)).toEqual([]);
    });

    it('keeps a worktree busy when another client holds a live marker for the excluded session', async () => {
      const created = await create({ name: 'shared-session' });
      const wt = created.worktree.path;
      const sessionDir = indexSession('shared', wt);
      const own = presence.markOpen(sessionDir);
      const markers = join(sessionDir, SESSION_PRESENCE_DIR);
      writeFileSync(
        join(markers, `${process.pid}-other-client.json`),
        JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), startedAt: Math.round(performance.timeOrigin) }),
      );
      const inspect = { repoRoot: realRepo, path: wt, deleteBranch: false, excludeSessionId: 'shared' };

      expect(await service.inspectRemoval(inspect)).toMatchObject({ openSessionIds: ['shared'] });
      expect((await failure(service.remove({ ...removal(wt), excludeSessionId: 'shared' }))).code).toBe('worktree.in_use');
      expect(existsSync(wt)).toBe(true);
      own.dispose();
    });

    it('writes no marker while the worktree flag is off', () => {
      flagEnabled = false;
      const sessionDir = indexSession('flag-off', realRepo);

      presence.markOpen(sessionDir).dispose();

      expect(existsSync(join(sessionDir, SESSION_PRESENCE_DIR))).toBe(false);
    });
  });
});
