import { describe, expect, it } from 'vitest';

import { encodeWorkDirKey, type AbsoluteDir } from '#/_base/utils/workdir-slug';
import type { CheckoutLocation } from '#/app/git/workTree';
import {
  decideImplicitProject,
  projectScopeContains,
  reviveCandidates,
  reviveRoot,
  type ImplicitResolutionPorts,
  type ImplicitWorkspace,
} from '#/app/workspace/implicitProject';

function project(root: string, id: string = encodeWorkDirKey(root)): ImplicitWorkspace {
  return {
    id: id as ImplicitWorkspace['id'],
    root,
    name: root.split(/[\\/]/).pop() ?? root,
    kind: 'implicit',
    additionalDirs: [],
    createdAt: 0,
    lastOpenedAt: 0,
  };
}

function grouped(mainDir: string, canonicalMainDir = mainDir): CheckoutLocation {
  return {
    kind: 'grouped',
    layout: 'linked',
    checkoutRoot: '/checkout' as AbsoluteDir,
    mainDir: mainDir as AbsoluteDir,
    canonicalMainDir: canonicalMainDir as AbsoluteDir,
  };
}

interface PortOptions {
  readonly occupied?: readonly string[];
  readonly location?: CheckoutLocation;
  readonly realpaths?: Readonly<Record<string, string>>;
  readonly homeDirs?: readonly string[] | undefined;
}

function ports(options: PortOptions = {}): ImplicitResolutionPorts & { readonly located: string[] } {
  const located: string[] = [];
  return {
    located,
    occupied: async (candidate) => options.occupied?.includes(candidate.id) === true,
    locate: async (dir) => {
      located.push(dir);
      return options.location ?? { kind: 'own', reason: 'not-a-repo' };
    },
    realpath: async (dir) => options.realpaths?.[dir],
    homeDirs: 'homeDirs' in options ? options.homeDirs : ['/home/me'],
  };
}

describe('decideImplicitProject', () => {
  describe('rule 1: a directory keeps its own project while that project holds sessions', () => {
    it('reuses an existing worktree project with sessions without locating the checkout', async () => {
      const worktree = project('/code/app-fix');
      const fixture = ports({ occupied: [worktree.id], location: grouped('/code/app') });

      const resolution = await decideImplicitProject('/code/app-fix', { implicit: [worktree] }, fixture);

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'sticky', project: worktree });
      expect(fixture.located).toEqual([]);
    });

    it('matches the own project by id when its primary directory was moved', async () => {
      const moved = { ...project('/code/app'), root: '/code/app-renamed' };
      const resolution = await decideImplicitProject(
        '/code/app',
        { implicit: [moved] },
        ports({ occupied: [moved.id] }),
      );

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'sticky', project: moved });
    });

    it('matches the own project by Windows-shaped root across drive casing and separators', async () => {
      const own = project('C:\\Users\\Me\\app-fix');
      const resolution = await decideImplicitProject(
        'c:/users/me/app-fix/',
        { implicit: [own] },
        ports({ occupied: [own.id], location: grouped('C:/Users/Me/app') }),
      );

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'sticky', project: own });
    });
  });

  describe('rule 2: a directory inside a repository joins the project of its main checkout', () => {
    it('moves an empty worktree project over to the main checkout', async () => {
      const shell = project('/code/app-fix');
      const main = project('/code/app');
      const resolution = await decideImplicitProject(
        '/code/app-fix',
        { implicit: [shell, main] },
        ports({ location: grouped('/code/app') }),
      );

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'repo', project: main });
    });

    it('creates the main checkout project when the repository has none yet', async () => {
      const resolution = await decideImplicitProject(
        '/code/app-fix/src',
        { implicit: [] },
        ports({ location: grouped('/code/app') }),
      );

      expect(resolution.decision).toEqual({
        kind: 'create',
        rule: 'repo',
        id: encodeWorkDirKey('/code/app'),
        root: '/code/app',
      });
      expect(resolution.location).toEqual(grouped('/code/app'));
    });

    it('finds the main checkout project through a Windows-shaped root that differs by casing', async () => {
      const main = project('c:\\users\\me\\app');
      const resolution = await decideImplicitProject(
        'C:/Users/Me/app-fix',
        { implicit: [main] },
        ports({ location: grouped('C:/Users/Me/app') }),
      );

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'repo', project: main });
    });

    it('finds the main checkout project registered under a symlinked path through realpath', async () => {
      const main = project('/tmp/code/app');
      const resolution = await decideImplicitProject(
        '/private/tmp/code/app-fix',
        { implicit: [main] },
        ports({
          location: grouped('/private/tmp/code/app'),
          realpaths: { '/tmp/code/app': '/private/tmp/code/app' },
        }),
      );

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'repo', project: main });
    });

    it('keeps the literal main checkout path as the root of a new project', async () => {
      const resolution = await decideImplicitProject(
        '/tmp/code/app/src',
        { implicit: [project('/elsewhere')] },
        ports({ location: grouped('/tmp/code/app', '/private/tmp/code/app') }),
      );

      expect(resolution.decision).toMatchObject({ kind: 'create', id: encodeWorkDirKey('/tmp/code/app'), root: '/tmp/code/app' });
    });
  });

  describe('rule 3: everything else keeps a project of its own', () => {
    it('does not group under a repository at the home directory or above it', async () => {
      for (const mainDir of ['/home/me', '/home', '/']) {
        const resolution = await decideImplicitProject(
          '/home/me/notes',
          { implicit: [] },
          ports({ location: grouped(mainDir) }),
        );
        expect(resolution.decision).toEqual({
          kind: 'create',
          rule: 'own',
          id: encodeWorkDirKey('/home/me/notes'),
          root: '/home/me/notes',
        });
      }
    });

    it('compares the home directory through its realpath as well', async () => {
      const resolution = await decideImplicitProject(
        '/Users/me/notes',
        { implicit: [] },
        ports({ location: grouped('/Users/me', '/private/Users/me'), homeDirs: ['/home-link', '/private/Users/me'] }),
      );

      expect(resolution.decision).toMatchObject({ kind: 'create', rule: 'own' });
    });

    it('does not group when the home directory is unknown', async () => {
      const resolution = await decideImplicitProject(
        '/code/app-fix',
        { implicit: [] },
        ports({ location: grouped('/code/app'), homeDirs: undefined }),
      );

      expect(resolution.decision).toMatchObject({ kind: 'create', rule: 'own', root: '/code/app-fix' });
    });

    it.each([
      ['a forged pointer', { kind: 'rejected', reason: 'backpointer-mismatch', checkoutRoot: '/code/evil' }],
      ['an unreadable .git file', { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot: '/code/evil' }],
      ['a separate-git-dir worktree', { kind: 'own', reason: 'main-unknown', checkoutRoot: '/code/evil' }],
    ] as const)('keeps %s on its own project', async (_label, location) => {
      const trusted = project('/code/app');
      const resolution = await decideImplicitProject(
        '/code/evil',
        { implicit: [trusted] },
        ports({ location: location as CheckoutLocation }),
      );

      expect(resolution.decision).toEqual({
        kind: 'create',
        rule: 'own',
        id: encodeWorkDirKey('/code/evil'),
        root: '/code/evil',
      });
    });

    it('reuses the existing own project of a plain directory, as before', async () => {
      const own = project('/notes');
      const resolution = await decideImplicitProject('/notes', { implicit: [own] }, ports());

      expect(resolution.decision).toEqual({ kind: 'reuse', rule: 'own', project: own });
    });

    it('keeps the caller spelling of a new plain directory as its root', async () => {
      const resolution = await decideImplicitProject('C:\\Users\\Me\\notes', { implicit: [] }, ports());

      expect(resolution.decision).toEqual({
        kind: 'create',
        rule: 'own',
        id: encodeWorkDirKey('C:\\Users\\Me\\notes'),
        root: 'C:\\Users\\Me\\notes',
      });
    });
  });
});

