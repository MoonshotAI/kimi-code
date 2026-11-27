import { describe, expect, it } from 'vitest';

import { encodeWorkDirKey, type AbsoluteDir } from '#/_base/utils/workdir-slug';
import type { CheckoutLocation } from '#/app/git/workTree';
import { decideImplicitProject, type ImplicitResolutionPorts } from '#/app/project/implicitProject';
import type { Project } from '#/app/project/project';

function project(root: string, id: string = encodeWorkDirKey(root)): Project {
  return {
    id,
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
    checkoutRoot: '/checkout' as AbsoluteDir,
    mainDir: mainDir as AbsoluteDir,
    canonicalMainDir: canonicalMainDir as AbsoluteDir,
  };
}

interface PortOptions {
  readonly occupied?: readonly string[];
  readonly location?: CheckoutLocation;
  readonly homeDirs?: readonly string[];
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
    homeDirs: 'homeDirs' in options ? options.homeDirs : ['/home/me'],
  };
}

describe('decideImplicitProject', () => {
  describe('rule 1: a directory keeps its own project while that project holds sessions', () => {
    it('reuses an existing worktree project with sessions without locating the checkout', async () => {
      const worktree = project('/code/app-fix');
      const fixture = ports({ occupied: [worktree.id], location: grouped('/code/app') });

      const decision = await decideImplicitProject('/code/app-fix', [worktree], fixture);

      expect(decision).toEqual({ id: worktree.id, root: worktree.root, project: worktree });
      expect(fixture.located).toEqual([]);
    });

    it('matches the own project by id when its primary directory was moved', async () => {
      const moved = { ...project('/code/app'), root: '/code/app-renamed' };
      const decision = await decideImplicitProject(
        '/code/app',
        [moved],
        ports({ occupied: [moved.id] }),
      );

      expect(decision).toEqual({ id: moved.id, root: moved.root, project: moved });
    });

    it('matches the own project by Windows-shaped root across drive casing and separators', async () => {
      const own = project('C:\\Users\\Me\\app-fix');
      const decision = await decideImplicitProject(
        'c:/users/me/app-fix/',
        [own],
        ports({ occupied: [own.id], location: grouped('C:/Users/Me/app') }),
      );

      expect(decision).toEqual({ id: own.id, root: own.root, project: own });
    });
  });

  describe('rule 2: a directory inside a repository joins the project of its main checkout', () => {
    it('moves an empty worktree project over to the main checkout', async () => {
      const shell = project('/code/app-fix');
      const main = project('/code/app');
      const decision = await decideImplicitProject(
        '/code/app-fix',
        [shell, main],
        ports({ location: grouped('/code/app') }),
      );

      expect(decision).toEqual({ id: main.id, root: main.root, project: main });
    });

    it('creates the main checkout project when the repository has none yet', async () => {
      const decision = await decideImplicitProject(
        '/code/app-fix/src',
        [],
        ports({ location: grouped('/code/app') }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey('/code/app'), root: '/code/app' });
    });

    it('finds the main checkout project through a Windows-shaped root that differs by casing', async () => {
      const main = project('c:\\users\\me\\app');
      const decision = await decideImplicitProject(
        'C:/Users/Me/app-fix',
        [main],
        ports({ location: grouped('C:/Users/Me/app') }),
      );

      expect(decision).toEqual({ id: main.id, root: main.root, project: main });
    });

    it('finds the main checkout project registered at its canonical path from a symlinked spelling', async () => {
      const main = project('/private/tmp/code/app');
      const decision = await decideImplicitProject(
        '/tmp/code/app/src',
        [main],
        ports({ location: grouped('/tmp/code/app', '/private/tmp/code/app') }),
      );

      expect(decision).toEqual({ id: main.id, root: main.root, project: main });
    });

    it('matches the main checkout project by the primary directory it has now', async () => {
      const promoted = { ...project('/code/old'), root: '/code/app' };
      const decision = await decideImplicitProject(
        '/code/app-fix',
        [promoted],
        ports({ location: grouped('/code/app') }),
      );

      expect(decision).toEqual({ id: promoted.id, root: promoted.root, project: promoted });
    });

    it('keeps the literal main checkout path as the root of a new project', async () => {
      const decision = await decideImplicitProject(
        '/tmp/code/app/src',
        [project('/elsewhere')],
        ports({ location: grouped('/tmp/code/app', '/private/tmp/code/app') }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey('/tmp/code/app'), root: '/tmp/code/app' });
    });
  });

  describe('rule 3: everything else keeps a project of its own', () => {
    it('does not group under a repository at the home directory or above it', async () => {
      for (const mainDir of ['/home/me', '/home', '/']) {
        const decision = await decideImplicitProject(
          '/home/me/notes',
          [],
          ports({ location: grouped(mainDir) }),
        );
        expect(decision).toEqual({ id: encodeWorkDirKey('/home/me/notes'), root: '/home/me/notes' });
      }
    });

    it('compares the home directory through its realpath as well', async () => {
      const decision = await decideImplicitProject(
        '/Users/me/notes',
        [],
        ports({ location: grouped('/Users/me', '/private/Users/me'), homeDirs: ['/home-link', '/private/Users/me'] }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey('/Users/me/notes'), root: '/Users/me/notes' });
    });

    it('does not group when the home directory is unknown', async () => {
      const decision = await decideImplicitProject(
        '/code/app-fix',
        [],
        ports({ location: grouped('/code/app'), homeDirs: undefined }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey('/code/app-fix'), root: '/code/app-fix' });
    });

    it.each([
      ['a forged pointer', { kind: 'rejected', reason: 'backpointer-mismatch', checkoutRoot: '/code/evil' }],
      ['an unreadable .git file', { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot: '/code/evil' }],
      ['a separate-git-dir worktree', { kind: 'own', reason: 'main-unknown', checkoutRoot: '/code/evil' }],
    ] as const)('keeps %s on its own project', async (_label, location) => {
      const trusted = project('/code/app');
      const decision = await decideImplicitProject(
        '/code/evil',
        [trusted],
        ports({ location: location as CheckoutLocation }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey('/code/evil'), root: '/code/evil' });
    });

    it.each([
      ['a worktree', '/code/app-fix'],
      ['a subdirectory', '/code/app/src'],
    ])('keeps %s on its own project when the project of the main checkout moved its primary elsewhere', async (_label, dir) => {
      const moved = { ...project('/code/app'), root: '/code/other' };
      const decision = await decideImplicitProject(
        dir,
        [moved],
        ports({ occupied: [moved.id], location: grouped('/code/app') }),
      );

      expect(decision).toEqual({ id: encodeWorkDirKey(dir), root: dir });
    });

    it('keeps the main checkout itself on its project that moved its primary elsewhere', async () => {
      const moved = { ...project('/code/app'), root: '/code/other' };
      const decision = await decideImplicitProject(
        '/code/app',
        [moved],
        ports({ location: grouped('/code/app') }),
      );

      expect(decision).toEqual({ id: moved.id, root: moved.root, project: moved });
    });

    it('reuses the existing own project of a plain directory, as before', async () => {
      const own = project('/notes');
      const decision = await decideImplicitProject('/notes', [own], ports());

      expect(decision).toEqual({ id: own.id, root: own.root, project: own });
    });

    it('stores a new plain directory with forward slashes and keeps the id of the caller spelling', async () => {
      const decision = await decideImplicitProject('C:\\Users\\Me\\notes', [], ports());

      expect(decision).toEqual({ id: encodeWorkDirKey('C:\\Users\\Me\\notes'), root: 'C:/Users/Me/notes' });
    });

    it('stores a new plain POSIX directory without the trailing slash it was opened with', async () => {
      const decision = await decideImplicitProject('/home/me/notes/', [], ports());

      expect(decision).toEqual({ id: encodeWorkDirKey('/home/me/notes/'), root: '/home/me/notes' });
    });
  });
});