describe('reviveRoot', () => {
  it('revives an old bucket from the session directory and a grouped bucket from its main checkout', () => {
    const worktree = '/code/app-fix';
    expect(reviveRoot(encodeWorkDirKey(worktree), reviveCandidates(worktree, worktree, grouped('/code/app')))).toBe(worktree);
    expect(reviveRoot(encodeWorkDirKey('/code/app'), reviveCandidates(worktree, worktree, grouped('/code/app')))).toBe('/code/app');
  });

  it('tries the realpath and the canonical main checkout when the literal paths do not hash to the bucket', () => {
    const candidates = reviveCandidates('/tmp/app-fix', '/private/tmp/app-fix', grouped('/tmp/app', '/private/tmp/app'));
    expect(reviveRoot(encodeWorkDirKey('/private/tmp/app-fix'), candidates)).toBe('/private/tmp/app-fix');
    expect(reviveRoot(encodeWorkDirKey('/private/tmp/app'), candidates)).toBe('/private/tmp/app');
  });

  it('gives up when no candidate hashes to the bucket', () => {
    expect(reviveRoot(encodeWorkDirKey('/somewhere'), reviveCandidates('/code/app-fix', undefined, undefined))).toBeUndefined();
  });
});

describe('projectScopeContains', () => {
  const scope = { root: '/code/app', additionalDirs: ['/shared/lib'] };

  it('covers the primary and additional directory subtrees', () => {
    expect(projectScopeContains(scope, '/code/app/src', undefined, undefined)).toBe(true);
    expect(projectScopeContains(scope, '/shared/lib/pkg', undefined, undefined)).toBe(true);
    expect(projectScopeContains(scope, '/code/app-fix', undefined, undefined)).toBe(false);
  });

  it('covers checkouts the locator groups into the primary directory', () => {
    expect(projectScopeContains(scope, '/code/app-fix', grouped('/code/app'), undefined)).toBe(true);
    expect(projectScopeContains(scope, '/code/app-fix', grouped('/tmp/app', '/private/code/app'), '/private/code/app')).toBe(true);
    expect(projectScopeContains(scope, '/code/other', grouped('/code/other'), '/code/app')).toBe(false);
  });
});
